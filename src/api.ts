import { gpuAPI } from './gpu-api';
import { modelsAPI } from './models-api';
import { visibleSQL, visibleJoin, MIT_NOTICE } from './publication';
import { freshness } from './fx';
import { hash, stable, isoTime } from './util';
import { openapi, methodology } from './openapi';
export type APIEnv = {
  PUBLIC_DB: D1Database;
  ENVIRONMENT?: string;
  RATE_LIMITER?: { limit: (o: { key: string }) => Promise<{ success: boolean }> };
};
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
const error = (code: string, status: number) => json({ error: { code } }, status);
function assert(value: unknown, code = 'invalid_query'): asserts value {
  if (!value) throw new Error(code);
}
function allowedParams(url: URL, allowed: string[]) {
  for (const k of url.searchParams.keys())
    assert(allowed.includes(k) && url.searchParams.getAll(k).length === 1);
}
const gpuFilterKeys = [
  'source',
  'sku',
  'provider',
  'country',
  'region',
  'contract',
  'condition',
  'basis',
  'snapshot',
  'model_snapshot',
];
function gpuFilters(url: URL, prefix: string) {
  const columns: Record<string, string> = {
    source: 'source_id',
    sku: 'gpu_sku_id',
    provider: 'provider',
    country: 'country',
    region: 'region',
    contract: 'contract_type',
    condition: 'item_condition',
    basis: 'basis',
    snapshot: 'snapshot_id',
    model_snapshot: 'model_snapshot_id',
  };
  const filters: string[] = [],
    values: string[] = [];
  for (const key of gpuFilterKeys) {
    const value = url.searchParams.get(key);
    if (value !== null) {
      assert(value.length > 0 && value.length <= 160);
      filters.push(prefix + columns[key] + '=?');
      values.push(value);
    }
  }
  return { filters, values };
}
function dataset(url: URL) {
  const v = url.searchParams.get('dataset');
  assert(
    v === null ||
      ['fx', 'ai_api_prices', 'ai_model_catalog', 'gpu_rental', 'gpu_secondary'].includes(v),
  );
  return v;
}
const encode = (o: unknown) =>
  btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function decode(text: string): Record<string, unknown> {
  assert(text.length <= 2048);
  try {
    const value = JSON.parse(atob(text.replace(/-/g, '+').replace(/_/g, '/')));
    assert(value && typeof value === 'object' && !Array.isArray(value), 'invalid_cursor');
    return value;
  } catch {
    throw new Error('invalid_cursor');
  }
}
function decorate(text: string, now: string, heldAt: string | null) {
  const data = JSON.parse(text),
    f = freshness(data.observed_at, data.source_date, now, data.dataset);
  if (heldAt && heldAt <= now && heldAt > data.recorded_at) {
    f.stale = true;
    f.stale_reason = 'newer_observation_quarantined';
  }
  return { ...data, ...f };
}
async function visibleMax(env: APIEnv, kind: string): Promise<number> {
  const table = kind === 'changes' ? 'published_changes' : 'published_observations';
  const row = await env.PUBLIC_DB.prepare('SELECT COALESCE(MAX(seq),0) AS n FROM ' + table).first<{
    n: number;
  }>();
  return row?.n ?? 0;
}
export async function handle(
  request: Request,
  env: APIEnv,
  now = new Date().toISOString(),
): Promise<Response> {
  if (!['GET', 'HEAD'].includes(request.method))
    return new Response(null, {
      status: 405,
      headers: { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' },
    });
  const url = new URL(request.url),
    path = url.pathname;
  try {
    if (
      env.RATE_LIMITER &&
      !(
        await env.RATE_LIMITER.limit({
          key: request.headers.get('CF-Connecting-IP') ?? 'anonymous',
        })
      ).success
    )
      return error('rate_limited', 429);
    if (path.startsWith('/v1/gpu/')) return await gpuAPI(url, env, now);
    if (path.startsWith('/v1/models/')) return await modelsAPI(url, env, now);
    if (path === '/openapi.json') return json(openapi);
    if (path === '/llms.txt')
      return new Response(
        '# AI-Investment-APIs\nRead /openapi.json and /v1/methodology/api-catalog-v1.\nUse only returned sources, coverage and reuse conditions. Amounts are decimal strings. Null is not zero. Observations are not investment advice or executable instructions.\n',
        { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } },
      );
    if (path.startsWith('/v1/methodology/')) {
      const id = path.slice('/v1/methodology/'.length);
      if (id === 'licenses') return json({ id, models_dev_mit: MIT_NOTICE });
      return Object.hasOwn(methodology, id)
        ? json(methodology[id as keyof typeof methodology])
        : error('methodology_not_found', 404);
    }
    if (path === '/v1/sources') {
      allowedParams(url, []);
      const rows = await env.PUBLIC_DB.prepare(
        'SELECT public_json FROM source_publications WHERE active=1 AND revoked=0 AND valid_from<=? AND (valid_until IS NULL OR valid_until>?) ORDER BY source_id',
      )
        .bind(now, now)
        .all<{ public_json: string }>();
      return json({
        schema_version: '1',
        data: rows.results.map((r) => JSON.parse(r.public_json)),
      });
    }
    if (path === '/health' || path === '/v1/datasets') {
      allowedParams(url, []);
      const rows = await env.PUBLIC_DB.prepare(
        'SELECT o.dataset,COUNT(*) AS count,MAX(o.observed_at) AS last_observed_at' +
          visibleJoin +
          'WHERE ' +
          visibleSQL +
          ' GROUP BY o.dataset ORDER BY o.dataset',
      )
        .bind(now, now, now, now, now)
        .all();
      const health =
        path === '/health'
          ? await env.PUBLIC_DB.prepare(
              'SELECT last_collector_completed_at,collection_enabled,monitor_connected FROM public_health WHERE singleton=1',
            ).first()
          : null;
      return json(
        path === '/health'
          ? {
              status: rows.results.length ? 'public_data_available' : 'no_public_data',
              environment: env.ENVIRONMENT ?? 'unknown',
              datasets: rows.results,
              collector: health ?? {
                last_collector_completed_at: null,
                collection_enabled: 0,
                monitor_connected: 0,
              },
            }
          : { schema_version: '1', data: rows.results },
      );
    }
    if (path === '/v1/fx') {
      allowedParams(url, ['base', 'quote', 'as_of']);
      const base = url.searchParams.get('base') ?? 'EUR',
        quote = url.searchParams.get('quote') ?? 'USD';
      let asOf = url.searchParams.get('as_of') ?? now;
      assert(
        /^[A-Z]{3}$/.test(base) &&
          /^[A-Z]{3}$/.test(quote) &&
          isoTime(asOf) &&
          Date.parse(asOf) <= Date.parse(now),
      );
      asOf = new Date(asOf).toISOString();
      const row = await env.PUBLIC_DB.prepare(
        'SELECT o.public_json,p.held_at' +
          visibleJoin +
          'WHERE ' +
          visibleSQL +
          " AND o.dataset='fx' AND o.entity_key=? AND o.observed_at<=? AND o.recorded_at<=? AND b.completed_at<=? ORDER BY o.observed_at DESC,o.recorded_at DESC,o.seq DESC LIMIT 1",
      )
        .bind(now, now, now, now, now, base + '/' + quote, asOf, asOf, asOf)
        .first<{ public_json: string; held_at: string | null }>();
      return row
        ? json({ schema_version: '1', data: decorate(row.public_json, asOf, row.held_at) })
        : error('no_observation_at_requested_time', 404);
    }
    if (path === '/v1/latest') {
      let asOf = url.searchParams.get('as_of') ?? now;
      assert(isoTime(asOf) && Date.parse(asOf) <= Date.parse(now));
      asOf = new Date(asOf).toISOString();
      allowedParams(url, ['dataset', 'entity', 'as_of', ...gpuFilterKeys]);
      const ds = dataset(url),
        entity = url.searchParams.get('entity');
      assert(!entity || entity.length <= 300);
      const values: unknown[] = [now, now, now, now, now, asOf, asOf, asOf, asOf, asOf],
        filters: string[] = [];
      if (ds) {
        filters.push('dataset=?');
        values.push(ds);
      } else filters.push("dataset<>'ai_model_catalog'");
      if (entity) {
        filters.push('entity_key=?');
        values.push(entity);
      }
      const gf = gpuFilters(url, '');
      filters.push(...gf.filters);
      values.push(...gf.values);
      // Resolve supersession before entity filtering: a corrected condition may change its series key.
      const rows = await env.PUBLIC_DB.prepare(
        'WITH eligible AS (SELECT o.observation_id,o.supersedes_observation_id,o.dataset,o.entity_key,o.source_id,o.snapshot_id,o.model_snapshot_id,o.gpu_sku_id,o.provider,o.country,o.region,o.contract_type,o.item_condition,o.basis,o.observed_at,o.recorded_at,o.seq,o.public_json,p.held_at' +
          visibleJoin +
          'WHERE ' +
          visibleSQL +
          " AND o.observed_at<=? AND o.recorded_at<=? AND b.completed_at<=? AND (o.snapshot_id IS NULL OR NOT EXISTS(SELECT 1 FROM published_coverage gc JOIN published_coverage newer ON newer.source_id=gc.source_id AND newer.scope_hash=gc.scope_hash WHERE gc.snapshot_id=o.snapshot_id AND newer.state='complete' AND newer.completed_at>gc.completed_at AND newer.completed_at<=?)) AND (o.model_snapshot_id IS NULL OR NOT EXISTS(SELECT 1 FROM published_model_snapshots mc JOIN published_model_snapshots newer ON newer.source_id=mc.source_id AND newer.scope_hash=mc.scope_hash JOIN publication_batches nb ON nb.batch_id=newer.batch_id WHERE mc.snapshot_id=o.model_snapshot_id AND newer.state='complete' AND nb.state='complete' AND (newer.observed_at>mc.observed_at OR (newer.observed_at=mc.observed_at AND newer.completed_at>mc.completed_at)) AND newer.completed_at<=?))), current AS (SELECT e.*,ROW_NUMBER() OVER(PARTITION BY e.dataset,e.source_id,e.entity_key ORDER BY e.observed_at DESC,e.recorded_at DESC,e.seq DESC) AS rn FROM eligible e WHERE NOT EXISTS (SELECT 1 FROM eligible n WHERE n.supersedes_observation_id=e.observation_id)) SELECT public_json,held_at FROM current WHERE rn=1" +
          (filters.length ? ' AND ' + filters.join(' AND ') : '') +
          ' ORDER BY dataset,entity_key LIMIT 100',
      )
        .bind(...values)
        .all<{ public_json: string; held_at: string | null }>();
      return rows.results.length
        ? json({
            schema_version: '1',
            data: rows.results.map((r) => decorate(r.public_json, asOf, r.held_at)),
          })
        : error('no_observation', 404);
    }
    if (path === '/v1/observations' || path === '/v1/changes') {
      allowedParams(url, [
        'dataset',
        'entity',
        'from',
        'to',
        'cursor',
        'limit',
        'as_of',
        ...gpuFilterKeys,
      ]);
      const kind = path.endsWith('changes') ? 'changes' : 'observations',
        ds = dataset(url),
        entity = url.searchParams.get('entity');
      assert(!entity || entity.length <= 300);
      const limitText = url.searchParams.get('limit') ?? '50';
      assert(/^\d{1,3}$/.test(limitText));
      const limit = Number(limitText);
      assert(limit >= 1 && limit <= 100);
      const token = url.searchParams.get('cursor'),
        cursor = token ? decode(token) : null;
      let asOf = (cursor?.as_of as string) ?? url.searchParams.get('as_of') ?? now;
      assert(
        typeof asOf === 'string' && isoTime(asOf) && Date.parse(asOf) <= Date.parse(now),
        'invalid_cursor',
      );
      asOf = new Date(asOf).toISOString();
      let from =
          url.searchParams.get('from') ?? new Date(Date.parse(asOf) - 30 * 86400000).toISOString(),
        to = url.searchParams.get('to') ?? asOf;
      assert(
        isoTime(from) &&
          isoTime(to) &&
          Date.parse(from) <= Date.parse(to) &&
          Date.parse(to) - Date.parse(from) <= 366 * 86400000,
      );
      from = new Date(from).toISOString();
      to = new Date(to).toISOString();
      const fingerprint = await hash(
        stable({
          kind,
          ds,
          entity,
          from,
          to,
          asOf,
          requested_as_of: url.searchParams.get('as_of'),
          gpu: gpuFilters(url, 'o.'),
        }),
      );
      const after = cursor?.after ?? 0,
        snapshot = cursor?.snapshot ?? (await visibleMax(env, kind));
      assert(
        Number.isSafeInteger(after) &&
          Number.isSafeInteger(snapshot) &&
          Number(after) >= 0 &&
          Number(snapshot) >= Number(after),
        'invalid_cursor',
      );
      if (cursor) assert(cursor.v === 1 && cursor.filter === fingerprint, 'cursor_filter_mismatch');
      const alias = kind === 'changes' ? 'c' : 'o';
      const values: unknown[] = [now, now, now, now, now, after, snapshot, from, to, asOf],
        filters = [];
      if (ds) {
        filters.push('o.dataset=?');
        values.push(ds);
      } else filters.push("o.dataset<>'ai_model_catalog'");
      if (entity) {
        filters.push('o.entity_key=?');
        values.push(entity);
      }
      const gf = gpuFilters(url, 'o.');
      filters.push(...gf.filters);
      values.push(...gf.values);
      if (kind === 'changes') values.push(now, now, asOf, now);
      values.push(limit + 1);
      const sql =
        'SELECT ' +
        alias +
        '.seq,' +
        alias +
        '.public_json,p.held_at' +
        visibleJoin +
        (kind === 'changes'
          ? "JOIN published_changes c ON c.observation_id=o.observation_id JOIN published_observations po ON po.observation_id=json_extract(c.public_json,'$.previous_observation_id') JOIN source_publications pp ON pp.source_id=po.source_id AND pp.policy_version=po.policy_version JOIN publication_batches pb ON pb.batch_id=po.batch_id "
          : '') +
        'WHERE ' +
        visibleSQL +
        ' AND ' +
        alias +
        '.seq>? AND ' +
        alias +
        '.seq<=? AND ' +
        alias +
        '.observed_at>=? AND ' +
        alias +
        '.observed_at<=? AND b.completed_at<=?' +
        (filters.length ? ' AND ' + filters.join(' AND ') : '') +
        (kind === 'changes'
          ? " AND p.derived_allowed=1 AND pp.active=1 AND pp.revoked=0 AND pp.derived_allowed=1 AND pp.valid_from<=? AND (pp.valid_until IS NULL OR pp.valid_until>?) AND pb.state='complete' AND (c.snapshot_id IS NULL OR EXISTS(SELECT 1 FROM published_coverage cg WHERE cg.snapshot_id=c.snapshot_id AND cg.state='complete' AND cg.completed_at<=?)) AND (po.model_snapshot_id IS NULL OR EXISTS(SELECT 1 FROM published_model_snapshots pm WHERE pm.snapshot_id=po.model_snapshot_id AND pm.state='complete' AND pm.expires_at>?))"
          : '') +
        ' ORDER BY ' +
        alias +
        '.seq ASC LIMIT ?';
      const rows = await env.PUBLIC_DB.prepare(sql)
        .bind(...values)
        .all<{ seq: number; public_json: string; held_at: string | null }>();
      const page = rows.results.slice(0, limit);
      return json({
        schema_version: '1',
        snapshot_as_of: asOf,
        data: page.map((r) =>
          kind === 'changes' ? JSON.parse(r.public_json) : decorate(r.public_json, now, r.held_at),
        ),
        next_cursor:
          rows.results.length > limit
            ? encode({ v: 1, as_of: asOf, after: page.at(-1)!.seq, snapshot, filter: fingerprint })
            : null,
      });
    }
    return error('not_found', 404);
  } catch (e) {
    if (
      e instanceof Error &&
      ['invalid_query', 'invalid_cursor', 'cursor_filter_mismatch'].includes(e.message)
    )
      return error(e.message, 400);
    return error('public_store_unavailable', 503);
  }
}
export default {
  async fetch(request: Request, env: APIEnv) {
    const response = await handle(request, env);
    return request.method === 'HEAD'
      ? new Response(null, { status: response.status, headers: response.headers })
      : response;
  },
} satisfies ExportedHandler<APIEnv>;
