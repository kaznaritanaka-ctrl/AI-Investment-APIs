import type { APIEnv } from './api';
import { metricVisibleSQL } from './gpu-visibility';
import { hash, stable, isoTime } from './util';
import catalog from '../config/gpu-catalog.json';
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
function assert(v: unknown): asserts v {
  if (!v) throw new Error('invalid_query');
}
const encode = (v: unknown) =>
  btoa(JSON.stringify(v)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
export async function gpuAPI(url: URL, env: APIEnv, now: string) {
  const kind = url.pathname.split('/').at(-1);
  if (kind === 'catalog') {
    assert(url.searchParams.size === 0);
    return json({ data: catalog, market_observations: false });
  }
  if (!['coverage', 'metrics', 'comparisons'].includes(kind ?? ''))
    return json({ error: { code: 'not_found' } }, 404);
  const allowed = ['dataset', 'source', 'sku', 'scope', 'from', 'to', 'limit', 'cursor', 'as_of'];
  for (const k of url.searchParams.keys())
    assert(allowed.includes(k) && url.searchParams.getAll(k).length === 1);
  const ds = url.searchParams.get('dataset');
  assert(ds === null || ['gpu_rental', 'gpu_secondary'].includes(ds));
  const limitText = url.searchParams.get('limit') ?? '50';
  assert(/^\d{1,3}$/.test(limitText));
  const limit = Number(limitText);
  assert(limit > 0 && limit <= 100);
  const cursorText = url.searchParams.get('cursor');
  let cursor: Record<string, unknown> | null = null;
  if (cursorText !== null) {
    assert(cursorText.length > 0 && cursorText.length <= 2048);
    try {
      cursor = JSON.parse(atob(cursorText.replaceAll('-', '+').replaceAll('_', '/')));
      assert(cursor && typeof cursor === 'object' && !Array.isArray(cursor));
    } catch {
      throw new Error('invalid_cursor');
    }
  }
  const rawAsOf = cursor?.as_of ?? url.searchParams.get('as_of') ?? now;
  assert(typeof rawAsOf === 'string' && isoTime(rawAsOf) && Date.parse(rawAsOf) <= Date.parse(now));
  const asOf = new Date(rawAsOf).toISOString();
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
  const table = kind === 'coverage' ? 'published_coverage' : 'published_gpu_metrics',
    alias = kind === 'coverage' ? 'c' : 'm';
  const filters: string[] = [],
    args: unknown[] = [];
  for (const [key, column] of [
    ['dataset', 'dataset'],
    ['source', 'source_id'],
    ['sku', 'gpu_sku_id'],
    ['scope', kind === 'coverage' ? 'scope_hash' : "json_extract(m.public_json,'$.scope_hash')"],
  ]) {
    const v = url.searchParams.get(key);
    if (v !== null) {
      assert(v.length > 0 && v.length <= 160);
      if (kind === 'coverage' && key === 'sku') throw new Error('invalid_query');
      filters.push((column.startsWith('json_extract') ? column : alias + '.' + column) + '=?');
      args.push(v);
    }
  }
  const fingerprint = await hash(
      stable({
        kind,
        from,
        to,
        asOf,
        requested_as_of: url.searchParams.get('as_of'),
        filters,
        args,
      }),
    ),
    after = cursor?.after ?? 0,
    maximum =
      cursor?.maximum ??
      (
        await env.PUBLIC_DB.prepare('SELECT COALESCE(MAX(seq),0) AS n FROM ' + table).first<{
          n: number;
        }>()
      )?.n ??
      0;
  assert(
    Number.isSafeInteger(after) &&
      Number.isSafeInteger(maximum) &&
      Number(after) >= 0 &&
      Number(maximum) >= Number(after),
  );
  if (cursor && cursor.filter !== fingerprint) throw new Error('cursor_filter_mismatch');
  const policy =
    kind === 'coverage'
      ? 'p.active=1 AND p.revoked=0 AND p.valid_from<=? AND (p.valid_until IS NULL OR p.valid_until>?)'
      : metricVisibleSQL;
  const values: unknown[] = kind === 'coverage' ? [now, now] : [now, now, now, now];
  values.push(after, maximum, from, to, asOf, ...args);
  const rows = await env.PUBLIC_DB.prepare(
    'SELECT ' +
      alias +
      '.seq,' +
      alias +
      '.public_json FROM ' +
      table +
      ' ' +
      alias +
      ' JOIN source_publications p ON p.source_id=' +
      alias +
      '.source_id AND p.policy_version=' +
      alias +
      '.policy_version WHERE ' +
      policy +
      ' AND ' +
      alias +
      '.seq>? AND ' +
      alias +
      '.seq<=? AND ' +
      alias +
      '.observed_at>=? AND ' +
      alias +
      '.observed_at<=? AND ' +
      alias +
      '.recorded_at<=?' +
      (kind === 'coverage'
        ? ''
        : " AND json_extract(m.public_json,'$.kind')" +
          (kind === 'metrics' ? "='cohort_summary'" : "<>'cohort_summary'")) +
      (filters.length ? ' AND ' + filters.join(' AND ') : '') +
      ' ORDER BY ' +
      alias +
      '.seq LIMIT ?',
  )
    .bind(...values, limit + 1)
    .all<{ seq: number; public_json: string }>();
  const page = rows.results.slice(0, limit);
  return json({
    schema_version: '1',
    snapshot_as_of: asOf,
    data: page.map((r) => JSON.parse(r.public_json)),
    next_cursor:
      rows.results.length > limit
        ? encode({ after: page.at(-1)!.seq, maximum, as_of: asOf, filter: fingerprint })
        : null,
  });
}
