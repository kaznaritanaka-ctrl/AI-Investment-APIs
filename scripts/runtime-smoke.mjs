import { build } from 'esbuild';
import { Miniflare, Log, LogLevel } from 'miniflare';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
// Executes the actual pipeline and API inside workerd. No external HTTP.
const xml = await readFile('tests/fixtures/ecb.synthetic.xml', 'utf8');
const catalog = await readFile('tests/fixtures/models.synthetic.json', 'utf8');
const source =
  "\nimport {sources} from './src/sources';\nimport {collectAll} from './src/pipeline';\nimport {handle} from './src/api';\nexport default {\n async fetch(request,env){\n  const now='2026-10-03T18:17:00.000Z';\n  const selected=structuredClone(sources.filter(s=>['ecb','models_dev','openrouter'].includes(s.source_id)));\n  const model=selected.find(s=>s.source_id==='models_dev');model.selection=['lab/model-a'];model.max_records=4;\n  let calls=0;\n  const fetcher=async url=>{calls++;return String(url).includes('ecb.europa')?new Response(XML_BODY,{headers:{'content-type':'application/xml'}}):new Response(CATALOG_BODY,{headers:{'content-type':'application/json'}});};\n  const results=await collectAll(env,selected,now,{synthetic:true,now:()=>now,network:{fetcher}});\n  const response=await handle(new Request('https://local.test/v1/latest'),{PUBLIC_DB:env.PUBLIC_DB},now);\n  return Response.json({results,calls,status:response.status,body:await response.json()});\n }\n}";
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
  ])
    await (
      await mf.getD1Database(binding)
    ).exec(await readFile('migrations/' + name + '/0001_initial.sql', 'utf8'));
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
} finally {
  await mf.dispose();
}
