import { build } from 'esbuild';
import { Miniflare, Log, LogLevel } from 'miniflare';
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
// Executes the actual pipeline and API inside workerd. No external HTTP.
const xml = await readFile('tests/fixtures/ecb.synthetic.xml', 'utf8');
const catalog = await readFile('tests/fixtures/models.synthetic.json', 'utf8');
const source =
  "\nimport {sources} from './src/sources';\nimport legacyModels from './config/history/models_dev.v2.json';\nimport {gpuRuntime} from './tests/gpu-runtime-harness';\nimport {collectAll} from './src/pipeline';\nimport {handle} from './src/api';\nexport default {\n async fetch(request,env){\n  if(new URL(request.url).pathname!=='/')return gpuRuntime(request,env);\n  const now='2026-10-03T18:17:00.000Z';\n  const selected=structuredClone(sources.filter(s=>['ecb','models_dev','openrouter'].includes(s.source_id)).map(s=>s.source_id==='models_dev'?legacyModels:s));\n  const model=selected.find(s=>s.source_id==='models_dev');model.selection=['lab/model-a'];model.max_records=4;\n  let calls=0;\n  const fetcher=async url=>{calls++;return String(url).includes('ecb.europa')?new Response(XML_BODY,{headers:{'content-type':'application/xml'}}):new Response(CATALOG_BODY,{headers:{'content-type':'application/json'}});};\n  const results=await collectAll(env,selected,now,{synthetic:true,now:()=>now,network:{fetcher}});\n  const response=await handle(new Request('https://local.test/v1/latest'),{PUBLIC_DB:env.PUBLIC_DB},now);\n  return Response.json({results,calls,status:response.status,body:await response.json()});\n }\n}";
const bundled = await build({
  stdin: {
    contents: source
      .replace(
        'export default {',
        "import {modelsRuntime} from './tests/models-runtime-harness';\nexport default {",
      )
      .replace(
        "if(new URL(request.url).pathname!=='/')",
        "if(new URL(request.url).pathname.startsWith('/models-'))return modelsRuntime(request,env);\nif(new URL(request.url).pathname!=='/')",
      )
      .replace('XML_BODY', JSON.stringify(xml))
      .replace('CATALOG_BODY', JSON.stringify(catalog))
      .replace(
        'export default {',
        "import {operationsRuntime} from './tests/operations-runtime-harness';\nexport default {",
      )
      .replace(
        'async fetch(request,env){',
        "async fetch(request,env){\nif(new URL(request.url).pathname==='/operations')return operationsRuntime(env);",
      )
      .replace(
        'export default {',
        "import {recoveryRuntime} from './tests/recovery-runtime-harness';\nexport default {",
      )
      .replace(
        'async fetch(request,env){',
        "async fetch(request,env){\nif(new URL(request.url).pathname==='/schema-recovery')return recoveryRuntime(env);",
      ),
    resolveDir: process.cwd(),
    sourcefile: 'runtime-harness.ts',
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  write: false,
});
const mf = new Miniflare({
  cf: false,
  modules: true,
  script: bundled.outputFiles[0].text,
  compatibilityDate: '2026-07-30',
  log: new Log(LogLevel.ERROR),
  d1Databases: ['PRIVATE_DB', 'PUBLIC_DB'],
  r2Buckets: ['EVIDENCE'],
  bindings: { ENVIRONMENT: 'test', AGENT_ENABLED: 'false' },
});
try {
  for (const [binding, name] of [
    ['PRIVATE_DB', 'private'],
    ['PUBLIC_DB', 'public'],
  ]) {
    for (const file of (await readdir('migrations/' + name))
      .filter((f) => f.endsWith('.sql'))
      .sort())
      await (
        await mf.getD1Database(binding)
      ).exec(
        (await readFile('migrations/' + name + '/' + file, 'utf8')).replace(/^--.*$/gm, '').trim(),
      );
  }
  const response = await mf.dispatchFetch('https://local.test/');
  const result = await response.json();
  assert.deepEqual(
    result.results.map((r) => r.state),
    ['complete', 'complete', 'policy_skipped'],
  );
  assert.equal(result.calls, 2);
  assert.equal(result.status, 200);
  assert.equal(result.body.data.length, 4);
  assert(result.body.data.every((o) => o.data_origin === 'synthetic'));
  console.log(
    'Workerd runtime smoke passed: 2 synthetic sources, 1 blocked source, D1/R2 pipeline and public API. No external HTTP.',
  );
  const operations = await (await mf.dispatchFetch('https://local.test/operations')).json();
  assert.equal(operations.collection, 'complete');
  assert.equal(operations.publication, 'complete');
  assert.equal(operations.dry.eligible, 1);
  assert.equal(operations.dryCalls, 0);
  assert.equal(operations.failed.state, 'pending');
  assert.equal(operations.recovered.sent, 1);
  assert.equal(operations.calls, 2);
  const recovery = await (await mf.dispatchFetch('https://local.test/schema-recovery')).json();
  assert.equal(recovery.reason, 'schema_drift_detected');
  assert.equal(recovery.state, 'failed');
  assert.equal(recovery.calls, 1);
  assert.equal(recovery.observations, 0);
  assert.equal(recovery.publicRows, 0);
  assert.equal(recovery.evidence_preserved, true);
  assert.equal(recovery.reparse, 'passed');
  assert.equal(recovery.records, 5);
  assert(recovery.payload_bytes > 8 * 1024 * 1024);
  assert(recovery.retained_bytes < 10000);
  assert.equal(recovery.gate.production_deploy_allowed, false);
  console.log(
    'Workerd schema drift: authorized evidence preserved, publication held, saved response reparsed offline. Synthetic only.',
  );
  await mkdir('work', { recursive: true });
  await writeFile(
    'work/runtime-recovery-report.json',
    JSON.stringify(
      { ...recovery, synthetic: true, cloud_cpu_measured: false, external_http_requests: 0 },
      null,
      2,
    ) + '\n',
  );
  console.log(
    'Workerd operational check, notification dry-run, failure and recovery passed. Synthetic delivery only.',
  );
  let steps = 0,
    maxBatch = 0,
    resultGPU;
  const profiles = [];
  do {
    const r = await mf.dispatchFetch('https://local.test/gpu-step');
    const step = await r.json();
    resultGPU = step.result;
    profiles.push(step);
    assert(step.sql_statements < 1000, JSON.stringify(step));
    maxBatch = Math.max(maxBatch, step.max_batch);
    assert(['pending', 'complete'].includes(resultGPU.state), JSON.stringify(step));
    steps++;
    assert(steps < 100);
  } while (resultGPU.state !== 'complete');
  assert.equal(resultGPU.observations, 1051);
  assert(steps > 20);
  assert(maxBatch <= 20);
  const again = await (await mf.dispatchFetch('https://local.test/gpu-step')).json();
  assert.equal(again.result.reason, 'already_processed');
  const verified = await (await mf.dispatchFetch('https://local.test/gpu-verify')).json();
  assert.equal(verified.pages, 22);
  assert.equal(verified.observations, 1051);
  assert.equal(verified.metrics.data[0].median, '625');
  let cursor = null;
  const ids = new Set();
  do {
    const page = await (
      await mf.dispatchFetch(
        'https://local.test/v1/observations?dataset=gpu_secondary&limit=100' +
          (cursor ? '&cursor=' + cursor : ''),
      )
    ).json();
    assert(!page.error, JSON.stringify(page));
    for (const o of page.data) {
      ids.add(o.observation_id);
      assert.equal(o.data_origin, 'synthetic');
    }
    cursor = page.next_cursor;
  } while (cursor);
  assert.equal(ids.size, 1051);
  await mkdir('work', { recursive: true });
  await writeFile(
    'work/runtime-phase2-report.json',
    JSON.stringify(
      {
        test_kind: 'synthetic_workerd_scale',
        finished_at: new Date().toISOString(),
        observations: 1051,
        pages: 22,
        invocations: steps,
        max_batch: maxBatch,
        max_sql_statements_per_invocation: Math.max(...profiles.map((p) => p.sql_statements)),
        max_d1_calls_per_invocation: Math.max(...profiles.map((p) => p.d1_calls)),
        total_r2_operations: profiles.reduce((n, p) => n + p.r2_operations, 0),
        mock_http_requests: profiles.reduce((n, p) => n + p.external_mock_requests, 0),
        max_response_bytes: Math.max(...profiles.map((p) => p.max_mock_response_bytes)),
        rows_read_with_metadata: profiles.reduce((n, p) => n + p.rows_read_with_metadata, 0),
        rows_written_with_metadata: profiles.reduce((n, p) => n + p.rows_written_with_metadata, 0),
        d1_metadata_incomplete: profiles.some((p) => p.metadata_incomplete),
        local_workerd_elapsed_ms: profiles.reduce((n, p) => n + p.local_workerd_elapsed_ms, 0),
        cloud_workers_cpu_measured: false,
        production_deployed: false,
        external_data_requests: 0,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    'GPU workerd scale passed: 1051 synthetic listings, 22 pages, ' +
      steps +
      ' bounded invocations, max batch ' +
      maxBatch +
      ', replay and public pagination verified. No external HTTP.',
  );
  const modelProfiles = [];
  const largeCatalog = await (
    await mf.dispatchFetch('https://local.test/models-large?n=1000')
  ).json();
  assert.equal(largeCatalog.model_count, 1000);
  assert.equal(largeCatalog.complete, true);
  assert.equal(largeCatalog.exact_decimal, '1.234567890123456789');
  assert(largeCatalog.payload_bytes > 8 * 1024 * 1024);
  for (const n of [50, 250, 1000]) {
    const beforeSize = await (
      await mf.dispatchFetch('https://local.test/models-size?n=' + n)
    ).json();
    const profiles = [];
    let result;
    do {
      const step = await (await mf.dispatchFetch('https://local.test/models-step?n=' + n)).json();
      assert(['pending', 'complete'].includes(step.result.state), JSON.stringify(step));
      assert(step.max_batch <= 20, JSON.stringify(step));
      assert(step.sql_statements < 1000, JSON.stringify(step));
      profiles.push(step);
      result = step.result;
      assert(profiles.length < 100);
    } while (result.state !== 'complete');
    const replay = await (await mf.dispatchFetch('https://local.test/models-step?n=' + n)).json();
    assert.equal(replay.result.reason, 'already_processed');
    assert.equal(replay.http_requests, 0);
    const verified = await (
      await mf.dispatchFetch('https://local.test/models-verify?n=' + n)
    ).json();
    assert.equal(verified.snapshot.model_count, n);
    assert.equal(verified.snapshot.price_count, n);
    assert.equal(verified.snapshot.component_count, n * 3);
    assert.equal(verified.snapshot.quarantined_count, 0);
    assert.equal(verified.event_status, 200);
    assert.deepEqual(verified.foreign_key_violations, []);
    let cursor = null;
    const ids = new Set();
    do {
      const page = await (
        await mf.dispatchFetch(
          'https://local.test/v1/observations?dataset=ai_model_catalog&source=synthetic_models_' +
            n +
            '&limit=100' +
            (cursor ? '&cursor=' + cursor : ''),
        )
      ).json();
      assert(!page.error, JSON.stringify(page));
      for (const o of page.data) {
        ids.add(o.observation_id);
        assert.equal(o.data_origin, 'synthetic');
      }
      cursor = page.next_cursor;
    } while (cursor);
    assert.equal(ids.size, n);
    assert.equal(
      profiles.reduce((sum, p) => sum + p.http_requests, 0),
      1,
    );
    modelProfiles.push({
      models: n,
      invocations: profiles.length,
      max_sql_per_invocation: Math.max(...profiles.map((p) => p.sql_statements)),
      max_batch: Math.max(...profiles.map((p) => p.max_batch)),
      sql_statements: profiles.reduce((sum, p) => sum + p.sql_statements, 0),
      d1_calls: profiles.reduce((sum, p) => sum + p.d1_calls, 0),
      rows_read_with_metadata: profiles.reduce((sum, p) => sum + p.rows_read, 0),
      rows_written_with_metadata: profiles.reduce((sum, p) => sum + p.rows_written, 0),
      metadata_incomplete: profiles.some((p) => p.metadata_incomplete),
      r2_get: profiles.reduce((sum, p) => sum + p.r2_get, 0),
      r2_put: profiles.reduce((sum, p) => sum + p.r2_put, 0),
      local_workerd_elapsed_ms: profiles.reduce((sum, p) => sum + p.local_workerd_elapsed_ms, 0),
      payload_bytes: profiles[0].payload_bytes,
      ...JSON.parse(verified.snapshot.metrics_json),
      mock_http_requests: 1,
      public_catalog_count: ids.size,
      public_price_count: n,
      database_growth_bytes: await (async () => {
        const afterSize = await (
          await mf.dispatchFetch('https://local.test/models-size?n=' + n)
        ).json();
        return {
          private: afterSize.private_bytes - beforeSize.private_bytes,
          public: afterSize.public_bytes - beforeSize.public_bytes,
          includes_indexes: true,
        };
      })(),
    });
    console.log(
      'Models workerd passed: ' +
        n +
        ' synthetic models, ' +
        profiles.length +
        ' resumable invocations, complete public history and replay verified.',
    );
  }
  await writeFile(
    'work/runtime-models-report.json',
    JSON.stringify(
      {
        test_kind: 'synthetic_workerd_scale',
        external_data_requests: 0,
        production_deployed: false,
        cloud_cpu_measured: false,
        measurements: modelProfiles,
        large_catalog_intake: largeCatalog,
      },
      null,
      2,
    ) + '\n',
  );
} finally {
  await mf.dispose();
}
