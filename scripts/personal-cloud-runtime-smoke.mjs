import { build } from 'esbuild';
import { Miniflare, Log, LogLevel } from 'miniflare';
import { readFile, readdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
const html = await Promise.all(
  ['highreso', 'rebro'].map((name) =>
    readFile('tests/fixtures/research/' + name + '.synthetic.html', 'utf8'),
  ),
);
const bundled = await build({
  stdin: {
    contents: `import {cloudRuntime} from './tests/personal-cloud-runtime-harness';export default {async fetch(request,env){return Response.json(await cloudRuntime(env,${JSON.stringify(html)}));}};`,
    resolveDir: process.cwd(),
    sourcefile: 'personal-cloud-runtime.ts',
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
  d1Databases: ['PRIVATE_DB'],
  r2Buckets: ['EVIDENCE'],
  bindings: { ENVIRONMENT: 'test', PERSONAL_STORE_ID: 'synthetic-store' },
});
try {
  const db = await mf.getD1Database('PRIVATE_DB');
  for (const file of (await readdir('migrations/private')).filter((f) => f.endsWith('.sql')).sort())
    await db.exec(
      (await readFile('migrations/private/' + file, 'utf8')).replace(/^--.*$/gm, '').trim(),
    );
  const result = await (await mf.dispatchFetch('https://local.test/')).json();
  assert.deepEqual(result.results, [
    { state: 'complete', complete: true, parts: 1, public_binding: false },
    { state: 'complete', complete: true, parts: 1, public_binding: false },
  ]);
  assert.equal(result.calls, 6);
  assert.deepEqual(result.remaining, { n: 6 });
  assert.deepEqual(result.disabled, []);
  console.log(
    'Cloud personal workerd passed: two synthetic sources, six mocked GETs, private complete exports and bounded generation cleanup; history preserved, no public binding or live HTTP.',
  );
} finally {
  await mf.dispose();
}
