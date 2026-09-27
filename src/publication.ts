import type { CollectorEnv, Source, Observation } from './schema';
import { canPublish, canPublishDerived } from './policy';
import { batches, stable, hash } from './util';
import { crossRate } from './fx';
export const MIT_NOTICE =
  'MIT License\n\nCopyright (c) 2025 models.dev\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.';
export function publicSource(s: Source) {
  return {
    source_id: s.source_id,
    operator: s.operator,
    source_url: s.source_url,
    documentation_url: s.documentation_url,
    license_url: s.license_url,
    attribution: s.attribution_text,
    rights: s.policy.rights,
    rights_version: s.policy.version,
    conditions: s.policy.conditions,
    coverage: s.selection,
    limitations: s.known_limitations,
  };
}
export async function syncSource(env: CollectorEnv, s: Source, now: string) {
  const policy = stable(s.policy),
    policyHash = await hash(
      stable({
        policy: s.policy,
        adapter: s.adapter,
        endpoint: s.endpoint,
        selection: s.selection,
        ...(s.gpu ? { gpu: s.gpu } : {}),
      }),
    );
  const old = await env.PRIVATE_DB.prepare(
    'SELECT configuration_hash FROM source_policy_versions WHERE source_id=? AND version=?',
  )
    .bind(s.source_id, s.policy.version)
    .first<{ configuration_hash: string }>();
  if (old && old.configuration_hash !== policyHash) {
    await revokeSource(env, s.source_id);
    throw new Error('policy_version_mutated');
  }
  await env.PRIVATE_DB.batch([
    env.PRIVATE_DB.prepare('INSERT OR IGNORE INTO source_policy_versions VALUES (?,?,?,?,?)').bind(
      s.source_id,
      s.policy.version,
      policyHash,
      policy,
      now,
    ),
    env.PRIVATE_DB.prepare(
      'INSERT INTO sources(source_id,policy_version,enabled,config_json) VALUES (?,?,?,?) ON CONFLICT(source_id) DO UPDATE SET policy_version=excluded.policy_version, enabled=excluded.enabled, config_json=excluded.config_json',
    ).bind(s.source_id, s.policy.version, s.enabled ? 1 : 0, stable(s)),
  ]);
  await env.PUBLIC_DB.batch([
    env.PUBLIC_DB.prepare(
      'UPDATE source_publications SET active=0 WHERE source_id=? AND policy_version<>?',
    ).bind(s.source_id, s.policy.version),
    env.PUBLIC_DB.prepare(
      'INSERT INTO source_publications(source_id,policy_version,active,derived_allowed,valid_from,valid_until,public_json) VALUES (?,?,?,?,?,?,?) ON CONFLICT(source_id,policy_version) DO UPDATE SET active=CASE WHEN source_publications.revoked=1 THEN 0 ELSE excluded.active END, derived_allowed=excluded.derived_allowed, valid_from=excluded.valid_from, valid_until=excluded.valid_until, public_json=excluded.public_json',
    ).bind(
      s.source_id,
      s.policy.version,
      canPublish(s, now) ? 1 : 0,
      canPublish(s, now, true) ? 1 : 0,
      s.policy.valid_from,
      s.policy.valid_until,
      stable(publicSource(s)),
    ),
  ]);
}
export async function revokeSource(env: CollectorEnv, id: string) {
  // Public denial first; if the second DB fails, records still cannot leak.
  await env.PUBLIC_DB.prepare('UPDATE source_publications SET active=0,revoked=1 WHERE source_id=?')
    .bind(id)
    .run();
  await env.PRIVATE_DB.prepare('UPDATE sources SET suspended=1 WHERE source_id=?').bind(id).run();
}
export function publicObservation(o: Observation, s: Source, batch: string) {
  return {
    observation_id: o.observation_id,
    data_origin: o.data_origin,
    entity_key: o.entity_key,
    dataset: o.dataset,
    schema_version: '1',
    dataset_version: batch,
    observed_at: o.observed_at,
    ...(o.backfill !== undefined ? { backfill: o.backfill } : {}),
    source_date: o.source_date,
    source_published_at: o.source_published_at,
    source_effective_at: o.source_effective_at,
    recorded_at: o.recorded_at,
    first_seen_at: o.first_seen_at,
    supersedes_observation_id: o.supersedes_observation_id,
    observation_basis: o.observation_basis,
    value: o.domain,
    currency: 'currency' in o.domain ? o.domain.currency : null,
    unit: o.dataset === 'fx' ? 'quote_currency_per_EUR' : 'component_specific',
    source: {
      source_id: s.source_id,
      source_url: s.source_url,
      operator: s.operator,
      secondary: s.adapter === 'models_dev' || s.adapter === 'price_of_compute',
    },
    attribution: s.attribution_text,
    methodology:
      o.dataset === 'fx'
        ? 'ecb-original-v1'
        : o.dataset === 'ai_api_prices'
          ? 'api-catalog-v1'
          : 'gpu-market-v1',
    quality_status: o.quality_status,
    quality_flags: o.quality_flags,
    coverage: { selection: s.selection, market_representative: false },
    rights_version: s.policy.version,
    reuse: {
      license_url: s.license_url,
      conditions: s.policy.conditions,
      notice: s.adapter === 'models_dev' ? MIT_NOTICE : null,
    },
  };
}
export type Change = {
  event_id: string;
  observation_id: string;
  previous_observation_id: string;
  dataset: string;
  entity_key: string;
  observed_at: string;
  details: unknown;
};
export async function publish(
  env: CollectorEnv,
  s: Source,
  run: string,
  parser: string,
  observations: Observation[],
  changes: Change[],
  now: string,
) {
  const batch = await hash(run + '|' + parser + '|' + s.policy.version);
  if (!canPublish(s, now)) return { published: 0, batch };
  await env.PUBLIC_DB.prepare(
    "INSERT OR IGNORE INTO publication_batches VALUES (?,?,?,'staging',?,NULL)",
  )
    .bind(batch, s.source_id, s.policy.version, now)
    .run();
  const accepted = observations.filter((o) => o.quality_status === 'accepted');
  const statements: D1PreparedStatement[] = [];
  for (const o of accepted)
    statements.push(
      env.PUBLIC_DB.prepare(
        'INSERT OR IGNORE INTO published_observations(observation_id,batch_id,source_id,policy_version,dataset,entity_key,observed_at,recorded_at,supersedes_observation_id,derived,public_json) VALUES (?,?,?,?,?,?,?,?,?,0,?)',
      ).bind(
        o.observation_id,
        batch,
        s.source_id,
        s.policy.version,
        o.dataset,
        o.entity_key,
        o.observed_at,
        o.recorded_at,
        o.supersedes_observation_id,
        stable(publicObservation(o, s, batch)),
      ),
    );
  await batches(env.PUBLIC_DB, statements);
  let derivedCount = 0;
  const base = accepted.find((o) => o.dataset === 'fx' && o.entity_key === 'EUR/USD');
  const quote = accepted.find((o) => o.dataset === 'fx' && o.entity_key === 'EUR/JPY');
  if (base && quote) {
    const value = crossRate(base, quote, now),
      id = await hash(base.observation_id + '|' + quote.observation_id + '|fx-cross-v1');
    const domain = {
      base_currency: 'USD',
      quote_currency: 'JPY',
      rate_decimal: value,
      calendar: 'TARGET',
      reference_rate_type: 'project_calculation',
    };
    await env.PRIVATE_DB.batch([
      env.PRIVATE_DB.prepare(
        'INSERT OR IGNORE INTO derived_observations VALUES (?,?,?,?,?,?,?,?)',
      ).bind(id, run, 'fx', 'USD/JPY', base.observed_at, now, 'fx-cross-v1', stable(domain)),
      ...[base, quote].map((o) =>
        env.PRIVATE_DB.prepare('INSERT OR IGNORE INTO lineage VALUES (?,?)').bind(
          id,
          o.observation_id,
        ),
      ),
    ]);
    if (canPublishDerived([s, s], now)) {
      const data = {
        ...publicObservation(base, s, batch),
        observation_id: id,
        entity_key: 'USD/JPY',
        value: domain,
        unit: 'quote_currency_per_USD',
        recorded_at: now,
        methodology: 'fx-cross-v1',
        observation_basis: 'derived',
        attribution:
          'Calculated by AI-Investment-APIs using ECB statistics; not an ECB-published cross rate. Original data is free from ECB.',
        lineage: [base.observation_id, quote.observation_id],
        supersedes_observation_id: null,
      };
      await env.PUBLIC_DB.batch([
        env.PUBLIC_DB.prepare(
          'INSERT OR IGNORE INTO published_observations(observation_id,batch_id,source_id,policy_version,dataset,entity_key,observed_at,recorded_at,derived,public_json) VALUES (?,?,?,?,?,?,?,?,1,?)',
        ).bind(
          id,
          batch,
          s.source_id,
          s.policy.version,
          'fx',
          'USD/JPY',
          base.observed_at,
          now,
          stable(data),
        ),
        ...[base, quote].map((o) =>
          env.PUBLIC_DB.prepare('INSERT OR IGNORE INTO published_lineage VALUES (?,?,?,?)').bind(
            id,
            o.observation_id,
            s.source_id,
            s.policy.version,
          ),
        ),
      ]);
      derivedCount = 1;
    }
  }
  const allowed = new Set(accepted.map((o) => o.observation_id));
  await batches(
    env.PUBLIC_DB,
    changes
      .filter((c) => allowed.has(c.observation_id) && canPublish(s, now, true))
      .map((c) =>
        env.PUBLIC_DB.prepare(
          'INSERT OR IGNORE INTO published_changes(event_id,observation_id,dataset,entity_key,observed_at,public_json) VALUES (?,?,?,?,?,?)',
        ).bind(
          c.event_id,
          c.observation_id,
          c.dataset,
          c.entity_key,
          c.observed_at,
          stable({
            ...c,
            schema_version: '1',
            source: { source_id: s.source_id, source_url: s.source_url },
            attribution: s.attribution_text,
            methodology: 'same-series-change-v1',
            calculated_by: 'AI-Investment-APIs',
            reuse: {
              license_url: s.license_url,
              conditions: s.policy.conditions,
              notice: s.adapter === 'models_dev' ? MIT_NOTICE : null,
            },
          }),
        ),
      ),
  );
  await env.PUBLIC_DB.prepare(
    "UPDATE publication_batches SET state='complete',completed_at=? WHERE batch_id=? AND state='staging'",
  )
    .bind(now, batch)
    .run();
  return { published: accepted.length + derivedCount, batch };
}
// All API data paths share this condition, including changes/latest/health/FX.
export const visibleSQL =
  "(o.snapshot_id IS NULL OR EXISTS(SELECT 1 FROM published_coverage gc WHERE gc.snapshot_id=o.snapshot_id AND gc.state='complete')) AND b.state='complete' AND p.active=1 AND p.revoked=0 AND p.valid_from<=? AND (p.valid_until IS NULL OR p.valid_until>?) AND (o.derived=0 OR p.derived_allowed=1) AND NOT EXISTS (SELECT 1 FROM published_lineage l LEFT JOIN source_publications ip ON ip.source_id=l.source_id AND ip.policy_version=l.policy_version WHERE l.observation_id=o.observation_id AND (ip.source_id IS NULL OR ip.active<>1 OR ip.revoked=1 OR ip.derived_allowed<>1 OR ip.valid_from>? OR (ip.valid_until IS NOT NULL AND ip.valid_until<=?)))";
export const visibleJoin =
  ' FROM published_observations o JOIN publication_batches b ON o.batch_id=b.batch_id JOIN source_publications p ON o.source_id=p.source_id AND o.policy_version=p.policy_version ';
