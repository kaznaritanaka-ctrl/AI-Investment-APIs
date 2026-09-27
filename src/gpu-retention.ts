import type { CollectorEnv, Source } from './schema';
// Automatic retention is source-specific. Rows are withdrawn publicly before bounded private deletion.
export async function expireGPUData(env: CollectorEnv, sources: Source[], now: string) {
  let deleted = 0,
    handled = false;
  for (const s of sources.filter((s) => s.gpu?.retention.normalized_days)) {
    if (handled) break;
    const cutoff = new Date(
      Date.parse(now) - s.gpu!.retention.normalized_days! * 86400000,
    ).toISOString();
    const snapshots = await env.PRIVATE_DB.prepare(
      "SELECT snapshot_id FROM gpu_snapshots WHERE source_id=? AND started_at<=? AND state<>'purged' AND (lease_until IS NULL OR lease_until<?) ORDER BY started_at,completed_at DESC LIMIT 1",
    )
      .bind(s.source_id, cutoff, now)
      .all<{ snapshot_id: string }>();
    for (const g of snapshots.results) {
      handled = true;
      await env.PUBLIC_DB.batch([
        env.PUBLIC_DB.prepare(
          "UPDATE publication_batches SET state='withdrawn' WHERE batch_id=?",
        ).bind(g.snapshot_id),
        env.PUBLIC_DB.prepare('DELETE FROM published_coverage WHERE snapshot_id=?').bind(
          g.snapshot_id,
        ),
        env.PUBLIC_DB.prepare('DELETE FROM published_changes WHERE snapshot_id=?').bind(
          g.snapshot_id,
        ),
      ]);
      const metrics = await env.PRIVATE_DB.prepare(
        'SELECT DISTINCT metric_id FROM gpu_metric_lineage WHERE input_snapshot_id=? LIMIT 50',
      )
        .bind(g.snapshot_id)
        .all<{ metric_id: string }>();
      for (const m of metrics.results) {
        await env.PUBLIC_DB.batch([
          env.PUBLIC_DB.prepare('DELETE FROM published_metric_lineage WHERE metric_id=?').bind(
            m.metric_id,
          ),
          env.PUBLIC_DB.prepare('DELETE FROM published_gpu_metrics WHERE metric_id=?').bind(
            m.metric_id,
          ),
        ]);
        await env.PRIVATE_DB.batch([
          env.PRIVATE_DB.prepare('DELETE FROM gpu_metric_lineage WHERE metric_id=?').bind(
            m.metric_id,
          ),
          env.PRIVATE_DB.prepare('DELETE FROM derived_observations WHERE observation_id=?').bind(
            m.metric_id,
          ),
        ]);
      }
      if (metrics.results.length === 50) continue;
      const rows = await env.PRIVATE_DB.prepare(
        'SELECT observation_id FROM gpu_snapshot_members WHERE snapshot_id=? LIMIT 50',
      )
        .bind(g.snapshot_id)
        .all<{ observation_id: string }>();
      for (const row of rows.results) {
        const id = row.observation_id;
        await env.PUBLIC_DB.batch([
          env.PUBLIC_DB.prepare(
            "DELETE FROM published_changes WHERE observation_id=? OR json_extract(public_json,'$.previous_observation_id')=?",
          ).bind(id, id),
          env.PUBLIC_DB.prepare(
            'DELETE FROM published_lineage WHERE observation_id=? OR input_observation_id=?',
          ).bind(id, id),
          env.PUBLIC_DB.prepare('DELETE FROM published_observations WHERE observation_id=?').bind(
            id,
          ),
        ]);
        await env.PRIVATE_DB.batch([
          env.PRIVATE_DB.prepare(
            'DELETE FROM change_events WHERE observation_id=? OR previous_observation_id=?',
          ).bind(id, id),
          env.PRIVATE_DB.prepare(
            'DELETE FROM gpu_lifecycle_events WHERE previous_observation_id=?',
          ).bind(id),
          env.PRIVATE_DB.prepare('DELETE FROM gpu_snapshot_members WHERE observation_id=?').bind(
            id,
          ),
          env.PRIVATE_DB.prepare('DELETE FROM ' + s.dataset_type + ' WHERE observation_id=?').bind(
            id,
          ),
          env.PRIVATE_DB.prepare('DELETE FROM observations WHERE observation_id=?').bind(id),
        ]);
        deleted++;
      }
      if (rows.results.length < 50)
        await env.PRIVATE_DB.batch([
          env.PRIVATE_DB.prepare('DELETE FROM gpu_metric_jobs WHERE snapshot_id=?').bind(
            g.snapshot_id,
          ),
          env.PRIVATE_DB.prepare('DELETE FROM gpu_pages WHERE snapshot_id=?').bind(g.snapshot_id),
          env.PRIVATE_DB.prepare('DELETE FROM gpu_lifecycle_events WHERE snapshot_id=?').bind(
            g.snapshot_id,
          ),
          env.PRIVATE_DB.prepare(
            "UPDATE gpu_snapshots SET state='purged',reason='normalized_retention_expired',scope_json='{}' WHERE snapshot_id=?",
          ).bind(g.snapshot_id),
        ]);
    }
  }
  return deleted;
}
