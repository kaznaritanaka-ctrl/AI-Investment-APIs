import { build } from 'esbuild';
import { Miniflare, Log, LogLevel } from 'miniflare';
import { readFile, readdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
const html = await readFile('tests/fixtures/research/rebro.synthetic.html', 'utf8');
const bundle = await build({
  stdin: {
    contents: `import {dailyRuntime} from './tests/daily-runtime-harness';export default {async fetch(r,env){return Response.json(await dailyRuntime(env,${JSON.stringify(html)},Number(new URL(r.url).searchParams.get('step'))));}}`,
    resolveDir: process.cwd(),
    sourcefile: 'daily-runtime.ts',
    loader: 'ts',
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
});
const mf = new Miniflare({
  cf: false,
  modules: true,
  script: bundle.outputFiles[0].text,
  compatibilityDate: '2026-07-30',
  log: new Log(LogLevel.ERROR),
  d1Databases: ['PRIVATE_DB'],
  r2Buckets: ['EVIDENCE'],
  bindings: { ENVIRONMENT: 'test' },
});
try {
  const db = await mf.getD1Database('PRIVATE_DB');
  for (const file of (await readdir('migrations/private')).filter((f) => f.endsWith('.sql')).sort())
    await db.exec(
      (await readFile('migrations/private/' + file, 'utf8')).replace(/^--.*$/gm, '').trim(),
    );
  let result,
    calls = 0,
    maxBatch = 0;
  for (let step = 0; step < 80; step++) {
    const response = await mf.dispatchFetch('https://local.test/?step=' + step);
    assert.equal(response.status, 200);
    result = await response.json();
    calls += result.calls;
    maxBatch = Math.max(maxBatch, result.maxBatch);
  }
  assert.equal(calls, 120);
  assert.equal(result.runs, 40);
  assert.equal(result.observations, 80);
  assert.ok(result.head.pages.length >= 2);
  assert.ok(maxBatch <= 20);
  console.log(
    'Daily history workerd passed: 40 days / 40 runs / 80 synthetic observations, 120 mocked GETs, paginated catalog, 80 bounded invocations, immutable history survives 11-year maintenance; no live HTTP.',
  );
} finally {
  await mf.dispose();
}
