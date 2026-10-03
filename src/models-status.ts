import type { Source } from './schema';
import { freshness } from './fx';
// Read-only operational projection: no raw response, secret, artifact path or price values.
export const modelStatusSQL = `SELECT s.source_id,s.last_success_at,
  r.scheduled_for,r.state run_state,r.error_code,r.started_at,r.finished_at,r.recovery_count,r.next_attempt_at,
  r.observation_count,r.accepted_count,r.last_progress_at,
  (SELECT COUNT(*) FROM fetch_attempts f WHERE f.run_id=r.run_id) fetch_attempts,
  (SELECT MAX(f.started_at) FROM fetch_attempts f WHERE f.run_id=r.run_id) last_attempt_at,
  (SELECT json_extract(o.metadata_json,'$.source_date') FROM observations o WHERE o.source_id=s.source_id AND o.dataset='fx' AND o.quality_status='accepted' ORDER BY o.observed_at DESC LIMIT 1) source_date,
  (SELECT MAX(cm.observed_at) FROM model_snapshots cm WHERE cm.source_id=s.source_id AND cm.state='complete') latest_complete_observed_at,
  m.snapshot_id,m.observed_at,m.completed_at,m.state snapshot_state,m.stage checkpoint_stage,m.cursor,
  m.enumerated_count,m.model_count,m.price_count,m.component_count,m.quarantined_count,m.complete_capture,
  m.issues_json,m.data_origin,m.expires_at,m.metrics_json,
  (SELECT json_group_object(kind,n) FROM (SELECT kind,COUNT(*) n FROM model_events e WHERE e.snapshot_id=m.snapshot_id GROUP BY kind)) event_counts_json
  FROM sources s
  LEFT JOIN collection_runs r ON r.run_id=(SELECT rr.run_id FROM collection_runs rr WHERE rr.source_id=s.source_id ORDER BY scheduled_for DESC LIMIT 1)
  LEFT JOIN model_snapshots m ON m.snapshot_id=(SELECT mm.snapshot_id FROM model_snapshots mm WHERE mm.run_id=r.run_id ORDER BY recorded_at DESC LIMIT 1)
  ORDER BY s.source_id`;
export function formatModelStatus(
  rows: Record<string, any>[],
  sources: Source[],
  now: string,
): Record<string, any>[] {
  return rows.map(({ event_counts_json, ...row }) => {
    const s = sources.find((s) => s.source_id === row.source_id);
    return {
      ...row,
      event_counts: JSON.parse(event_counts_json ?? '{}'),
      native_frequency: s?.native_frequency ?? 'unknown',
      freshness: row.last_success_at
        ? freshness(row.last_success_at, row.source_date, now, s?.dataset_type ?? 'unknown')
        : { stale: true, stale_reason: 'no_successful_observation' },
      freshness_basis:
        s?.dataset_type === 'fx'
          ? 'TARGET reference calendar plus daily collection'
          : 'Daily observation age; not a claim that irregular catalog prices update daily',
    };
  });
}
