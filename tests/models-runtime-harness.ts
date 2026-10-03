import { expandedSource, catalog } from './models-helpers';
import { collectModels } from '../src/models-pipeline';
import { handle } from '../src/api';
import { modelEvidence, readModelEvidence } from '../src/models';
import type { CollectorEnv } from '../src/schema';
const time = '2026-10-03T18:17:00.000Z';
export async function modelsRuntime(request: Request, env: CollectorEnv) {
  const url = new URL(request.url),
    n = Number(url.searchParams.get('n') ?? 1000);
  if (![50, 250, 1000].includes(n)) throw new Error('synthetic_scale_invalid');
  const s = expandedSource();
  s.source_id = 'synthetic_models_' + n;
  if (url.pathname === '/models-large') {
    const input = catalog(n);
    input.unselected = { id: 'unselected', description: 'x'.repeat(8 * 1024 * 1024), models: {} };
    const text = JSON.stringify(input).replace('"input":1', '"input":1.234567890123456789');
    const evidence = await modelEvidence(s, text, time, true),
      projected = await readModelEvidence(s, evidence);
    return Response.json({
      model_count: projected.records.length,
      payload_bytes: evidence.bytes,
      projection_bytes: new TextEncoder().encode(evidence.body).byteLength,
      complete: projected.complete,
      exact_decimal: projected.records.find((r) => r.catalog.model_id === 'synthetic-model-0')!
        .price!.price_components[0].amount_decimal,
      external_requests: 0,
    });
  }
  if (url.pathname === '/models-step') {
    const stats = {
      sql_statements: 0,
      d1_calls: 0,
      max_batch: 0,
      rows_read: 0,
      rows_written: 0,
      metadata_incomplete: false,
      r2_get: 0,
      r2_put: 0,
      http_requests: 0,
    };
    const track = (r: any) => {
      if (r?.meta) {
        stats.rows_read += r.meta.rows_read ?? 0;
        stats.rows_written += r.meta.rows_written ?? 0;
      } else stats.metadata_incomplete = true;
    };
    const database = (db: D1Database) => {
      const original = new WeakMap<object, D1PreparedStatement>();
      const wrap = (stmt: D1PreparedStatement): D1PreparedStatement => {
        const proxy = new Proxy(stmt, {
          get(target, key) {
            if (key === 'bind') return (...args: any[]) => wrap(target.bind(...args));
            if (['run', 'all', 'first', 'raw'].includes(String(key)))
              return async (...args: any[]) => {
                stats.sql_statements++;
                stats.d1_calls++;
                const result =
                  key === 'first' ? await target.all() : await (target as any)[key](...args);
                track(result);
                return key === 'first'
                  ? ((args[0] ? result.results[0]?.[args[0]] : result.results[0]) ?? null)
                  : result;
              };
            const v = (target as any)[key];
            return typeof v === 'function' ? v.bind(target) : v;
          },
        });
        original.set(proxy, stmt);
        return proxy;
      };
      return {
        prepare: (sql: string) => wrap(db.prepare(sql)),
        batch: async (rows: D1PreparedStatement[]) => {
          stats.sql_statements += rows.length;
          stats.d1_calls++;
          stats.max_batch = Math.max(stats.max_batch, rows.length);
          const result = await db.batch(rows.map((row) => original.get(row) ?? row));
          result.forEach(track);
          return result;
        },
      } as D1Database;
    };
    const bucket = new Proxy(env.EVIDENCE, {
      get(target, key) {
        const value = (target as any)[key];
        return typeof value === 'function'
          ? (...args: any[]) => {
              if (key === 'get') stats.r2_get++;
              if (key === 'put') stats.r2_put++;
              return value.apply(target, args);
            }
          : value;
      },
    });
    const body = JSON.stringify(catalog(n)),
      started = performance.now();
    const result = await collectModels(
      {
        ...env,
        PRIVATE_DB: database(env.PRIVATE_DB),
        PUBLIC_DB: database(env.PUBLIC_DB),
        EVIDENCE: bucket,
      },
      s,
      time,
      {
        synthetic: true,
        now: () => time,
        network: {
          fetcher: (async () => {
            stats.http_requests++;
            return new Response(body, { headers: { 'content-type': 'application/json' } });
          }) as typeof fetch,
        },
      },
    );
    return Response.json({
      result,
      ...stats,
      payload_bytes: new TextEncoder().encode(body).byteLength,
      local_workerd_elapsed_ms: performance.now() - started,
    });
  }
  if (url.pathname === '/models-size') {
    const privateSize = await env.PRIVATE_DB.prepare('SELECT 1').run();
    const publicSize = await env.PUBLIC_DB.prepare('SELECT 1').run();
    return Response.json({
      private_bytes: privateSize.meta.size_after,
      public_bytes: publicSize.meta.size_after,
    });
  }
  if (url.pathname === '/models-verify') {
    const snap = await env.PRIVATE_DB.prepare(
      "SELECT model_count,price_count,component_count,quarantined_count,metrics_json FROM model_snapshots WHERE source_id=? AND state='complete'",
    )
      .bind(s.source_id)
      .first();
    const events = await handle(
      new Request('https://local.test/v1/models/events?source=' + s.source_id + '&limit=100'),
      { PUBLIC_DB: env.PUBLIC_DB },
      time,
    );
    const fk = await env.PRIVATE_DB.prepare('PRAGMA foreign_key_check').all();
    return Response.json({
      snapshot: snap,
      event_status: events.status,
      events: await events.json(),
      foreign_key_violations: fk.results,
    });
  }
  return handle(request, { PUBLIC_DB: env.PUBLIC_DB }, time);
}
