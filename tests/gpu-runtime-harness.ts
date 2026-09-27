import { gpuSource, item, ebayFetcher } from './gpu-helpers';
import { collectSource } from '../src/pipeline';
import { handle } from '../src/api';
import type { CollectorEnv } from '../src/schema';
const time = '2026-10-03T18:17:00.000Z';
export async function gpuRuntime(request: Request, env: CollectorEnv) {
  const s = gpuSource(),
    rows = Array.from({ length: 1051 }, (_, i) => item(i, String(100 + i)));
  if (new URL(request.url).pathname === '/gpu-step') {
    let maxBatch = 0;
    const stats = {
      sql_statements: 0,
      d1_calls: 0,
      rows_read_with_metadata: 0,
      rows_written_with_metadata: 0,
      metadata_incomplete: false,
      r2_operations: 0,
      external_mock_requests: 0,
      max_mock_response_bytes: 0,
    };
    const track = (result: any) => {
      if (result?.meta) {
        stats.rows_read_with_metadata += result.meta.rows_read ?? 0;
        stats.rows_written_with_metadata += result.meta.rows_written ?? 0;
      } else stats.metadata_incomplete = true;
    };
    const database = (native: D1Database) => {
      const original = new WeakMap<object, D1PreparedStatement>();
      const wrap = (stmt: D1PreparedStatement): D1PreparedStatement => {
        const proxy = new Proxy(stmt, {
          get(target, key) {
            if (key === 'bind') return (...args: unknown[]) => wrap(target.bind(...args));
            if (['run', 'all', 'first', 'raw'].includes(String(key)))
              return async (...args: unknown[]) => {
                stats.sql_statements++;
                stats.d1_calls++;
                const r = await (target as any)[key](...args);
                track(r);
                return r;
              };
            const value = (target as any)[key];
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
        original.set(proxy, stmt);
        return proxy;
      };
      return {
        prepare: (sql: string) => wrap(native.prepare(sql)),
        batch: async (stmts: D1PreparedStatement[]) => {
          maxBatch = Math.max(maxBatch, stmts.length);
          stats.sql_statements += stmts.length;
          stats.d1_calls++;
          const r = await native.batch(stmts.map((st) => original.get(st) ?? st));
          r.forEach(track);
          return r;
        },
      } as D1Database;
    };
    const evidence = new Proxy(env.EVIDENCE, {
      get(target, key) {
        const value = (target as any)[key];
        return typeof value === 'function'
          ? (...args: unknown[]) => {
              stats.r2_operations++;
              return value.apply(target, args);
            }
          : value;
      },
    });
    const base = ebayFetcher(s, rows),
      fetcher = (async (...args: Parameters<typeof fetch>) => {
        stats.external_mock_requests++;
        const response = await base(...args);
        stats.max_mock_response_bytes = Math.max(
          stats.max_mock_response_bytes,
          new TextEncoder().encode(await response.clone().text()).length,
        );
        return response;
      }) as typeof fetch;
    const started = performance.now();
    const result = await collectSource(
      {
        ...env,
        PRIVATE_DB: database(env.PRIVATE_DB),
        PUBLIC_DB: database(env.PUBLIC_DB),
        EVIDENCE: evidence,
        EBAY_CLIENT_ID: 'synthetic',
        EBAY_CLIENT_SECRET: 'synthetic',
      },
      s,
      time,
      { synthetic: true, now: () => time, network: { fetcher, sleep: async () => {} } },
    );
    return Response.json({
      result,
      max_batch: maxBatch,
      ...stats,
      local_workerd_elapsed_ms: Math.round(performance.now() - started),
    });
  }
  if (new URL(request.url).pathname === '/gpu-verify') {
    const pages = await env.PRIVATE_DB.prepare('SELECT COUNT(*) AS n FROM gpu_pages').first('n');
    const observations = await env.PRIVATE_DB.prepare(
      "SELECT COUNT(*) AS n FROM observations WHERE dataset='gpu_secondary'",
    ).first('n');
    const metrics = await handle(
      new Request('https://local.test/v1/gpu/metrics'),
      { PUBLIC_DB: env.PUBLIC_DB },
      time,
    );
    return Response.json({ pages, observations, metrics: await metrics.json() });
  }
  return handle(request, { PUBLIC_DB: env.PUBLIC_DB }, time);
}
