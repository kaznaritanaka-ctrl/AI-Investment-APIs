import type { CollectorEnv, Source } from './schema';
import type { EstatPage, EstatRow } from './estat';
import { estatConfigurationHash } from './estat';
import { ESTAT_CREDIT } from './estat-schema';
import { assertPersistenceAllowed, canPublish } from './policy';
import { D, hash, stable } from './util';

type StoredObservation = {
  obs_id: string;
  definition_version_id: string;
  value_decimal: string | null;
  value_flag: string | null;
};
export function estatNotice(s: Source, fetchedAt: string) {
  return {
    source: { source_id: s.source_id, source_url: s.source_url, operator: s.operator },
    attribution: s.attribution_text,
    license: 'e-Stat利用規約（CC BY 4.0互換）',
    reuse: { license_url: s.license_url, conditions: s.policy.conditions, notice: ESTAT_CREDIT },
    api_credit: ESTAT_CREDIT,
    fetched_at: fetchedAt,
    note: 'AI向け専用統計ではない',
    methodology: 'supply-chain-v1',
    rights_version: s.policy.version,
  };
}
export async function storeEstatRow(
  env: CollectorEnv,
  s: Source,
  run: string,
  batch: string,
  page: EstatPage,
  row: EstatRow,
  responseHash: string,
  fetchedAt: string,
  now: string,
  synthetic: boolean,
) {
  await assertPersistenceAllowed(env, s, now);
  const config = await estatConfigurationHash(s);
  const series = await hash(stable([s.source_id, page.table.group, row.item_code, row.measure]));
  const definition = await hash(
    stable([series, row.item_name_ja, row.unit_raw, row.base_year, page.schema_signature]),
  );
  const obs = await hash(stable([run, page.table.table_id, series, definition, row.period]));
  const prior = await env.PRIVATE_DB.prepare(
    "SELECT o.obs_id,o.definition_version_id,o.value_decimal,o.value_flag FROM sc_observations o JOIN sc_intakes i ON i.publication_batch=o.batch_id JOIN collection_runs c ON c.run_id=i.run_id WHERE c.state='complete' AND o.series_id=? AND o.period=? AND o.obs_id<>? AND o.fetched_at<=? ORDER BY o.fetched_at DESC,o.obs_id DESC LIMIT 1",
  )
    .bind(series, row.period, obs, fetchedAt)
    .first<StoredObservation>();
  // Compare only within an unchanged definition; a renamed/rebased series starts a new
  // definition without automatically linking values across incompatible units or codes.
  const comparable = prior?.definition_version_id === definition;
  const changed =
    !!prior &&
    comparable &&
    ((prior.value_decimal === null || row.value_decimal === null
      ? prior.value_decimal !== row.value_decimal
      : !new D(prior.value_decimal).eq(row.value_decimal)) ||
      prior.value_flag !== row.value_flag);
  if (prior && comparable && !changed) return { observations: 0, changes: 0 };
  const supersedes = changed ? prior!.obs_id : null;
  const expires = new Date(
    Date.parse(fetchedAt) + s.estat!.normalized_days * 86400000,
  ).toISOString();
  const notice = { ...estatNotice(s, fetchedAt), data_origin: synthetic ? 'synthetic' : 'live' };
  const seriesJSON = stable({
    ...notice,
    series_id: series,
    stats_code: s.estat!.stats_code,
    table_title: page.table.title,
    item_code: row.item_code,
    item_name_ja: row.item_name_ja,
    measure: row.measure,
    unit_raw: row.unit_raw,
    unit_norm: null,
    base_year: row.base_year,
    definition_version_id: definition,
  });
  const definitionJSON = stable({
    ...notice,
    series_id: series,
    definition_version_id: definition,
    valid_from_year: null,
    source_table_year: page.table.year,
    item_name_ja: row.item_name_ja,
    unit_raw: row.unit_raw,
    base_year: row.base_year,
    source_table_id: page.table.table_id,
    schema_signature: page.schema_signature,
    mapping_note:
      'Definition validity start is unknown; table edition is recorded separately. No automatic linking across changed names, units, base years or code systems.',
  });
  const observationJSON = stable({
    ...notice,
    obs_id: obs,
    series_id: series,
    definition_version_id: definition,
    ...row,
    release_kind: s.estat!.release_kind,
    stats_data_id: page.table.table_id,
    source_updated_at: page.table.updated_at,
    response_sha256: responseHash,
    supersedes_obs_id: supersedes,
  });
  const existing = await env.PRIVATE_DB.prepare(
    'SELECT public_json FROM sc_observations WHERE obs_id=?',
  )
    .bind(obs)
    .first<{ public_json: string }>();
  if (existing && existing.public_json !== observationJSON)
    throw new Error('estat_duplicate_value');
  const rowStatements = (db: D1Database) => [
    db
      .prepare('INSERT OR IGNORE INTO sc_series VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .bind(
        series,
        s.source_id,
        s.policy.version,
        config,
        s.estat!.stats_code,
        page.table.title,
        row.item_code,
        row.item_name_ja,
        row.measure,
        row.unit_raw,
        null,
        row.base_year,
        definition,
        seriesJSON,
      ),
    db
      .prepare('INSERT OR IGNORE INTO sc_definition_versions VALUES (?,?,?,?,?,?,?,?)')
      .bind(
        definition,
        series,
        null,
        row.item_name_ja,
        row.unit_raw,
        page.table.table_id,
        null,
        definitionJSON,
      ),
    db
      .prepare('INSERT OR IGNORE INTO sc_observations VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .bind(
        obs,
        series,
        definition,
        batch,
        s.source_id,
        s.policy.version,
        config,
        row.period,
        row.value_decimal,
        row.value_flag,
        s.estat!.release_kind,
        page.table.table_id,
        page.table.updated_at,
        fetchedAt,
        responseHash,
        supersedes,
        expires,
        observationJSON,
      ),
  ];
  // Explicit column counts below remain shared by private and public projections.
  const statements = rowStatements(env.PRIVATE_DB);
  await env.PRIVATE_DB.batch(statements);
  if (canPublish(s, now)) await env.PUBLIC_DB.batch(rowStatements(env.PUBLIC_DB));
  if (changed) {
    const revision = await hash(prior!.obs_id + '|' + obs);
    const body = stable({
      ...notice,
      revision_id: revision,
      series_id: series,
      before_obs_id: prior!.obs_id,
      after_obs_id: obs,
      detected_at: fetchedAt,
      before: { value_decimal: prior!.value_decimal, value_flag: prior!.value_flag },
      after: { value_decimal: row.value_decimal, value_flag: row.value_flag },
    });
    const statement = (db: D1Database) =>
      db
        .prepare('INSERT OR IGNORE INTO sc_revisions VALUES (?,?,?,?,?,?)')
        .bind(revision, series, prior!.obs_id, obs, fetchedAt, body);
    await statement(env.PRIVATE_DB).run();
    // Old public input may have expired or belonged to a private-only run.
    if (
      canPublish(s, now, true) &&
      (await env.PUBLIC_DB.prepare('SELECT obs_id FROM sc_observations WHERE obs_id=?')
        .bind(prior!.obs_id)
        .first())
    )
      await statement(env.PUBLIC_DB).run();
  }
  return { observations: 1, changes: changed ? 1 : 0 };
}

// Public withdrawal precedes private deletion. Each continuation has a small bounded budget.
export async function expireEstat(env: CollectorEnv, now: string): Promise<boolean> {
  for (const db of [env.PUBLIC_DB, env.PRIVATE_DB]) {
    const rows = await db
      .prepare(
        'SELECT obs_id FROM sc_observations WHERE expires_at<=? ORDER BY expires_at,obs_id LIMIT 20',
      )
      .bind(now)
      .all<{ obs_id: string }>();
    if (!rows.results.length) continue;
    for (const { obs_id } of rows.results) {
      await db.batch([
        db
          .prepare('DELETE FROM sc_revisions WHERE before_obs_id=? OR after_obs_id=?')
          .bind(obs_id, obs_id),
        db.prepare('DELETE FROM sc_observations WHERE obs_id=?').bind(obs_id),
      ]);
    }
    return true;
  }
  for (const db of [env.PUBLIC_DB, env.PRIVATE_DB]) {
    const definitions = await db
      .prepare(
        'SELECT definition_version_id FROM sc_definition_versions d WHERE NOT EXISTS (SELECT 1 FROM sc_observations o WHERE o.definition_version_id=d.definition_version_id) LIMIT 20',
      )
      .all<{ definition_version_id: string }>();
    for (const row of definitions.results)
      await db
        .prepare('DELETE FROM sc_definition_versions WHERE definition_version_id=?')
        .bind(row.definition_version_id)
        .run();
    const series = await db
      .prepare(
        'SELECT series_id FROM sc_series s WHERE NOT EXISTS (SELECT 1 FROM sc_definition_versions d WHERE d.series_id=s.series_id) LIMIT 20',
      )
      .all<{ series_id: string }>();
    for (const row of series.results)
      await db.prepare('DELETE FROM sc_series WHERE series_id=?').bind(row.series_id).run();
    if (definitions.results.length || series.results.length) return true;
  }
  return false;
}
