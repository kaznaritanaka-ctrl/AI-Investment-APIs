import { expect, it, vi } from 'vitest';
import api from '../src/api';
import { handle } from '../src/api';
import { localEnv } from '../scripts/local-env';

it('rejects unsupported methods, oversized URLs and throttled requests before any D1 query', async () => {
  const prepare = vi.fn(() => {
    throw new Error('unexpected_database_access');
  });
  const db = { prepare } as unknown as D1Database;
  const blocked = { PUBLIC_DB: db, RATE_LIMITER: { limit: async () => ({ success: false }) } };
  expect(
    (await api.fetch(new Request('https://api.test/v1/latest', { method: 'POST' }), blocked))
      .status,
  ).toBe(405);
  expect(
    (await api.fetch(new Request('https://api.test/v1/latest?source=' + 'x'.repeat(8192)), blocked))
      .status,
  ).toBe(400);
  for (const method of ['GET', 'HEAD']) {
    const response = await api.fetch(
      new Request('https://api.test/v1/latest', { method }),
      blocked,
    );
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('60');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    if (method === 'HEAD') expect(await response.text()).toBe('');
  }
  expect(prepare).not.toHaveBeenCalled();
});

it('keeps latest-query reads proportional to history while preserving latest selection and rights withdrawal', async () => {
  const { env, mf } = await localEnv();
  const now = '2026-10-05T12:00:00.000Z';
  try {
    const db = env.PUBLIC_DB;
    await db
      .prepare(
        "INSERT INTO source_publications VALUES('synthetic','v1',1,0,1,'2026-01-01T00:00:00.000Z',NULL,NULL,'{}')",
      )
      .run();
    await db
      .prepare(
        "INSERT INTO publication_batches VALUES('batch','synthetic','v1','complete','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')",
      )
      .run();
    await db
      .prepare(
        `WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM numbers WHERE n<1000)
      INSERT INTO published_observations(observation_id,batch_id,source_id,policy_version,dataset,entity_key,observed_at,recorded_at,public_json)
      SELECT 'synthetic-'||n,'batch','synthetic','v1','fx','entity-'||(n%10),
      '2026-10-04T18:17:00.000Z','2026-10-04T18:18:00.000Z',
      json_object('observation_id','synthetic-'||n,'dataset','fx','entity_key','entity-'||(n%10),'observed_at','2026-10-04T18:17:00.000Z','recorded_at','2026-10-04T18:18:00.000Z','source_date','2026-10-04') FROM numbers`,
      )
      .run();
    let reads = 0;
    const measured = {
      prepare(sql: string) {
        let stmt = db.prepare(sql);
        const proxy = {
          bind(...values: unknown[]) {
            stmt = stmt.bind(...values);
            return proxy;
          },
          async all() {
            const r = await stmt.all();
            expect(Number.isSafeInteger(r.meta.rows_read)).toBe(true);
            reads += r.meta.rows_read;
            return r;
          },
        };
        return proxy;
      },
    } as unknown as D1Database;
    const request = new Request('https://synthetic.test/v1/latest?dataset=fx');
    const response = await handle(request, { PUBLIC_DB: measured }, now);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { observation_id: string }[] };
    expect(body.data.map((row) => row.observation_id).sort()).toEqual(
      Array.from({ length: 10 }, (_, i) => 'synthetic-' + (991 + i)).sort(),
    );
    // A 1000-row history previously read over a million rows to return ten records.
    expect(reads).toBeGreaterThan(0);
    expect(reads).toBeLessThan(50000);
    await db.prepare("UPDATE source_publications SET revoked=1 WHERE source_id='synthetic'").run();
    expect((await handle(request, { PUBLIC_DB: db }, now)).status).toBe(404);
  } finally {
    await mf.dispose();
  }
});
