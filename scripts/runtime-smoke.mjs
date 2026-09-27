import { build } from 'esbuild';
import { Miniflare, Log, LogLevel } from 'miniflare';
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
// Executes the actual pipeline and API inside workerd. No external HTTP.
const xml = await readFile('tests/fixtures/ecb.synthetic.xml', 'utf8');
const catalog = await readFile('tests/fixtures/models.synthetic.json', 'utf8');
const source =
  "\nimport {sources} from './src/sources';\nimport {gpuRuntime} from './tests/gpu-runtime-harness';\nimport {collectAll} from './src/pipeline';\nimport {handle} from './src/api';\nexport default {\n async fetch(request,env){\n  if(new URL(request.url).pathname!=='/')return gpuRuntime(request,env);\n  const now='2026-10-03T18:17:00.000Z';\n  const selected=structuredClone(sources.filter(s=>['ecb','models_dev','openrouter'].includes(s.source_id)));\n  const model=selected.find(s=>s.source_id==='models_dev');model.selection=['lab/model-a'];model.max_records=4;\n  let calls=0;\n  const fetcher=async url=>{calls++;return String(url).includes('ecb.europa')?new Response(XML_BODY,{headers:{'content-type':'application/xml'}}):new Response(CATALOG_BODY,{headers:{'content-type':'application/json'}});};\n  const results=await collectAll(env,selected,now,{synthetic:true,now:()=>now,network:{fetcher}});\n  const response=await handle(new Request('https://local.test/v1/latest'),{PUBLIC_DB:env.PUBLIC_DB},now);\n  return Response.json({results,calls,status:response.status,body:await response.json()});\n }\n}";
const bundled = await build({
  stdin: {
    contents: source
      .replace('XML_BODY', JSON.stringify(xml))
      .replace('CATALOG_BODY', JSON.stringify(catalog)),
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
} finally {
  await mf.dispose();
}
