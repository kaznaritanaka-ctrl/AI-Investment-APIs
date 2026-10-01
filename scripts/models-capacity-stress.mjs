import { build } from 'esbuild';
import { Miniflare, Log, LogLevel } from 'miniflare';
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
const temp = join(tmpdir(), 'ai-p0-stress');
await mkdir(temp, { recursive: true });
process.env.TEMP = process.env.TMP = process.env.TMPDIR = temp;
// Extend the existing synthetic harness in memory; production modules are unchanged.
let harness = await readFile('tests/models-runtime-harness.ts', 'utf8');
function replaceOnce(from, to) {
  assert.equal(harness.split(from).length, 2, 'harness anchor mismatch');
  harness = harness.replace(from, to);
}
replaceOnce('if (![50, 250, 1000].includes(n))', 'if (![50, 250, 500, 1000].includes(n))');
replaceOnce(
  'const s = expandedSource();',
  `const s = expandedSource();
  const day=Number(url.searchParams.get('day')??0);
  const time=new Date(Date.parse('2026-10-03T18:17:00.000Z')+day*86400000).toISOString();
  if(!Number.isInteger(day)||day<0||day>6)throw new Error('synthetic_day_invalid');
  s.models!.max_models=500;`,
);
replaceOnce('JSON.stringify(catalog(n)),', 'JSON.stringify(catalogWide(n)),');
replaceOnce('const input = catalog(n);', 'const input = catalogWide(n);');
replaceOnce("'x'.repeat(8 * 1024 * 1024)", "'x'.repeat(14 * 1024 * 1024)");
harness += `
function catalogWide(n:number){
 const root=catalog(n);
 const prices={input:1,output:4,cache_read:0.25,cache_write:0.5,reasoning:2,input_audio:3,output_audio:5};
 for(const provider of Object.values(root))for(const model of Object.values(provider.models) as any[]){
   const {output_audio,...base}=prices;
   model.cost={...base,tiers:Array.from({length:8},(_,i)=>({...prices,tier:{type:'context',size:32000*(i+1)}}))};
   model.experimental={modes:{standard:{cost:{input:1,output:4}}}};
 }
 return root;
}
export default {fetch:modelsRuntime};
`;
const bundle = await build({
  stdin: {
    contents: harness,
    resolveDir: resolve('tests'),
    sourcefile: 'capacity-stress-runtime.ts',
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  write: false,
  logLevel: 'warning',
});
const mf = new Miniflare({
  cf: false,
  modules: true,
  script: bundle.outputFiles[0].text,
  compatibilityDate: '2026-07-30',
  log: new Log(LogLevel.ERROR),
  d1Databases: ['PRIVATE_DB', 'PUBLIC_DB'],
  r2Buckets: ['EVIDENCE'],
  bindings: { ENVIRONMENT: 'test', AGENT_ENABLED: 'false' },
});
try {
  if (process.argv.includes('--intake-only')) {
    const started = performance.now();
    const result = await (await mf.dispatchFetch('https://local.test/models-large?n=500')).json();
    assert.equal(result.model_count, 500);
    assert.equal(result.complete, true);
    assert(result.payload_bytes < 16000000);
    assert(result.payload_bytes > 14 * 1024 * 1024);
    const report = {
      test_kind: 'synthetic_local_workerd_large_intake',
      models: 500,
      components_per_model: 64,
      ...result,
      local_elapsed_ms: performance.now() - started,
      cloud_cpu_measured: false,
      cloud_memory_measured: false,
      production_changed: false,
    };
    await writeFile('work/capacity-intake-summary.json', JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report));
  } else {
    for (const [binding, name] of [
      ['PRIVATE_DB', 'private'],
      ['PUBLIC_DB', 'public'],
    ])
      for (const file of (await readdir('migrations/' + name))
        .filter((f) => f.endsWith('.sql'))
        .sort())
        await (
          await mf.getD1Database(binding)
        ).exec(
          (await readFile('migrations/' + name + '/' + file, 'utf8'))
            .replace(/^--.*$/gm, '')
            .trim(),
        );
    const profiles = [];
    let before = await (await mf.dispatchFetch('https://local.test/models-size?n=500')).json();
    const baseline = before;
    // Three consecutive synthetic days distinguish baseline events from stable daily history.
    for (let day = 0; day < 3; day++) {
      const steps = [];
      do {
        const step = await (
          await mf.dispatchFetch('https://local.test/models-step?n=500&day=' + day)
        ).json();
        assert(['pending', 'complete'].includes(step.result.state), JSON.stringify({ day, step }));
        assert(step.max_batch <= 20);
        assert(step.d1_calls < 1000);
        assert(step.sql_statements < 1000);
        steps.push(step);
        assert(steps.length < 60);
      } while (steps.at(-1).result.state !== 'complete');
      assert.equal(
        steps.reduce((n, p) => n + p.http_requests, 0),
        1,
      );
      const after = await (await mf.dispatchFetch('https://local.test/models-size?n=500')).json();
      profiles.push({
        synthetic_day: day,
        models: 500,
        components_per_model: 64,
        invocations: steps.length,
        max_d1_calls: Math.max(...steps.map((p) => p.d1_calls)),
        max_sql_statements: Math.max(...steps.map((p) => p.sql_statements)),
        rows_read: steps.reduce((n, p) => n + p.rows_read, 0),
        rows_written: steps.reduce((n, p) => n + p.rows_written, 0),
        r2_get: steps.reduce((n, p) => n + p.r2_get, 0),
        r2_put: steps.reduce((n, p) => n + p.r2_put, 0),
        growth_bytes: {
          private: after.private_bytes - before.private_bytes,
          public: after.public_bytes - before.public_bytes,
        },
        local_elapsed_ms: steps.reduce((n, p) => n + p.local_workerd_elapsed_ms, 0),
      });
      before = after;
      console.log(JSON.stringify(profiles.at(-1)));
    }
    const db = await mf.getD1Database('PRIVATE_DB'),
      pub = await mf.getD1Database('PUBLIC_DB');
    const snaps = (
      await db
        .prepare(
          'SELECT state,model_count,price_count,component_count,quarantined_count,data_origin FROM model_snapshots ORDER BY observed_at',
        )
        .all()
    ).results;
    assert.equal(snaps.length, 3);
    for (const s of snaps) {
      assert.equal(s.model_count, 500);
      assert.equal(s.price_count, 500);
      assert.equal(s.component_count, 32000);
      assert.equal(s.quarantined_count, 0);
      assert.equal(s.data_origin, 'synthetic');
    }
    const foreignKeys = (await db.prepare('PRAGMA foreign_key_check').all()).results;
    assert.deepEqual(foreignKeys, []);
    const publicRows = await pub
      .prepare('SELECT COUNT(*) n FROM published_observations')
      .first('n');
    assert.equal(publicRows, 3000);
    const high = {
      private: Math.max(...profiles.map((p) => p.growth_bytes.private)),
      public: Math.max(...profiles.map((p) => p.growth_bytes.public)),
    };
    const report = {
      test_kind: 'synthetic_local_workerd_capacity_stress',
      recorded_at: new Date().toISOString(),
      models: 500,
      components_per_model: 64,
      days: 3,
      external_requests: 0,
      production_changed: false,
      cloud_cpu_measured: false,
      cloud_memory_measured: false,
      baseline_bytes: baseline,
      profiles,
      snapshots: snaps,
      foreign_key_violations: foreignKeys.length,
      public_rows: publicRows,
      forecast_1095_days_GB: {
        private: (baseline.private_bytes + 1095 * high.private) / 1e9,
        public: (baseline.public_bytes + 1095 * high.public) / 1e9,
      },
      forecast_method:
        'Largest measured daily SQLite growth including indexes x 1095; no claim of full three-year runtime validation; stable prices and metadata, one lifecycle event per model/day',
    };
    await writeFile('work/capacity-stress-summary.json', JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ forecast: report.forecast_1095_days_GB, verified: true }));
  }
} finally {
  await mf.dispose();
}
