import type { APIEnv } from './api';
import type { Source } from './schema';
import { sources } from './sources';
import { canPublish } from './policy';
import { estatConfigurationHash } from './estat';
import { ESTAT_CREDIT } from './estat-schema';
import { hash, stable, isoTime } from './util';

export const supplyChainJSON = (data: Record<string, unknown>, status = 200) =>
  Response.json(
    {
      ...data,
      api_credit: ESTAT_CREDIT,
      attribution:
        '経済産業省生産動態統計／鉱工業指数（経済産業省）、政府統計の総合窓口(e-Stat)（https://www.e-stat.go.jp/）を加工して作成',
    },
    {
      status,
      headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
    },
  );
const encode = (data: unknown) =>
  btoa(JSON.stringify(data)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const period = (value: string) => /^(?:\d{4}(?:-(?:0[1-9]|1[0-2])|FY)?)$/.test(value);

// Current authorization gates all reads. Each historical row must independently match its
// immutable reviewed configuration and have been fetched during its own policy window.
// Renewal deactivates old policies for collection, but revocation still withdraws their history.
export async function supplyChainAPI(
  url: URL,
  env: APIEnv,
  now: string,
  sourceList: Source[] = sources,
) {
  try {
    const match =
      /^\/v1\/supply-chain\/series(?:\/([A-Za-z0-9_-]{1,160})\/(observations|revisions))?$/.exec(
        url.pathname,
      );
    if (!match) return supplyChainJSON({ error: { code: 'not_found' } }, 404);
    const kind = match[2] ?? 'series',
      seriesId = match[1] ?? null;
    for (const key of url.searchParams.keys())
      if (
        !['limit', 'cursor', ...(kind === 'observations' ? ['from', 'to'] : [])].includes(key) ||
        url.searchParams.getAll(key).length !== 1
      )
        throw new Error('invalid_query');
    const from = url.searchParams.get('from'),
      to = url.searchParams.get('to'),
      limitText = url.searchParams.get('limit') ?? '100';
    if (
      (from !== null && !period(from)) ||
      (to !== null && !period(to)) ||
      (from && to && from > to) ||
      !/^\d{1,3}$/.test(limitText) ||
      +limitText < 1 ||
      +limitText > 100
    )
      throw new Error('invalid_query');
    const fingerprint = await hash(stable({ kind, seriesId, from, to }));
    let asOf = now,
      after: string[] | null = null;
    const cursor = url.searchParams.get('cursor');
    if (cursor !== null) {
      try {
        if (!cursor || cursor.length > 2048) throw new Error();
        const value = JSON.parse(atob(cursor.replace(/-/g, '+').replace(/_/g, '/')));
        if (
          value.v !== 1 ||
          value.filter !== fingerprint ||
          !isoTime(value.as_of) ||
          value.as_of > now ||
          !Array.isArray(value.after) ||
          value.after.length !== (kind === 'series' ? 1 : kind === 'observations' ? 3 : 2) ||
          !value.after.every((v: unknown) => typeof v === 'string' && v.length <= 200)
        )
          throw new Error();
        asOf = new Date(value.as_of).toISOString();
        after = value.after;
      } catch {
        throw new Error('invalid_cursor');
      }
    }
    const scopes: string[] = [],
      bindings: unknown[] = [now, asOf, asOf];
    for (const source of sourceList) {
      if (
        !['estat_meti_seidou', 'estat_meti_iip'].includes(source.source_id) ||
        !canPublish(source, now, kind === 'revisions')
      )
        continue;
      const configurationHash = await estatConfigurationHash(source);
      scopes.push(
        '(o.source_id=? AND EXISTS (SELECT 1 FROM source_publications current JOIN sc_policy_versions reviewed ON reviewed.source_id=current.source_id AND reviewed.policy_version=current.policy_version WHERE current.source_id=o.source_id AND current.policy_version=? AND reviewed.configuration_hash=? AND current.active=1 AND current.revoked=0 AND current.valid_from<=? AND (current.valid_until IS NULL OR current.valid_until>?)' +
          (kind === 'revisions' ? ' AND current.derived_allowed=1' : '') +
          '))',
      );
      bindings.push(source.source_id, source.policy.version, configurationHash, now, now);
    }
    // Even with no enabled source, query the projection so an unapplied migration returns a
    // controlled 503 and never changes any legacy API query or its migration requirements.
    const eligible =
      'WITH eligible AS (SELECT o.* FROM sc_observations o JOIN sc_series s ON s.series_id=o.series_id AND s.source_id=o.source_id JOIN sc_definition_versions d ON d.definition_version_id=o.definition_version_id AND d.series_id=o.series_id JOIN publication_batches b ON b.batch_id=o.batch_id AND b.source_id=o.source_id AND b.policy_version=o.policy_version JOIN source_publications p ON p.source_id=o.source_id AND p.policy_version=o.policy_version JOIN sc_policy_versions reviewed ON reviewed.source_id=o.source_id AND reviewed.policy_version=o.policy_version AND reviewed.configuration_hash=o.configuration_hash ' +
      "WHERE b.state='complete' AND p.revoked=0 AND p.valid_from<=o.fetched_at AND (p.valid_until IS NULL OR p.valid_until>o.fetched_at) AND o.expires_at>? AND b.completed_at<=? AND o.fetched_at<=? AND " +
      (scopes.length ? '(' + scopes.join(' OR ') + ')' : '0') +
      (kind === 'revisions' ? ' AND p.derived_allowed=1' : '') +
      ') ';
    let sql: string;
    if (kind === 'series') {
      sql =
        'SELECT s.series_id k1,s.public_json,(SELECT d.public_json FROM eligible e JOIN sc_definition_versions d ON d.definition_version_id=e.definition_version_id WHERE e.series_id=s.series_id ORDER BY e.fetched_at DESC,e.obs_id DESC LIMIT 1) latest_definition,(SELECT max(e.fetched_at) FROM eligible e WHERE e.series_id=s.series_id) latest_fetched_at,(SELECT json_group_array(json(d.public_json)) FROM sc_definition_versions d WHERE d.series_id=s.series_id AND EXISTS(SELECT 1 FROM eligible e WHERE e.definition_version_id=d.definition_version_id)) definitions FROM sc_series s WHERE EXISTS(SELECT 1 FROM eligible e WHERE e.series_id=s.series_id)' +
        (after ? ' AND s.series_id>?' : '') +
        ' ORDER BY s.series_id LIMIT ?';
      if (after) bindings.push(...after);
    } else if (kind === 'observations') {
      sql =
        'SELECT o.period k1,o.fetched_at k2,o.obs_id k3,o.public_json FROM eligible o WHERE o.series_id=?';
      bindings.push(seriesId);
      if (from) {
        sql += ' AND o.period>=?';
        bindings.push(from);
      }
      if (to) {
        sql += ' AND o.period<=?';
        bindings.push(to);
      }
      if (after) {
        sql += ' AND (o.period,o.fetched_at,o.obs_id)>(?,?,?)';
        bindings.push(...after);
      }
      sql += ' ORDER BY o.period,o.fetched_at,o.obs_id LIMIT ?';
    } else {
      sql =
        'SELECT r.detected_at k1,r.revision_id k2,r.public_json FROM sc_revisions r JOIN eligible old ON old.obs_id=r.before_obs_id AND old.series_id=r.series_id JOIN eligible newer ON newer.obs_id=r.after_obs_id AND newer.series_id=r.series_id AND newer.supersedes_obs_id=old.obs_id WHERE r.series_id=? AND r.detected_at<=?' +
        (after ? ' AND (r.detected_at,r.revision_id)>(?,?)' : '') +
        ' ORDER BY r.detected_at,r.revision_id LIMIT ?';
      bindings.push(seriesId, asOf);
      if (after) bindings.push(...after);
    }
    const result = await env.PUBLIC_DB.prepare(eligible + sql)
      .bind(...bindings, +limitText + 1)
      .all<{
        k1: string;
        k2?: string;
        k3?: string;
        public_json: string;
        definitions?: string;
        latest_definition?: string;
        latest_fetched_at?: string;
      }>();
    const rows = result.results.slice(0, +limitText),
      last = rows.at(-1);
    return supplyChainJSON({
      schema_version: '1',
      snapshot_as_of: asOf,
      data: rows.map((row) => ({
        ...JSON.parse(row.public_json),
        ...(kind === 'series'
          ? {
              ...JSON.parse(row.latest_definition ?? '{}'),
              fetched_at: row.latest_fetched_at,
              definitions: JSON.parse(row.definitions ?? '[]'),
            }
          : {}),
      })),
      next_cursor:
        result.results.length > +limitText && last
          ? encode({
              v: 1,
              filter: fingerprint,
              as_of: asOf,
              after: [last.k1, last.k2, last.k3].filter((value) => value !== undefined),
            })
          : null,
    });
  } catch (error) {
    const code =
      error instanceof Error && ['invalid_query', 'invalid_cursor'].includes(error.message)
        ? error.message
        : 'public_store_unavailable';
    return supplyChainJSON({ error: { code } }, code === 'public_store_unavailable' ? 503 : 400);
  }
}
