import { isGPU } from './gpu';
import { ingestGPUPage } from './gpu-store';
import { parseEvidence, comparisonKey } from './adapters';
import { assertPersistenceAllowed } from './policy';
import { batches, hash, stable, D } from './util';
import type { CollectorEnv, Evidence, Observation, Source, AIPrice, FXRate } from './schema';
import { crossRate } from './fx';
import { publish, type Change } from './publication';
import type { DriftStage } from './schema-drift';
function legacyTable(dataset: string) {
  if (dataset === 'fx') return 'fx_observations';
  if (dataset === 'ai_api_prices') return 'ai_api_prices';
  throw new Error('unsupported_legacy_dataset');
}
export const PARSER_VERSION = '20260927.1';
function changedComponents(previous: Observation, current: Observation) {
  if (current.dataset === 'fx')
    return [
      {
        component: 'rate',
        before: (previous.domain as FXRate).rate_decimal,
        after: (current.domain as FXRate).rate_decimal,
      },
    ];
  if (current.dataset !== 'ai_api_prices' || previous.dataset !== 'ai_api_prices')
    throw new Error('unsupported_legacy_dataset');
  const a = previous.domain as AIPrice,
    b = current.domain as AIPrice;
  return b.price_components.map((c) => ({
    component: c.component_type,
    before:
      a.price_components.find((x) => x.component_type === c.component_type)?.amount_decimal ?? null,
    after: c.amount_decimal,
  }));
}
export async function ingestEvidence(
  env: CollectorEnv,
  s: Source,
  run: string,
  scheduled: string,
  artifactRef: string,
  evidence: Evidence,
  now: string,
  parser = PARSER_VERSION,
  onStage?: (stage: DriftStage) => void,
) {
  if (isGPU(s.dataset_type))
    return ingestGPUPage(env, s, run, scheduled, artifactRef, evidence, now, parser);
  await assertPersistenceAllowed(env, s, now);
  if (evidence.source_id !== s.source_id || (await hash(evidence.body)) !== evidence.evidence_hash)
    throw new Error('evidence_integrity_failure');
  if (evidence.source_policy_version !== s.policy.version)
    throw new Error('evidence_policy_mismatch');
  if (
    Date.parse(evidence.observed_at) +
      Math.min(s.policy.retention_days, s.policy.retention_limit_days ?? Infinity) * 86400000 <=
    Date.parse(now)
  )
    throw new Error('evidence_retention_expired');
  if (evidence.synthetic && env.ENVIRONMENT !== 'test') throw new Error('synthetic_data_blocked');
  if (evidence.observed_at > now) throw new Error('future_observation');
  onStage?.('parser');
  const parsed = parseEvidence(s, evidence);
  if (!parsed.candidates.length) throw new Error('empty_parsed_result');
  if (parsed.candidates.length > s.max_records) throw new Error('record_limit_exceeded');
  onStage?.('private_store');
  const sourceState = await env.PRIVATE_DB.prepare(
    'SELECT last_count FROM sources WHERE source_id=?',
  )
    .bind(s.source_id)
    .first<{ last_count: number }>();
  const incomplete =
    parsed.issues.length > 0 ||
    (sourceState &&
      sourceState.last_count > 0 &&
      parsed.candidates.length < sourceState.last_count * 0.8);
  const observations: Observation[] = [],
    changes: Change[] = [],
    statements: D1PreparedStatement[] = [];
  for (const c of parsed.candidates) {
    if (c.dataset === 'ai_api_prices')
      c.entity_key += ':' + (await hash(comparisonKey(c))).slice(0, 16);
    const fingerprint = await hash(stable({ domain: c.domain, source_date: c.source_date }));
    const id = await hash(
      run + '|' + c.entity_key + '|' + parser + '|' + s.policy.version + '|' + fingerprint,
    );
    const existing = await env.PRIVATE_DB.prepare(
      'SELECT metadata_json FROM observations WHERE observation_id=?',
    )
      .bind(id)
      .first<{ metadata_json: string }>();
    if (existing) {
      const meta = JSON.parse(existing.metadata_json);
      const table = legacyTable(c.dataset);
      const row = await env.PRIVATE_DB.prepare(
        'SELECT domain_json FROM ' + table + ' WHERE observation_id=?',
      )
        .bind(id)
        .first<{ domain_json: string }>();
      if (!row) throw new Error('missing_domain_row');
      observations.push({ ...meta, domain: JSON.parse(row.domain_json) });
      continue;
    }
    const priorRow = await env.PRIVATE_DB.prepare(
      "SELECT metadata_json,observation_id FROM observations WHERE source_id=? AND entity_key=? AND quality_status='accepted' AND observed_at<=? ORDER BY observed_at DESC,recorded_at DESC,observation_id DESC LIMIT 1",
    )
      .bind(s.source_id, c.entity_key, evidence.observed_at)
      .first<{ metadata_json: string; observation_id: string }>();
    let prior: Observation | null = null;
    if (priorRow) {
      const table = legacyTable(c.dataset);
      const domain = await env.PRIVATE_DB.prepare(
        'SELECT domain_json FROM ' + table + ' WHERE observation_id=?',
      )
        .bind(priorRow.observation_id)
        .first<{ domain_json: string }>();
      prior = { ...JSON.parse(priorRow.metadata_json), domain: JSON.parse(domain!.domain_json) };
    }
    const first = await env.PRIVATE_DB.prepare(
      'SELECT recorded_at FROM observations WHERE source_id=? AND entity_key=? AND fingerprint=? ORDER BY recorded_at LIMIT 1',
    )
      .bind(s.source_id, c.entity_key, fingerprint)
      .first<{ recorded_at: string }>();
    const supersedes = await env.PRIVATE_DB.prepare(
      "SELECT observation_id FROM observations WHERE run_id=? AND dataset=? AND json_extract(metadata_json,'$.source_record_key')=? ORDER BY recorded_at DESC,observation_id DESC LIMIT 1",
    )
      .bind(run, c.dataset, c.source_record_key)
      .first<{ observation_id: string }>();
    const flags = [...c.quality_flags, ...(incomplete ? ['catalog_incomplete'] : [])];
    const o: Observation = {
      ...c,
      quality_flags: flags,
      observation_id: id,
      source_id: s.source_id,
      source_policy_version: s.policy.version,
      scheduled_for: scheduled,
      observed_at: evidence.observed_at,
      first_seen_at: first?.recorded_at ?? now,
      recorded_at: now,
      native_frequency: s.native_frequency,
      source_url: s.source_url,
      raw_artifact_ref: artifactRef,
      raw_payload_hash: evidence.payload_hash,
      record_fingerprint: fingerprint,
      collector_version: '0.1.0',
      parser_version: parser,
      schema_version: '1',
      data_origin: evidence.synthetic ? 'synthetic' : 'live',
      quality_status: 'accepted',
      supersedes_observation_id: supersedes?.observation_id ?? null,
    };
    if (prior) {
      const diff = changedComponents(prior, o).filter((c) => c.before !== c.after);
      if (
        diff.some(
          (c) =>
            c.before !== null &&
            c.after !== null &&
            (new D(c.before).eq(0)
              ? new D(c.after).gt(0)
              : new D(c.after).minus(c.before).abs().div(c.before).gt('0.5')),
        )
      )
        flags.push('large_change_review');
      if (diff.length) {
        const details = diff.map((c) => ({
          ...c,
          percent_change:
            c.before !== null && c.after !== null && new D(c.before).gt(0)
              ? new D(c.after).minus(c.before).div(c.before).mul(100).toDecimalPlaces(18).toFixed()
              : null,
        }));
        changes.push({
          event_id: await hash(prior.observation_id + '|' + id),
          observation_id: id,
          previous_observation_id: prior.observation_id,
          dataset: c.dataset,
          entity_key: c.entity_key,
          observed_at: evidence.observed_at,
          details,
        });
      }
    }
    if (flags.some((f) => f !== 'zero_price_reported')) o.quality_status = 'quarantined';
    const { domain, ...metadata } = o;
    statements.push(
      env.PRIVATE_DB.prepare(
        'INSERT OR IGNORE INTO observations VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      ).bind(
        id,
        s.source_id,
        s.policy.version,
        run,
        c.dataset,
        c.entity_key,
        o.observed_at,
        now,
        fingerprint,
        parser,
        o.quality_status,
        o.supersedes_observation_id,
        stable(metadata),
      ),
    );
    if (c.dataset === 'fx') {
      const d = domain as FXRate;
      statements.push(
        env.PRIVATE_DB.prepare('INSERT OR IGNORE INTO fx_observations VALUES (?,?,?,?,?,?)').bind(
          id,
          d.base_currency,
          d.quote_currency,
          d.rate_decimal,
          c.source_date,
          stable(domain),
        ),
      );
    } else if (c.dataset === 'ai_api_prices') {
      const d = domain as AIPrice;
      statements.push(
        env.PRIVATE_DB.prepare('INSERT OR IGNORE INTO ai_api_prices VALUES (?,?,?,?)').bind(
          id,
          d.serving_provider,
          d.model_id,
          stable(domain),
        ),
      );
    }
    for (const code of flags)
      statements.push(
        env.PRIVATE_DB.prepare('INSERT OR IGNORE INTO quality_events VALUES (?,?,?,?,?)').bind(
          await hash(run + '|' + id + '|' + code),
          run,
          c.source_record_key,
          code,
          now,
        ),
      );
    observations.push(o);
  }
  for (const issue of parsed.issues)
    statements.push(
      env.PRIVATE_DB.prepare('INSERT OR IGNORE INTO quality_events VALUES (?,?,?,?,?)').bind(
        await hash(run + '|' + issue.record + '|' + issue.code + '|' + parser),
        run,
        issue.record,
        issue.code,
        now,
      ),
    );
  // One bounded atomic private batch keeps common/domain/change rows together.
  statements.push(
    ...changes.map((c) =>
      env.PRIVATE_DB.prepare('INSERT OR IGNORE INTO change_events VALUES (?,?,?,?,?,?,?)').bind(
        c.event_id,
        c.observation_id,
        c.previous_observation_id,
        c.dataset,
        c.entity_key,
        c.observed_at,
        stable(c.details),
      ),
    ),
  );
  if (statements.length > 80) throw new Error('private_batch_limit');
  const result = statements.length ? await env.PRIVATE_DB.batch(statements) : [];
  const metrics = {
    sql_statements: statements.length,
    rows_read: result.reduce((n, r) => n + (r.meta.rows_read ?? 0), 0),
    rows_written: result.reduce((n, r) => n + (r.meta.rows_written ?? 0), 0),
  };
  // Reload stored change events on replay, so a previous private/public failure loses no event.
  const persisted = await env.PRIVATE_DB.prepare(
    'SELECT c.* FROM change_events c JOIN observations o ON o.observation_id=c.observation_id WHERE o.run_id=? AND o.parser_version=? AND o.policy_version=?',
  )
    .bind(run, parser, s.policy.version)
    .all<{
      event_id: string;
      observation_id: string;
      previous_observation_id: string;
      dataset: string;
      entity_key: string;
      observed_at: string;
      details_json: string;
    }>();
  const changeRows = persisted.results.map(({ details_json, ...c }) => ({
    ...c,
    details: JSON.parse(details_json),
  }));
  const base = observations.find(
      (o) => o.dataset === 'fx' && o.entity_key === 'EUR/USD' && o.quality_status === 'accepted',
    ),
    quote = observations.find(
      (o) => o.dataset === 'fx' && o.entity_key === 'EUR/JPY' && o.quality_status === 'accepted',
    );
  if (base && quote) {
    const id = await hash(base.observation_id + '|' + quote.observation_id + '|fx-cross-v1');
    await env.PRIVATE_DB.batch([
      env.PRIVATE_DB.prepare(
        'INSERT OR IGNORE INTO derived_observations VALUES (?,?,?,?,?,?,?,?)',
      ).bind(
        id,
        run,
        'fx',
        'USD/JPY',
        base.observed_at,
        now,
        'fx-cross-v1',
        stable({
          base_currency: 'USD',
          quote_currency: 'JPY',
          rate_decimal: crossRate(base, quote, now),
        }),
      ),
      ...[base, quote].map((o) =>
        env.PRIVATE_DB.prepare('INSERT OR IGNORE INTO lineage VALUES (?,?)').bind(
          id,
          o.observation_id,
        ),
      ),
    ]);
  }
  await assertPersistenceAllowed(env, s, now);
  const archive = stable({
    schema_version: '1',
    source_id: s.source_id,
    policy: s.policy,
    run_id: run,
    scheduled_for: scheduled,
    parser_version: parser,
    observations,
    changes: changeRows,
  });
  await env.EVIDENCE.put(
    'archive/' + s.source_id + '/' + run + '/' + parser + '-' + s.policy.version + '.json',
    archive,
    {
      onlyIf: { etagDoesNotMatch: '*' },
      httpMetadata: { contentType: 'application/json' },
      customMetadata: { sha256: await hash(archive) },
    },
  );
  onStage?.('publication');
  const publication = await publish(env, s, run, parser, observations, changeRows, now);
  const accepted = observations.filter((o) => o.quality_status === 'accepted').length;
  await env.PUBLIC_DB.prepare(
    'UPDATE source_publications SET held_at=? WHERE source_id=? AND policy_version=?',
  )
    .bind(
      accepted < observations.length || parsed.issues.length ? now : null,
      s.source_id,
      s.policy.version,
    )
    .run();
  return {
    observations: observations.length,
    accepted,
    quarantined: observations.length - accepted,
    issues: parsed.issues.length,
    changes: changeRows.length,
    publication,
    metrics,
  };
}
