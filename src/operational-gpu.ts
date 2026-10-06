import type { CollectorEnv, Source } from './schema';
import type { RunDTO } from './admin-contract';
import { gpuParser } from './gpu-store';
import { hash, stable, isoTime } from './util';

// Read only fixed metadata. A complete run is insufficient without every planned
// partition, its current policy/scope and matching immutable observation counts.
export async function readGPUCollectionEvidence(
  env: CollectorEnv,
  source: Source,
  runId: string,
  now: string,
  run: RunDTO | null,
) {
  const config = source.gpu;
  if (!config) throw new Error('gpu_configuration_missing');
  const snapshots = await env.PRIVATE_DB.prepare(
    'SELECT partition_id,scope_hash,policy_version,state,processing_stage,completed_at,received_count,reported_total,next_page,data_origin FROM gpu_snapshots WHERE run_id=? AND source_id=? AND started_at<=? ORDER BY partition_id LIMIT 17',
  )
    .bind(runId, source.source_id, now)
    .all<{
      partition_id: string;
      scope_hash: string;
      policy_version: string;
      state: string;
      processing_stage: string;
      completed_at: string | null;
      received_count: number;
      reported_total: number | null;
      next_page: number | null;
      data_origin: string;
    }>();
  const expected = new Map<string, string>();
  for (const partition of config.partitions)
    expected.set(
      partition.id,
      await hash(
        stable({
          adapter: source.adapter,
          endpoint: source.endpoint,
          partition,
          classification_version: gpuParser(source),
          page_size: config.page_size,
          region_map: config.region_map,
          market_scope: 'observed_search_only',
        }),
      ),
    );
  const counts = await env.PRIVATE_DB.prepare(
    "SELECT COUNT(*) total,COALESCE(SUM(quality_status='accepted'),0) accepted,COALESCE(SUM(quality_status='quarantined'),0) quarantined FROM observations WHERE run_id=? AND source_id=? AND recorded_at<=?",
  )
    .bind(runId, source.source_id, now)
    .first<{ total: number; accepted: number; quarantined: number }>();
  if (!counts) throw new Error('gpu_counts_unavailable');
  const completeCapture =
    snapshots.results.length === config.partitions.length &&
    config.partitions.length > 0 &&
    expected.size === config.partitions.length &&
    new Set(snapshots.results.map((s) => s.partition_id)).size === config.partitions.length &&
    snapshots.results.every(
      (s) =>
        s.scope_hash === expected.get(s.partition_id) &&
        s.policy_version === source.policy.version &&
        s.state === 'complete' &&
        s.processing_stage === 'done' &&
        s.completed_at !== null &&
        isoTime(s.completed_at) &&
        s.completed_at <= now &&
        s.next_page === null &&
        s.received_count >= 0 &&
        s.reported_total === s.received_count &&
        (s.data_origin === 'live' || (env.ENVIRONMENT === 'test' && s.data_origin === 'synthetic')),
    ) &&
    snapshots.results.reduce((n, s) => n + s.received_count, 0) === counts.total &&
    counts.accepted + counts.quarantined === counts.total &&
    run?.observation_count === counts.total &&
    run.accepted_count === counts.accepted;
  const clocks = await env.PRIVATE_DB.prepare(
    "SELECT COUNT(*) records,MIN(o.observed_at) retrieved_from,MAX(o.observed_at) retrieved_to,MIN(json_extract(d.domain_json,'$.price_of_compute.source_day')) source_day_from,MAX(json_extract(d.domain_json,'$.price_of_compute.source_day')) source_day_to,MIN(json_extract(d.domain_json,'$.price_of_compute.source_updated_at')) source_updated_from,MAX(json_extract(d.domain_json,'$.price_of_compute.source_updated_at')) source_updated_to,MIN(json_extract(d.domain_json,'$.price_of_compute.source_observed_at')) provider_observed_from,MAX(json_extract(d.domain_json,'$.price_of_compute.source_observed_at')) provider_observed_to,COALESCE(SUM(json_extract(d.domain_json,'$.price_of_compute.source_observed_at') IS NULL),0) provider_time_missing FROM observations o JOIN gpu_rental d USING(observation_id) WHERE o.run_id=? AND o.source_id=? AND o.recorded_at<=?",
  )
    .bind(runId, source.source_id, now)
    .first<{
      records: number;
      retrieved_from: string | null;
      retrieved_to: string | null;
      source_day_from: string | null;
      source_day_to: string | null;
      source_updated_from: string | null;
      source_updated_to: string | null;
      provider_observed_from: string | null;
      provider_observed_to: string | null;
      provider_time_missing: number;
    }>();
  if (!clocks) throw new Error('gpu_clocks_unavailable');
  const timestamp = (v: string | null) => (v && isoTime(v) ? v : null);
  const day = (v: string | null) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
  const reasons: Record<string, number> = counts.quarantined
    ? { quarantined_observation: counts.quarantined }
    : {};
  return {
    completeCapture,
    quality:
      run?.state === 'complete'
        ? {
            count: counts.quarantined,
            reasons,
          }
        : null,
    priceClocks: {
      state: clocks.records ? 'not_evaluated' : 'no_records',
      meaning: 'collection_completion_is_not_source_price_freshness',
      retrieved_from: timestamp(clocks.retrieved_from),
      retrieved_to: timestamp(clocks.retrieved_to),
      source_day_from: day(clocks.source_day_from),
      source_day_to: day(clocks.source_day_to),
      source_updated_from: timestamp(clocks.source_updated_from),
      source_updated_to: timestamp(clocks.source_updated_to),
      provider_observed_from: timestamp(clocks.provider_observed_from),
      provider_observed_to: timestamp(clocks.provider_observed_to),
      provider_time_missing: clocks.records ? clocks.provider_time_missing : null,
    },
  };
}
