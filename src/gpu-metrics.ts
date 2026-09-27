import type { CollectorEnv, Source } from './schema';
import type { Snapshot } from './gpu-store';
import { gpuComparison, GPU_METHOD, type GPUDomain } from './gpu';
import { assertPersistenceAllowed, canPublish } from './policy';
import { D, hash, stable } from './util';
import { buildComparisons } from './gpu-comparisons';
export type GPUStats = {
  metric_id: string;
  kind: string;
  dataset: string;
  snapshot_id: string;
  cohort_key: string;
  gpu_sku_id: string | null;
  observed_at: string;
  recorded_at: string;
  data_origin: string;
  methodology: string;
  conditions: ReturnType<typeof gpuComparison>;
  sample_count: number;
  observed_offer_count: number;
  [key: string]: unknown;
};
export type MetricInput = {
  snapshot_id: string | null;
  observation_id: string | null;
  source_id: string;
  policy_version: string;
};
export async function saveGPUMetric(
  env: CollectorEnv,
  s: Source,
  snap: Snapshot,
  data: GPUStats,
  inputs: MetricInput[],
  now: string,
) {
  await assertPersistenceAllowed(env, s, now);
  await env.PRIVATE_DB.prepare(
    'INSERT OR IGNORE INTO derived_observations VALUES (?,?,?,?,?,?,?,?)',
  )
    .bind(
      data.metric_id,
      snap.run_id,
      snap.dataset,
      data.cohort_key,
      data.observed_at,
      data.recorded_at,
      GPU_METHOD,
      stable(data),
    )
    .run();
  for (const input of inputs)
    await env.PRIVATE_DB.prepare('INSERT OR IGNORE INTO gpu_metric_lineage VALUES (?,?,?,?,?,?)')
      .bind(
        data.metric_id,
        input.snapshot_id,
        input.observation_id,
        input.source_id,
        input.policy_version,
        input.snapshot_id ?? input.observation_id,
      )
      .run();
  if (
    !canPublish(s, now, true) ||
    ('price_scope' in data.conditions && data.conditions.price_scope === 'account_specific')
  )
    return;
  // Do not copy a derived value into the public DB unless every input is publishable.
  for (const input of inputs) {
    const permit = await env.PUBLIC_DB.prepare(
      'SELECT 1 AS ok FROM source_publications WHERE source_id=? AND policy_version=? AND active=1 AND revoked=0 AND derived_allowed=1 AND valid_from<=? AND (valid_until IS NULL OR valid_until>?)',
    )
      .bind(input.source_id, input.policy_version, now, now)
      .first();
    if (!permit) return;
  }
  // All input rights are checked again on every public read.
  await env.PUBLIC_DB.prepare(
    "INSERT OR IGNORE INTO published_gpu_metrics(metric_id,snapshot_id,source_id,policy_version,dataset,cohort_key,gpu_sku_id,observed_at,recorded_at,state,public_json) VALUES (?,?,?,?,?,?,?,?,?,'staging',?)",
  )
    .bind(
      data.metric_id,
      snap.snapshot_id,
      s.source_id,
      s.policy.version,
      snap.dataset,
      data.cohort_key,
      data.gpu_sku_id,
      data.observed_at,
      data.recorded_at,
      stable({
        ...data,
        source: { source_id: s.source_id, source_url: s.source_url },
        attribution: s.attribution_text,
        rights_version: s.policy.version,
        input_refs: inputs,
      }),
    )
    .run();
  for (const input of inputs)
    await env.PUBLIC_DB.prepare(
      'INSERT OR IGNORE INTO published_metric_lineage VALUES (?,?,?,?,?,?)',
    )
      .bind(
        data.metric_id,
        input.snapshot_id ?? input.observation_id,
        input.snapshot_id,
        input.observation_id,
        input.source_id,
        input.policy_version,
      )
      .run();
  await env.PUBLIC_DB.prepare("UPDATE published_gpu_metrics SET state='complete' WHERE metric_id=?")
    .bind(data.metric_id)
    .run();
}
export function percentChange(before: string | null, after: string | null) {
  return before !== null && after !== null && new D(before).gt(0)
    ? new D(after).minus(before).div(before).mul(100).toFixed()
    : null;
}
async function quantile(
  env: CollectorEnv,
  table: string,
  where: string,
  args: unknown[],
  n: number,
  q: number,
) {
  if (!n) return null;
  const pos = (n - 1) * q,
    low = Math.floor(pos),
    high = Math.ceil(pos);
  const rows = await env.PRIVATE_DB.prepare(
    'SELECT d.amount_decimal FROM ' +
      table +
      ' d JOIN gpu_snapshot_members a ON a.observation_id=d.observation_id WHERE ' +
      where +
      ' ORDER BY d.amount_sort,d.observation_id LIMIT ? OFFSET ?',
  )
    .bind(...args, high - low + 1, low)
    .all<{ amount_decimal: string }>();
  if (rows.results.length !== high - low + 1) throw new Error('metric_sample_changed');
  return new D(rows.results[0].amount_decimal)
    .plus(
      new D(rows.results.at(-1)!.amount_decimal)
        .minus(rows.results[0].amount_decimal)
        .mul(new D(pos).minus(low)),
    )
    .toFixed();
}
async function stats(env: CollectorEnv, snap: Snapshot, cohort: string, matchedSnapshot?: string) {
  const match = matchedSnapshot
    ? ' AND EXISTS(SELECT 1 FROM gpu_snapshot_members b WHERE b.snapshot_id=? AND b.record_key=a.record_key AND b.cohort_key=a.cohort_key AND b.eligible=1)'
    : '';
  const where =
      'a.snapshot_id=? AND a.cohort_key=? AND a.eligible=1 AND d.amount_decimal IS NOT NULL' +
      match,
    args: unknown[] = [snap.snapshot_id, cohort, ...(matchedSnapshot ? [matchedSnapshot] : [])];
  const n = await env.PRIVATE_DB.prepare(
    'SELECT COUNT(*) AS n FROM ' +
      snap.dataset +
      ' d JOIN gpu_snapshot_members a ON a.observation_id=d.observation_id WHERE ' +
      where,
  )
    .bind(...args)
    .first<{ n: number }>();
  const count = n?.n ?? 0;
  return {
    sample_count: count,
    median: await quantile(env, snap.dataset, where, args, count, 0.5),
    q25: await quantile(env, snap.dataset, where, args, count, 0.25),
    q75: await quantile(env, snap.dataset, where, args, count, 0.75),
  };
}
export async function finalizeGPUMetrics(
  env: CollectorEnv,
  s: Source,
  snap: Snapshot,
  now: string,
) {
  if (snap.state !== 'complete') return;
  const cohorts = await env.PRIVATE_DB.prepare(
    "SELECT DISTINCT cohort_key FROM gpu_snapshot_members WHERE snapshot_id=? AND NOT EXISTS(SELECT 1 FROM gpu_metric_jobs j WHERE j.snapshot_id=gpu_snapshot_members.snapshot_id AND j.cohort_key=gpu_snapshot_members.cohort_key AND j.state='complete') ORDER BY cohort_key LIMIT 1",
  )
    .bind(snap.snapshot_id)
    .all<{ cohort_key: string }>();
  for (const { cohort_key: cohort } of cohorts.results) {
    const id = await hash(snap.snapshot_id + '|' + cohort + '|' + GPU_METHOD);
    const row = await env.PRIVATE_DB.prepare(
      'SELECT d.domain_json FROM ' +
        snap.dataset +
        ' d JOIN gpu_snapshot_members a USING(observation_id) WHERE a.snapshot_id=? AND a.cohort_key=? LIMIT 1',
    )
      .bind(snap.snapshot_id, cohort)
      .first<{ domain_json: string }>();
    if (!row) continue;
    const domain = JSON.parse(row.domain_json) as GPUDomain,
      conditions = gpuComparison(domain),
      current = await stats(env, snap, cohort);
    const input: MetricInput[] = [
      {
        snapshot_id: snap.snapshot_id,
        observation_id: null,
        source_id: s.source_id,
        policy_version: s.policy.version,
      },
    ];
    const totals = await env.PRIVATE_DB.prepare(
      'SELECT COUNT(*) AS n FROM gpu_snapshot_members WHERE snapshot_id=? AND cohort_key=?',
    )
      .bind(snap.snapshot_id, cohort)
      .first<{ n: number }>();
    const excluded = await env.PRIVATE_DB.prepare(
      'SELECT j.value AS reason,COUNT(*) AS count FROM gpu_snapshot_members a,json_each(a.exclusion_json) j WHERE a.snapshot_id=? AND a.cohort_key=? GROUP BY j.value ORDER BY j.value',
    )
      .bind(snap.snapshot_id, cohort)
      .all();
    const changes: Record<string, unknown> = {};
    for (const days of [7, 30, 90]) {
      const date = new Date(Date.parse(snap.started_at) - days * 86400000)
        .toISOString()
        .slice(0, 10);
      const past = await env.PRIVATE_DB.prepare(
        "SELECT * FROM gpu_snapshots WHERE source_id=? AND scope_hash=? AND state='complete' AND substr(started_at,1,10)=? ORDER BY started_at DESC,completed_at DESC LIMIT 1",
      )
        .bind(s.source_id, snap.scope_hash, date)
        .first<Snapshot>();
      const prior = past ? await stats(env, past, cohort) : null;
      changes[days + 'd'] = {
        status: prior?.sample_count && current.sample_count ? 'ok' : 'insufficient_data',
        reference_snapshot_id: past?.snapshot_id ?? null,
        price_median_percent: percentChange(prior?.median ?? null, current.median),
        observed_eligible_offer_count_change: prior
          ? current.sample_count - prior.sample_count
          : null,
      };
      if (past)
        input.push({
          snapshot_id: past.snapshot_id,
          observation_id: null,
          source_id: past.source_id,
          policy_version: past.policy_version,
        });
    }
    const previous = await env.PRIVATE_DB.prepare(
      "SELECT * FROM gpu_snapshots WHERE source_id=? AND scope_hash=? AND state='complete' AND started_at<? ORDER BY started_at DESC,completed_at DESC LIMIT 1",
    )
      .bind(s.source_id, snap.scope_hash, snap.started_at)
      .first<Snapshot>();
    let matched: Record<string, unknown> = {
      status: 'insufficient_data',
      sample_count: 0,
      median_change_percent: null,
      newly_seen: null,
      not_seen: null,
    };
    if (previous) {
      const before = await stats(env, previous, cohort, snap.snapshot_id),
        after = await stats(env, snap, cohort, previous.snapshot_id);
      const entries = await env.PRIVATE_DB.prepare(
        'SELECT COUNT(*) AS n FROM gpu_snapshot_members a WHERE snapshot_id=? AND cohort_key=? AND NOT EXISTS(SELECT 1 FROM gpu_snapshot_members b WHERE b.snapshot_id=? AND b.record_key=a.record_key)',
      )
        .bind(snap.snapshot_id, cohort, previous.snapshot_id)
        .first<{ n: number }>();
      const exits = await env.PRIVATE_DB.prepare(
        'SELECT COUNT(*) AS n FROM gpu_snapshot_members a WHERE snapshot_id=? AND cohort_key=? AND NOT EXISTS(SELECT 1 FROM gpu_snapshot_members b WHERE b.snapshot_id=? AND b.record_key=a.record_key)',
      )
        .bind(previous.snapshot_id, cohort, snap.snapshot_id)
        .first<{ n: number }>();
      matched = {
        status: before.sample_count && after.sample_count ? 'ok' : 'insufficient_data',
        sample_count: after.sample_count,
        previous_snapshot_id: previous.snapshot_id,
        median_change_percent: percentChange(before.median, after.median),
        newly_seen: entries?.n ?? 0,
        not_seen: exits?.n ?? 0,
        not_seen_means_sale: false,
        method: 'ratio_of_matched_offer_medians',
      };
      input.push({
        snapshot_id: previous.snapshot_id,
        observation_id: null,
        source_id: previous.source_id,
        policy_version: previous.policy_version,
      });
    }
    const availability =
      snap.dataset === 'gpu_rental'
        ? await env.PRIVATE_DB.prepare(
            "SELECT json_extract(d.domain_json,'$.availability_status') AS evidence_status,COUNT(*) AS n FROM gpu_rental d JOIN gpu_snapshot_members a USING(observation_id) WHERE a.snapshot_id=? AND a.cohort_key=? GROUP BY evidence_status",
          )
            .bind(snap.snapshot_id, cohort)
            .all<{ evidence_status: string; n: number }>()
        : null;
    const knownCount =
        availability?.results
          .filter((a) => a.evidence_status !== 'unknown')
          .reduce((n, a) => n + a.n, 0) ?? 0,
      availableCount = availability?.results.find((a) => a.evidence_status === 'available')?.n ?? 0;
    const age =
      snap.dataset === 'gpu_secondary'
        ? await env.PRIVATE_DB.prepare(
            "SELECT MIN(json_extract(d.domain_json,'$.first_seen_at')) AS earliest_first_seen_at,MAX(json_extract(d.domain_json,'$.first_seen_at')) AS latest_first_seen_at FROM gpu_secondary d JOIN gpu_snapshot_members a USING(observation_id) WHERE a.snapshot_id=? AND a.cohort_key=?",
          )
            .bind(snap.snapshot_id, cohort)
            .first()
        : null;
    const observed = await env.PRIVATE_DB.prepare(
      'SELECT MAX(observed_at) AS t FROM gpu_pages WHERE snapshot_id=?',
    )
      .bind(snap.snapshot_id)
      .first<{ t: string }>();
    const data: GPUStats = {
      metric_id: id,
      kind: 'cohort_summary',
      dataset: snap.dataset,
      snapshot_id: snap.snapshot_id,
      cohort_key: cohort,
      gpu_sku_id: domain.gpu_sku_id,
      observed_at: observed?.t ?? snap.started_at,
      recorded_at: now,
      data_origin: snap.data_origin,
      methodology: GPU_METHOD,
      conditions,
      ...current,
      observed_offer_count: totals?.n ?? 0,
      status: current.sample_count ? 'ok' : 'insufficient_data',
      coverage: 'complete',
      scope_hash: snap.scope_hash,
      quantile_method: 'type_7_decimal',
      count_unit: snap.dataset === 'gpu_secondary' ? 'observed_listing' : 'observed_offer_region',
      exclusions: excluded.results,
      changes,
      matched_offers: matched,
      availability_evidence: availability
        ? {
            status_counts: availability.results,
            known_status_count: knownCount,
            known_fraction: totals?.n ? new D(knownCount).div(totals.n).toFixed() : null,
            available_fraction_of_known: knownCount
              ? new D(availableCount).div(knownCount).toFixed()
              : null,
          }
        : null,
      availability_is_utilization: false,
      first_seen_range: age,
      minimum_sample_count: 1,
      statistical_confidence_claim: false,
      age_meaning: 'first_observed_by_this_collector_not_original_market_age',
      market_representative: false,
    };
    await saveGPUMetric(env, s, snap, data, input, now);
    await buildComparisons(env, s, snap, data, input, now);
    await env.PRIVATE_DB.prepare("INSERT OR REPLACE INTO gpu_metric_jobs VALUES (?,?,?,'complete')")
      .bind(snap.snapshot_id, cohort, id)
      .run();
  }
  const pending = await env.PRIVATE_DB.prepare(
    "SELECT 1 AS yes FROM gpu_snapshot_members a WHERE a.snapshot_id=? AND NOT EXISTS(SELECT 1 FROM gpu_metric_jobs j WHERE j.snapshot_id=a.snapshot_id AND j.cohort_key=a.cohort_key AND j.state='complete') LIMIT 1",
  )
    .bind(snap.snapshot_id)
    .first();
  if (!pending)
    await env.PRIVATE_DB.prepare(
      "UPDATE gpu_snapshots SET processing_stage='done' WHERE snapshot_id=?",
    )
      .bind(snap.snapshot_id)
      .run();
}
