import type { APIEnv } from './api';
import { hash, stable, isoTime } from './util';
const json = (data: unknown, status = 200) =>
  Response.json(data, {
    status,
    headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  });
export async function modelsAPI(url: URL, env: APIEnv, now: string) {
  try {
    const events = url.pathname === '/v1/models/events';
    if (!events && url.pathname !== '/v1/models/coverage')
      return json({ error: { code: 'not_found' } }, 404);
    const allowed = ['source', 'scope', 'snapshot', 'as_of', 'limit', 'cursor'];
    for (const k of url.searchParams.keys())
      if (!allowed.includes(k) || url.searchParams.getAll(k).length !== 1)
        throw new Error('invalid_query');
    const token = url.searchParams.get('cursor');
    if (token && token.length > 2048) throw new Error('invalid_cursor');
    let cursor: any = null;
    if (token) {
      try {
        cursor = JSON.parse(atob(token.replace(/-/g, '+').replace(/_/g, '/')));
        if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) throw new Error();
      } catch {
        throw new Error('invalid_cursor');
      }
    }
    const cutoff = cursor?.as_of ?? url.searchParams.get('as_of') ?? now;
    if (!isoTime(cutoff) || Date.parse(cutoff) > Date.parse(now)) throw new Error('invalid_query');
    const asOf = new Date(cutoff).toISOString();
    const limitText = url.searchParams.get('limit') ?? '50';
    if (!/^\d{1,3}$/.test(limitText) || +limitText < 1 || +limitText > 100)
      throw new Error('invalid_query');
    const filters: string[] = [],
      args: string[] = [];
    for (const [key, column] of [
      ['source', 'source_id'],
      ['scope', 'scope_hash'],
      ['snapshot', 'snapshot_id'],
    ]) {
      const value = url.searchParams.get(key);
      if (value !== null) {
        if (!value || value.length > 160) throw new Error('invalid_query');
        filters.push('s.' + column + '=?');
        args.push(value);
      }
    }
    const fingerprint = await hash(
      stable({ events, args, filters, asOf, requested: url.searchParams.get('as_of') }),
    );
    const table = events ? 'published_model_events' : 'published_model_snapshots',
      seq = events ? 'e.seq' : 's.rowid';
    const top =
      cursor?.top ??
      (await env.PUBLIC_DB.prepare(
        'SELECT COALESCE(MAX(' + (events ? 'seq' : 'rowid') + '),0) n FROM ' + table,
      ).first<{ n: number }>())!.n;
    const after = cursor?.after ?? 0;
    if (
      !Number.isSafeInteger(top) ||
      !Number.isSafeInteger(after) ||
      after < 0 ||
      top < after ||
      (cursor && (cursor.v !== 1 || cursor.filter !== fingerprint))
    )
      throw new Error('invalid_cursor');
    const sql =
      'SELECT ' +
      seq +
      ' seq,' +
      (events ? 'e' : 's') +
      '.public_json FROM published_model_snapshots s JOIN publication_batches b ON b.batch_id=s.batch_id JOIN source_publications p ON p.source_id=s.source_id AND p.policy_version=s.policy_version ' +
      (events ? 'JOIN published_model_events e ON e.snapshot_id=s.snapshot_id ' : '') +
      "WHERE b.state='complete' AND p.active=1 AND p.revoked=0 AND p.valid_from<=? AND (p.valid_until IS NULL OR p.valid_until>?) AND s.expires_at>? AND s.state IN ('complete','partial') AND s.completed_at<=? AND s.observed_at<=? AND s.recorded_at<=? AND " +
      seq +
      '>? AND ' +
      seq +
      '<=? ' +
      (events
        ? "AND s.state='complete' AND p.derived_allowed=1 AND e.recorded_at<=? AND NOT EXISTS(SELECT 1 FROM (SELECT e.observation_id id UNION SELECT e.previous_observation_id id) inputs LEFT JOIN published_observations o ON o.observation_id=inputs.id LEFT JOIN publication_batches ib ON ib.batch_id=o.batch_id LEFT JOIN source_publications ip ON ip.source_id=o.source_id AND ip.policy_version=o.policy_version LEFT JOIN published_model_snapshots ims ON ims.snapshot_id=o.model_snapshot_id WHERE inputs.id IS NOT NULL AND (o.observation_id IS NULL OR ip.source_id IS NULL OR ib.batch_id IS NULL OR ims.snapshot_id IS NULL OR ib.state<>'complete' OR ib.completed_at>? OR o.recorded_at>? OR ip.active<>1 OR ip.revoked<>0 OR ip.derived_allowed<>1 OR ip.valid_from>? OR (ip.valid_until IS NOT NULL AND ip.valid_until<=?) OR ims.state<>'complete' OR ims.expires_at<=?)) "
        : '') +
      (filters.length ? 'AND ' + filters.join(' AND ') : '') +
      ' ORDER BY ' +
      seq +
      ' LIMIT ?';
    const values: unknown[] = [now, now, now, asOf, asOf, asOf, after, top];
    if (events) values.push(asOf, asOf, asOf, now, now, now);
    const result = await env.PUBLIC_DB.prepare(sql)
      .bind(...values, ...args, +limitText + 1)
      .all<{ seq: number; public_json: string }>();
    const rows = result.results.slice(0, +limitText);
    return json({
      schema_version: '1',
      snapshot_as_of: asOf,
      data: rows.map((r) => JSON.parse(r.public_json)),
      next_cursor:
        result.results.length > +limitText
          ? btoa(
              JSON.stringify({
                v: 1,
                as_of: asOf,
                after: rows.at(-1)!.seq,
                top,
                filter: fingerprint,
              }),
            )
              .replace(/\+/g, '-')
              .replace(/\//g, '_')
              .replace(/=+$/, '')
          : null,
    });
  } catch (e) {
    return json(
      {
        error: {
          code:
            e instanceof Error && ['invalid_query', 'invalid_cursor'].includes(e.message)
              ? e.message
              : 'public_store_unavailable',
        },
      },
      e instanceof Error && ['invalid_query', 'invalid_cursor'].includes(e.message) ? 400 : 503,
    );
  }
}
