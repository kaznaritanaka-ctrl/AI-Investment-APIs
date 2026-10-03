import type { CollectorEnv } from '../src/schema';
import { collectSource } from '../src/pipeline';
import {
  benchmarkInput,
  benchmarkTime,
  type BenchmarkCase,
} from '../scripts/collector-benchmark-data';
export default {
  async fetch(request: Request, env: CollectorEnv) {
    const kind = new URL(request.url).searchParams.get('case') as BenchmarkCase;
    if (!['A', 'B', 'C'].includes(kind)) throw new Error('invalid_case');
    const { source, text, models } = benchmarkInput(kind);
    const stats = {
      sql_statements: 0,
      d1_calls: 0,
      max_batch: 0,
      private_statements: 0,
      public_statements: 0,
      rows_read: 0,
      rows_written: 0,
      r2_get: 0,
      r2_put: 0,
      r2_head: 0,
      mock_http: 0,
    };
    const database = (db: D1Database, which: 'private_statements' | 'public_statements') => {
      const originals = new WeakMap<object, D1PreparedStatement>();
      const track = (result: D1Result) => {
        stats.rows_read += result.meta.rows_read ?? 0;
        stats.rows_written += result.meta.rows_written ?? 0;
      };
      const wrap = (stmt: D1PreparedStatement): D1PreparedStatement => {
        const proxy = new Proxy(stmt, {
          get(target, key) {
            if (key === 'bind') return (...args: unknown[]) => wrap(target.bind(...args));
            if (['all', 'run', 'first', 'raw'].includes(String(key)))
              return async (...args: unknown[]) => {
                stats.sql_statements++;
                stats[which]++;
                stats.d1_calls++;
                if (key === 'first') {
                  const r = await target.all<Record<string, unknown>>();
                  track(r);
                  return args[0]
                    ? (r.results[0]?.[String(args[0])] ?? null)
                    : (r.results[0] ?? null);
                }
                const r = (await Reflect.apply(Reflect.get(target, key), target, args)) as D1Result;
                if (r.meta) track(r);
                return r;
              };
            const v = Reflect.get(target, key);
            return typeof v === 'function' ? v.bind(target) : v;
          },
        });
        originals.set(proxy, stmt);
        return proxy;
      };
      return new Proxy(db, {
        get(target, key) {
          if (key === 'prepare') return (sql: string) => wrap(target.prepare(sql));
          if (key === 'batch')
            return async (rows: D1PreparedStatement[]) => {
              stats.sql_statements += rows.length;
              stats[which] += rows.length;
              stats.d1_calls++;
              stats.max_batch = Math.max(stats.max_batch, rows.length);
              const result = await target.batch(rows.map((row) => originals.get(row) ?? row));
              result.forEach(track);
              return result;
            };
          const v = Reflect.get(target, key);
          return typeof v === 'function' ? v.bind(target) : v;
        },
      });
    };
    const bucket = new Proxy(env.EVIDENCE, {
      get(target, key) {
        const v = Reflect.get(target, key);
        return typeof v === 'function'
          ? (...args: unknown[]) => {
              if (key === 'get') stats.r2_get++;
              if (key === 'put') stats.r2_put++;
              if (key === 'head') stats.r2_head++;
              return Reflect.apply(v, target, args);
            }
          : v;
      },
    });
    const start = performance.now();
    const result = await collectSource(
      {
        ...env,
        PRIVATE_DB: database(env.PRIVATE_DB, 'private_statements'),
        PUBLIC_DB: database(env.PUBLIC_DB, 'public_statements'),
        EVIDENCE: bucket,
      },
      source,
      benchmarkTime,
      {
        synthetic: true,
        now: () => benchmarkTime,
        network: {
          fetcher: async () => {
            stats.mock_http++;
            return new Response(text, { headers: { 'content-type': 'application/json' } });
          },
        },
      },
    );
    return Response.json({
      result,
      ...stats,
      models,
      local_workerd_elapsed_ms: performance.now() - start,
    });
  },
} satisfies ExportedHandler<CollectorEnv>;
