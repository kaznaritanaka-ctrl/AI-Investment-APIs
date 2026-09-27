import type { CollectorEnv, Source, Evidence, Observation } from './schema';
import { parseGPUProjection } from './gpu-adapters';
import { gpuAmount, gpuComparison, gpuExclusions, GPU_METHOD, type GPUDomain } from './gpu';
import { assertPersistenceAllowed, canPublish } from './policy';
import { publicObservation } from './publication';
import { hash, stable, D, batches } from './util';
export const GPU_PARSER = 'gpu-20260927.1';
export type Snapshot = {
  snapshot_id: string;
  run_id: string;
  source_id: string;
  policy_version: string;
  dataset: 'gpu_rental' | 'gpu_secondary';
  partition_id: string;
  scope_hash: string;
  scope_json: string;
  state: string;
  reason: string | null;
  started_at: string;
  completed_at: string | null;
  next_page: number | null;
  reported_total: number | null;
  received_count: number;
  duplicate_count: number;
  data_origin: string;
  processing_stage: string;
  finalize_cursor: string;
  next_attempt_at: string | null;
  revises_snapshot_id: string | null;
  review_ref: string | null;
};
export async function snapshot(env: CollectorEnv, id: string) {
  const row = await env.PRIVATE_DB.prepare('SELECT * FROM gpu_snapshots WHERE snapshot_id=?')
    .bind(id)
    .first<Snapshot>();
  if (!row) throw new Error('snapshot_missing');
  return row;
}
export function amountSort(amount: string | null) {
  if (amount === null) return null;
  const v = new D(amount).toFixed();
  return v.split('.')[0].length.toString().padStart(3, '0') + ':' + v;
}
export async function ingestGPUPage(
  env: CollectorEnv,
  s: Source,
  run: string,
  scheduled: string,
  artifact: string,
  e: Evidence,
  now: string,
  parser = GPU_PARSER,
) {
  await assertPersistenceAllowed(env, s, now);
  const page = e.gpu_page;
  if (
    !page ||
    e.source_id !== s.source_id ||
    e.source_policy_version !== s.policy.version ||
    (await hash(e.body)) !== e.evidence_hash
  )
    throw new Error('gpu_evidence_integrity');
  if (e.synthetic && env.ENVIRONMENT !== 'test') throw new Error('synthetic_data_blocked');
  if (
    e.observed_at > now ||
    Date.parse(e.observed_at) + s.gpu!.retention.evidence_days! * 86400000 <= Date.parse(now)
  )
    throw new Error('evidence_time_invalid');
  const snap = await snapshot(env, page.snapshot_id);
  if (
    snap.run_id !== run ||
    snap.scope_hash !== page.scope_hash ||
    snap.partition_id !== page.partition_id ||
    snap.policy_version !== s.policy.version
  )
    throw new Error('gpu_scope_mismatch');
  const existingPage = await env.PRIVATE_DB.prepare(
    'SELECT state,payload_hash,evidence_hash FROM gpu_pages WHERE snapshot_id=? AND page_number=?',
  )
    .bind(snap.snapshot_id, page.page_number)
    .first<{ state: string; payload_hash: string; evidence_hash: string }>();
  if (
    existingPage &&
    (existingPage.payload_hash !== e.payload_hash || existingPage.evidence_hash !== e.evidence_hash)
  )
    throw new Error('page_evidence_changed');
  if (
    (['complete', 'purged'].includes(snap.state) || snap.next_page !== page.page_number) &&
    !existingPage
  )
    throw new Error('gpu_snapshot_sealed_or_page_order');
  const candidates = parseGPUProjection(s, e),
    observations: Observation[] = [];
  if (candidates.length > 50) throw new Error('gpu_page_processing_budget');
  let duplicates = 0;
  const writes: D1PreparedStatement[] = [];
  const keys = candidates.map((c) => c.source_record_key),
    marks = keys.map(() => '?').join(',');
  const members = keys.length
    ? (
        await env.PRIVATE_DB.prepare(
          'SELECT m.record_key,m.page_number,o.observation_id,o.metadata_json,d.domain_json FROM gpu_snapshot_members m JOIN observations o USING(observation_id) JOIN ' +
            snap.dataset +
            ' d USING(observation_id) WHERE m.snapshot_id=? AND m.record_key IN (' +
            marks +
            ')',
        )
          .bind(snap.snapshot_id, ...keys)
          .all<{
            record_key: string;
            page_number: number;
            observation_id: string;
            metadata_json: string;
            domain_json: string;
          }>()
      ).results
    : [];
  const priors = keys.length
    ? (
        await env.PRIVATE_DB.prepare(
          'WITH ranked AS (SELECT o.entity_key,o.metadata_json,d.domain_json,ROW_NUMBER() OVER(PARTITION BY o.entity_key ORDER BY o.observed_at DESC,o.recorded_at DESC) AS rn FROM observations o JOIN ' +
            snap.dataset +
            " d USING(observation_id) JOIN gpu_snapshot_members m USING(observation_id) JOIN gpu_snapshots g ON g.snapshot_id=m.snapshot_id WHERE o.source_id=? AND g.scope_hash=? AND g.state='complete' AND o.observed_at<=? AND o.entity_key IN (" +
            marks +
            ')) SELECT * FROM ranked WHERE rn=1',
        )
          .bind(
            s.source_id,
            snap.scope_hash,
            e.observed_at,
            ...keys.map((k) => snap.scope_hash.slice(0, 16) + '|' + k),
          )
          .all<{ entity_key: string; metadata_json: string; domain_json: string }>()
      ).results
    : [];
  const seen = new Set<string>();
  for (const c of candidates) {
    const d = c.domain as GPUDomain,
      key = c.source_record_key,
      entity = snap.scope_hash.slice(0, 16) + '|' + c.source_record_key;
    c.entity_key = entity;
    const member = members.find((m) => m.record_key === key);
    if (seen.has(key) || (member && member.page_number !== page.page_number)) {
      duplicates++;
      continue;
    }
    seen.add(key);
    const id = await hash(
      snap.snapshot_id + '|' + key + '|' + parser + '|' + s.policy.version + '|' + e.evidence_hash,
    );
    if (member?.observation_id === id) {
      observations.push({
        ...JSON.parse(member.metadata_json),
        domain: JSON.parse(member.domain_json),
      });
      continue;
    }
    if (member) throw new Error('gpu_revision_snapshot_required');
    const prior = priors.find((p) => p.entity_key === entity);
    const previous: Observation | null = prior
      ? { ...JSON.parse(prior.metadata_json), domain: JSON.parse(prior.domain_json) }
      : null;
    if ('listing_id' in d) {
      d.first_seen_at = previous?.first_seen_at ?? e.observed_at;
      d.last_seen_at = e.observed_at;
    }
    const cohort = await hash(stable(gpuComparison(d))),
      exclusions = gpuExclusions(d);
    const flags = [...c.quality_flags];
    const corrected = snap.revises_snapshot_id
      ? await env.PRIVATE_DB.prepare(
          'SELECT o.observation_id,o.metadata_json FROM gpu_snapshot_members m JOIN observations o USING(observation_id) WHERE m.snapshot_id=? AND m.record_key=?',
        )
          .bind(snap.revises_snapshot_id, key)
          .first<{ observation_id: string; metadata_json: string }>()
      : null;
    const reviewed = !!snap.revises_snapshot_id && !!snap.review_ref;
    let change: Record<string, unknown> | null = null;
    if (previous) {
      const before = gpuAmount(previous.domain as GPUDomain),
        after = gpuAmount(d);
      if (stable(gpuComparison(previous.domain as GPUDomain)) !== stable(gpuComparison(d)))
        flags.push('comparison_conditions_changed');
      else if (before !== null && after !== null && !new D(before).eq(after)) {
        const pct = new D(before).gt(0)
          ? new D(after).minus(before).div(before).mul(100).toFixed()
          : null;
        if (pct === null || new D(pct).abs().gt(50))
          flags.push(
            exclusions.length
              ? 'large_change_unresolved_conditions'
              : 'confirmed_large_price_change',
          );
        change = {
          event_id: await hash(previous.observation_id + '|' + id),
          observation_id: id,
          previous_observation_id: previous.observation_id,
          dataset: c.dataset,
          entity_key: entity,
          observed_at: e.observed_at,
          event_kind: 'price_change',
          details: {
            before,
            after,
            percent_change: pct,
            conditions: gpuComparison(d),
            methodology: GPU_METHOD,
          },
        };
      }
    }
    if (previous?.quality_status === 'quarantined' && !reviewed)
      flags.push('unresolved_condition_review');
    if (reviewed) flags.push('reviewed_correction');
    if (
      flags.some((f) =>
        [
          'comparison_conditions_changed',
          'unresolved_condition_review',
          'large_change_unresolved_conditions',
        ].includes(f),
      ) &&
      !reviewed
    )
      exclusions.push('condition_change_review');
    const fingerprint = await hash(stable({ domain: d, source_date: c.source_date }));
    const o: Observation = {
      ...c,
      domain: d,
      quality_flags: flags,
      observation_id: id,
      source_id: s.source_id,
      source_policy_version: s.policy.version,
      scheduled_for: scheduled,
      observed_at: e.observed_at,
      first_seen_at: corrected
        ? JSON.parse(corrected.metadata_json).first_seen_at
        : (previous?.first_seen_at ?? e.observed_at),
      recorded_at: now,
      native_frequency: s.native_frequency,
      source_url: s.source_url,
      raw_artifact_ref: artifact,
      raw_payload_hash: e.payload_hash,
      record_fingerprint: fingerprint,
      collector_version: '0.2.0',
      parser_version: parser,
      schema_version: '1',
      snapshot_id: snap.snapshot_id,
      backfill: !!snap.revises_snapshot_id,
      data_origin: e.synthetic ? 'synthetic' : 'live',
      quality_status: exclusions.includes('condition_change_review') ? 'quarantined' : 'accepted',
      supersedes_observation_id: corrected?.observation_id ?? null,
    };
    const { domain, ...meta } = o,
      amount = gpuAmount(d);
    const sql = [
      env.PRIVATE_DB.prepare(
        'INSERT OR IGNORE INTO observations VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      ).bind(
        id,
        s.source_id,
        s.policy.version,
        run,
        c.dataset,
        entity,
        e.observed_at,
        now,
        fingerprint,
        parser,
        o.quality_status,
        o.supersedes_observation_id,
        stable(meta),
      ),
      'listing_id' in d
        ? env.PRIVATE_DB.prepare(
            'INSERT OR IGNORE INTO gpu_secondary VALUES (?,?,?,?,?,?,?,?,?)',
          ).bind(
            id,
            d.gpu_sku_id,
            d.marketplace,
            d.listing_id,
            d.currency,
            amount,
            amountSort(amount),
            cohort,
            stable(domain),
          )
        : env.PRIVATE_DB.prepare(
            'INSERT OR IGNORE INTO gpu_rental VALUES (?,?,?,?,?,?,?,?,?)',
          ).bind(
            id,
            d.gpu_sku_id,
            d.provider,
            d.region,
            d.currency,
            amount,
            amountSort(amount),
            cohort,
            stable(domain),
          ),
      env.PRIVATE_DB.prepare(
        'INSERT OR IGNORE INTO gpu_snapshot_members VALUES (?,?,?,?,?,?,?)',
      ).bind(
        snap.snapshot_id,
        key,
        id,
        page.page_number,
        cohort,
        exclusions.length ? 0 : 1,
        stable(exclusions),
      ),
    ];
    if (change)
      sql.push(
        env.PRIVATE_DB.prepare('INSERT OR IGNORE INTO change_events VALUES (?,?,?,?,?,?,?)').bind(
          change.event_id,
          id,
          change.previous_observation_id,
          c.dataset,
          entity,
          e.observed_at,
          stable(change.details),
        ),
      );
    // Flush only at record boundaries, at most twenty statements per atomic batch.
    if (writes.length + sql.length > 20) {
      await env.PRIVATE_DB.batch(writes.splice(0));
    }
    writes.push(...sql);
    observations.push(o);
  }
  if (writes.length) await env.PRIVATE_DB.batch(writes);
  await assertPersistenceAllowed(env, s, now);
  const archive = stable({
    schema_version: '1',
    snapshot_id: snap.snapshot_id,
    page_number: page.page_number,
    observations,
  });
  const archiveRef =
    'archive/' +
    s.source_id +
    '/' +
    snap.snapshot_id +
    '/' +
    page.page_number +
    '-' +
    parser +
    '.json';
  await env.EVIDENCE.put(archiveRef, archive, {
    onlyIf: { etagDoesNotMatch: '*' },
    httpMetadata: { contentType: 'application/json' },
  });
  await env.PRIVATE_DB.prepare(
    'INSERT OR IGNORE INTO raw_artifacts(artifact_ref,source_id,run_id,observed_at,payload_hash,evidence_hash,bytes,expires_at) VALUES (?,?,?,?,?,?,?,?)',
  )
    .bind(
      archiveRef,
      s.source_id,
      run,
      e.observed_at,
      await hash(archive),
      await hash(archive),
      new TextEncoder().encode(archive).length,
      new Date(Date.parse(e.observed_at) + s.gpu!.retention.archive_days! * 86400000).toISOString(),
    )
    .run();
  await stageGPUPage(env, s, snap, observations, now);
  if (!existingPage) {
    const mismatch =
      snap.reported_total !== null &&
      page.reported_total !== null &&
      snap.reported_total !== page.reported_total;
    const issues = [
      ...page.issues,
      ...(mismatch ? ['reported_total_changed_during_capture'] : []),
      ...(duplicates ? ['duplicate_records_across_pages'] : []),
    ];
    await env.PRIVATE_DB.batch([
      env.PRIVATE_DB.prepare('INSERT INTO gpu_pages VALUES (?,?,?,?,?,?,?,?,?,?)').bind(
        snap.snapshot_id,
        page.page_number,
        artifact,
        issues.length ? 'partial' : 'complete',
        e.observed_at,
        page.next_page,
        page.received_count,
        page.reported_total,
        e.payload_hash,
        e.evidence_hash,
      ),
      env.PRIVATE_DB.prepare(
        'UPDATE gpu_snapshots SET next_page=?,reported_total=COALESCE(reported_total,?),received_count=received_count+?,duplicate_count=duplicate_count+?,state=?,reason=?,processing_stage=? WHERE snapshot_id=?',
      ).bind(
        page.next_page,
        page.reported_total,
        page.received_count,
        duplicates,
        issues.length ? 'quarantined' : 'collecting',
        issues[0] ?? null,
        page.next_page === null ? 'lifecycle' : 'pages',
        snap.snapshot_id,
      ),
    ]);
  }
  return {
    observations: observations.length,
    accepted: observations.length,
    quarantined: 0,
    issues: page.issues.length,
    changes: 0,
    publication: { published: 0, batch: snap.snapshot_id },
    metrics: { sql_statements: candidates.length * 4 },
  };
}
async function stageGPUPage(
  env: CollectorEnv,
  s: Source,
  snap: Snapshot,
  observations: Observation[],
  now: string,
) {
  if (!canPublish(s, now)) return;
  await env.PUBLIC_DB.prepare(
    "INSERT OR IGNORE INTO publication_batches VALUES (?,?,?,'staging',?,NULL)",
  )
    .bind(snap.snapshot_id, s.source_id, s.policy.version, now)
    .run();
  const rows = observations.filter(
    (o) =>
      o.quality_status === 'accepted' &&
      (!('price_scope' in o.domain) || o.domain.price_scope !== 'account_specific'),
  );
  await batches(
    env.PUBLIC_DB,
    rows.map((o) => {
      const d = o.domain as GPUDomain,
        rental = 'offer_id' in d;
      return env.PUBLIC_DB.prepare(
        'INSERT OR IGNORE INTO published_observations(observation_id,batch_id,source_id,policy_version,dataset,entity_key,observed_at,recorded_at,supersedes_observation_id,derived,public_json,snapshot_id,gpu_sku_id,provider,country,region,contract_type,item_condition,basis) VALUES (?,?,?,?,?,?,?,?,?,0,?,?,?,?,?,?,?,?,?)',
      ).bind(
        o.observation_id,
        snap.snapshot_id,
        s.source_id,
        s.policy.version,
        o.dataset,
        o.entity_key,
        o.observed_at,
        o.recorded_at,
        o.supersedes_observation_id,
        stable({
          ...publicObservation(o, s, snap.snapshot_id),
          snapshot_id: snap.snapshot_id,
          methodology: GPU_METHOD,
          currency: d.currency,
          unit: rental ? d.billing_unit : 'listing_lot',
          statistical_exclusions: gpuExclusions(d),
        }),
        snap.snapshot_id,
        d.gpu_sku_id,
        rental ? d.provider : d.marketplace,
        rental ? d.country : d.item_location.country,
        rental ? d.region : null,
        rental ? d.contract_type : null,
        rental ? null : d.condition,
        d.observation_basis,
      );
    }),
  );
  if (canPublish(s, now, true)) {
    const changes = rows.length
      ? (
          await env.PRIVATE_DB.prepare(
            'SELECT * FROM change_events WHERE observation_id IN (' +
              rows.map(() => '?').join(',') +
              ')',
          )
            .bind(...rows.map((o) => o.observation_id))
            .all<{
              event_id: string;
              observation_id: string;
              previous_observation_id: string;
              details_json: string;
            }>()
        ).results
      : [];
    for (const o of rows) {
      const change = changes.find((c) => c.observation_id === o.observation_id);
      if (change)
        await env.PUBLIC_DB.prepare(
          'INSERT OR IGNORE INTO published_changes(event_id,observation_id,dataset,entity_key,observed_at,public_json,snapshot_id,event_kind) SELECT ?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM published_observations WHERE observation_id=?)',
        )
          .bind(
            change.event_id,
            o.observation_id,
            o.dataset,
            o.entity_key,
            o.observed_at,
            stable({
              event_id: change.event_id,
              event_kind: 'price_change',
              dataset: o.dataset,
              entity_key: o.entity_key,
              snapshot_id: snap.snapshot_id,
              observation_id: o.observation_id,
              previous_observation_id: change.previous_observation_id,
              observed_at: o.observed_at,
              recorded_at: o.recorded_at,
              details: JSON.parse(change.details_json),
              methodology: GPU_METHOD,
              source: { source_id: s.source_id, source_url: s.source_url },
              attribution: s.attribution_text,
            }),
            snap.snapshot_id,
            'price_change',
            change.previous_observation_id,
          )
          .run();
    }
  }
}
export async function previousSnapshot(env: CollectorEnv, snap: Snapshot) {
  return env.PRIVATE_DB.prepare(
    "SELECT * FROM gpu_snapshots WHERE source_id=? AND scope_hash=? AND state='complete' AND snapshot_id<>? AND started_at<? ORDER BY started_at DESC,completed_at DESC LIMIT 1",
  )
    .bind(snap.source_id, snap.scope_hash, snap.snapshot_id, snap.started_at)
    .first<Snapshot>();
}
export async function publishCoverage(env: CollectorEnv, s: Source, snap: Snapshot, now: string) {
  if (!canPublish(s, now)) return;
  const counts = await env.PRIVATE_DB.prepare(
    'SELECT COUNT(*) AS observed,COALESCE(SUM(eligible),0) AS eligible FROM gpu_snapshot_members WHERE snapshot_id=?',
  )
    .bind(snap.snapshot_id)
    .first<{ observed: number; eligible: number }>();
  const pages = await env.PRIVATE_DB.prepare(
    'SELECT COUNT(*) AS n,MAX(observed_at) AS last FROM gpu_pages WHERE snapshot_id=?',
  )
    .bind(snap.snapshot_id)
    .first<{ n: number; last: string | null }>();
  const prior = snap.state === 'complete' ? await previousSnapshot(env, snap) : null;
  const warning =
    prior && prior.received_count > 0 && snap.received_count < prior.received_count * 0.8
      ? 'confirmed_observed_count_decline'
      : null;
  const data = {
    snapshot_id: snap.snapshot_id,
    source_id: s.source_id,
    dataset: snap.dataset,
    data_origin: snap.data_origin,
    scope_hash: snap.scope_hash,
    revises_snapshot_id: snap.revises_snapshot_id,
    correction: !!snap.revises_snapshot_id,
    scope: JSON.parse(snap.scope_json),
    coverage: snap.state === 'complete' ? 'complete' : 'partial',
    state: snap.state,
    missing_reason: snap.reason,
    started_at: snap.started_at,
    observed_at: pages?.last ?? null,
    completed_at: snap.completed_at,
    page_count: pages?.n ?? 0,
    source_reported_total: snap.reported_total,
    received_api_records: snap.received_count,
    observed_offer_count: counts?.observed ?? 0,
    statistically_eligible_count: counts?.eligible ?? 0,
    duplicate_count: snap.duplicate_count,
    warnings: warning ? [warning] : [],
    methodology: GPU_METHOD,
    market_representative: false,
    inventory_interpretation: false,
    attribution: s.attribution_text,
    rights_version: s.policy.version,
  };
  await env.PUBLIC_DB.prepare(
    'INSERT INTO published_coverage(snapshot_id,source_id,policy_version,dataset,scope_hash,state,observed_at,recorded_at,completed_at,public_json) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(snapshot_id) DO UPDATE SET state=excluded.state,observed_at=excluded.observed_at,recorded_at=excluded.recorded_at,completed_at=excluded.completed_at,public_json=excluded.public_json WHERE published_coverage.public_json<>excluded.public_json',
  )
    .bind(
      snap.snapshot_id,
      s.source_id,
      s.policy.version,
      snap.dataset,
      snap.scope_hash,
      snap.state,
      pages?.last ?? snap.started_at,
      now,
      snap.completed_at,
      stable(data),
    )
    .run();
}
// Bounded finalization: each invocation records at most 50 disappearances.
export async function finalizeGPU(env: CollectorEnv, s: Source, snap: Snapshot, now: string) {
  await assertPersistenceAllowed(env, s, now);
  const prior = await previousSnapshot(env, snap);
  const missing = prior
    ? await env.PRIVATE_DB.prepare(
        'SELECT m.record_key,m.observation_id FROM gpu_snapshot_members m WHERE m.snapshot_id=? AND m.record_key>? AND NOT EXISTS(SELECT 1 FROM gpu_snapshot_members n WHERE n.snapshot_id=? AND n.record_key=m.record_key) ORDER BY m.record_key LIMIT 50',
      )
        .bind(prior.snapshot_id, snap.finalize_cursor, snap.snapshot_id)
        .all<{ record_key: string; observation_id: string }>()
    : { results: [] };
  for (const m of missing.results) {
    const id = await hash(snap.snapshot_id + '|not_seen|' + m.record_key);
    await env.PRIVATE_DB.prepare(
      "INSERT OR IGNORE INTO gpu_lifecycle_events VALUES (?,?,?,?,'not_seen',?,?)",
    )
      .bind(id, snap.snapshot_id, m.observation_id, m.record_key, snap.started_at, now)
      .run();
    if (canPublish(s, now, true))
      await env.PUBLIC_DB.prepare(
        "INSERT OR IGNORE INTO published_changes(event_id,observation_id,dataset,entity_key,observed_at,public_json,snapshot_id,event_kind) SELECT ?,?,?,?,?,?,?,'not_seen' WHERE EXISTS(SELECT 1 FROM published_observations WHERE observation_id=?)",
      )
        .bind(
          id,
          m.observation_id,
          snap.dataset,
          m.record_key,
          snap.started_at,
          stable({
            event_id: id,
            event_kind: 'not_seen',
            dataset: snap.dataset,
            entity_key: snap.scope_hash.slice(0, 16) + '|' + m.record_key,
            details: { state: 'not_seen', sold: false },
            observation_id: m.observation_id,
            previous_observation_id: m.observation_id,
            previous_snapshot_id: prior!.snapshot_id,
            snapshot_id: snap.snapshot_id,
            observed_at: snap.started_at,
            recorded_at: now,
            meaning: 'not_seen_in_same_complete_search_scope',
            sold: false,
            methodology: GPU_METHOD,
            source: { source_id: s.source_id, source_url: s.source_url },
            attribution: s.attribution_text,
          }),
          snap.snapshot_id,
          m.observation_id,
        )
        .run();
  }
  if (missing.results.length === 50) {
    await env.PRIVATE_DB.prepare('UPDATE gpu_snapshots SET finalize_cursor=? WHERE snapshot_id=?')
      .bind(missing.results.at(-1)!.record_key, snap.snapshot_id)
      .run();
    return false;
  }
  await env.PRIVATE_DB.prepare(
    "UPDATE gpu_snapshots SET state='complete',completed_at=?,reason=NULL,processing_stage='metrics' WHERE snapshot_id=?",
  )
    .bind(now, snap.snapshot_id)
    .run();
  const completed = await snapshot(env, snap.snapshot_id);
  await publishCoverage(env, s, completed, now);
  // Single publication commit after every page and lifecycle event has been staged.
  if (canPublish(s, now))
    await env.PUBLIC_DB.prepare(
      "UPDATE publication_batches SET state='complete',completed_at=? WHERE batch_id=? AND state='staging'",
    )
      .bind(now, snap.snapshot_id)
      .run();
  return true;
}
