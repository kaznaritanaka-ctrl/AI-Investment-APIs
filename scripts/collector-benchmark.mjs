import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Miniflare, Log, LogLevel } from 'miniflare';
import assert from 'node:assert/strict';
const label = process.argv[2];
if (!['before', 'after'].includes(label)) throw new Error('use_before_or_after');
const temp = resolve(process.env.AI_APIS_TEMP_DIR ?? tmpdir(), 'collector-profile');
await mkdir(temp, { recursive: true });
process.env.TEMP = process.env.TMP = process.env.TMPDIR = temp;
await mkdir('work', { recursive: true });
await build({
  entryPoints: ['scripts/collector-profile.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  packages: 'external',
  outfile: 'work/collector-profile.mjs',
  logLevel: 'warning',
});
const probes = [];
for (const kind of ['A', 'B', 'C'])
  for (let trial = 1; trial <= 5; trial++) {
    const r = spawnSync(process.execPath, ['--expose-gc', 'work/collector-profile.mjs', kind], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (r.status !== 0) throw new Error(r.stderr || 'profile_failed');
    probes.push({ trial, ...JSON.parse(r.stdout) });
  }
const bundle = await build({
  entryPoints: ['tests/collector-benchmark-runtime.ts'],
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
const runtime = [];
try {
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
        (await readFile('migrations/' + name + '/' + file, 'utf8')).replace(/^--.*$/gm, '').trim(),
      );
  for (const kind of ['A', 'B', 'C']) {
    const steps = [];
    do {
      const r = await (await mf.dispatchFetch('https://synthetic.test/?case=' + kind)).json();
      assert(['complete', 'pending'].includes(r.result.state), JSON.stringify(r));
      assert(r.max_batch <= 20);
      steps.push(r);
      assert(steps.length < 50);
    } while (steps.at(-1).result.state !== 'complete');
    assert.equal(
      steps.reduce((n, r) => n + r.mock_http, 0),
      1,
    );
    const models = steps[0].models;
    const db = await mf.getD1Database('PUBLIC_DB');
    const published = await db
      .prepare(
        "SELECT COUNT(*) n FROM published_observations o JOIN publication_batches b USING(batch_id) WHERE o.source_id=? AND b.state='complete'",
      )
      .bind('synthetic_benchmark_' + kind)
      .first('n');
    assert.equal(published, kind === 'A' ? models : models * 2);
    runtime.push({ kind, trials: 1, input_models: models, published, steps });
    console.log(
      kind + ': ' + steps.length + ' synthetic workerd invocations, published ' + published,
    );
  }
} finally {
  await mf.dispose();
}
const report = {
  label,
  method: 'synthetic-only; 5 fresh Node processes per case, 1 fresh synthetic D1/R2 run per case',
  notes: [
    'Node process CPU is a host CPU proxy, not Cloudflare billed CPU.',
    'Probe timings are independent and overlapping; do not sum them.',
    'Full pipeline workerd elapsed includes D1/R2 waits; workerd CPU and isolate memory are unmeasured.',
    'Cold module startup CPU is unmeasured; configuration probe revalidates all 15 configured sources.',
    '8 MiB unselected padding is a stress fixture, not an upstream payload or proportional model-count extrapolation.',
  ],
  external_data_requests: 0,
  production_changed: false,
  probes,
  runtime,
};
await writeFile(
  'work/collector-benchmark-' + label + '.json',
  JSON.stringify(report, null, 2) + '\n',
);
console.log('Saved synthetic ' + label + ' profile; no source HTTP or production access.');
