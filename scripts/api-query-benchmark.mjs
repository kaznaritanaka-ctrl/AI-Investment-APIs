import { build } from 'esbuild';
import { Miniflare, Log, LogLevel } from 'miniflare';
import { readFile, readdir } from 'node:fs/promises';
import assert from 'node:assert/strict';

// Synthetic in-memory D1 only; no production requests or billing extrapolation.
const compiled = await build({
  stdin: {
    contents: `import {handle} from './src/api';
      export default {async fetch(request, env) {
        let rowsRead = 0, measured = true;
        const db = {prepare(sql) {
          let statement = env.PUBLIC_DB.prepare(sql);
          const proxy = {bind(...values) { statement = statement.bind(...values); return proxy; },
            async all() { const r = await statement.all();
              if (typeof r.meta?.rows_read !== 'number') measured = false;
              else rowsRead += r.meta.rows_read;
              return r;
            }, async first(column) {const r = await proxy.all(); return column ? r.results[0]?.[column] ?? null : r.results[0] ?? null;}};
          return proxy;
        }};
        const response = await handle(request, {PUBLIC_DB:db}, '2026-10-05T12:00:00.000Z');
        return Response.json({status:response.status, rows_read:measured ? rowsRead : null, body:await response.json()});
      }};`,
    resolveDir: process.cwd(),
    sourcefile: 'synthetic-api-cost.ts',
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
  script: compiled.outputFiles[0].text,
  compatibilityDate: '2026-07-30',
  log: new Log(LogLevel.ERROR),
  d1Databases: ['PUBLIC_DB'],
});
const results = [];
try {
  const db = await mf.getD1Database('PUBLIC_DB');
  for (const file of (await readdir('migrations/public')).filter((f) => f.endsWith('.sql')).sort())
    await db.exec(
      (await readFile('migrations/public/' + file, 'utf8')).replace(/^--.*$/gm, '').trim(),
    );
  await db
    .prepare(
      "INSERT INTO source_publications VALUES('synthetic','v1',1,0,1,'2026-01-01T00:00:00.000Z',NULL,NULL,'{}')",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO publication_batches VALUES('synthetic-batch','synthetic','v1','complete','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')",
    )
    .run();
  let previous = 0;
  for (const count of [100, 1000, 10000]) {
    await db
      .prepare(
        `WITH RECURSIVE numbers(n) AS (SELECT ? UNION ALL SELECT n+1 FROM numbers WHERE n<?)
      INSERT INTO published_observations(observation_id,batch_id,source_id,policy_version,dataset,entity_key,observed_at,recorded_at,public_json)
      SELECT 'synthetic-'||n,'synthetic-batch','synthetic','v1','fx','entity-'||(n%10),
      '2026-10-04T18:17:00.000Z','2026-10-04T18:18:00.000Z',
      json_object('dataset','fx','observed_at','2026-10-04T18:17:00.000Z','recorded_at','2026-10-04T18:18:00.000Z','source_date','2026-10-04') FROM numbers`,
      )
      .bind(previous + 1, count)
      .run();
    previous = count;
    for (const path of [
      '/health',
      '/v1/latest?dataset=fx',
      '/v1/latest?dataset=fx&entity=entity-0',
      '/v1/observations?dataset=fx&limit=100',
    ]) {
      const started = performance.now();
      const response = await mf.dispatchFetch('https://synthetic.test' + path);
      const r = await response.json();
      assert.equal(r.status, 200);
      results.push({
        synthetic_rows: count,
        path,
        local_rows_read: r.rows_read,
        returned_rows: r.body.data?.length ?? null,
        local_elapsed_ms: Math.round(performance.now() - started),
      });
    }
  }
  console.log(
    JSON.stringify(
      {
        mode: 'synthetic_local',
        production_load_performed: false,
        billing_estimate: false,
        results,
      },
      null,
      2,
    ),
  );
} finally {
  await mf.dispose();
}
