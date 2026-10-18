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
    contents: `import {personalRuntime} from './tests/personal-runtime-harness';export default {async fetch(request,env){return Response.json(await personalRuntime(env,${JSON.stringify(html[0])},${JSON.stringify(html[1])}));}};`,
    resolveDir: process.cwd(),
    sourcefile: 'personal-runtime.ts',
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
  assert.deepEqual(result.counts, [4, 2]);
  assert.deepEqual(result.origins, ['review_required', 'review_required']);
  assert.equal(result.calls, 6);
  assert.deepEqual(result.remaining, { n: 0 });
  assert.equal(result.public_binding, false);
  console.log(
    'Personal exception workerd passed: 2 synthetic sources / 6 mocked GETs / 6 observations, immutable rights, reuse and expiry cleanup; no PUBLIC_DB or live HTTP.',
  );
} finally {
  await mf.dispose();
}
