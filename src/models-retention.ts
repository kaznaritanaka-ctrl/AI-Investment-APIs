import type { CollectorEnv, Source } from './schema';
// Retention is separate from correction. Revisions have the original observed_at/expiry;
// delete the newest revisions first so immutable supersession FKs remain valid.
export async function expireModels(env: CollectorEnv, sources: Source[], now: string) {
  const snap = await env.PRIVATE_DB.prepare(
    "SELECT s.snapshot_id FROM model_snapshots s WHERE s.expires_at<=? AND s.state<>'purged' AND NOT EXISTS(SELECT 1 FROM model_snapshot_members m JOIN observations newer ON newer.supersedes_observation_id=m.catalog_observation_id OR newer.supersedes_observation_id=m.price_observation_id WHERE m.snapshot_id=s.snapshot_id) ORDER BY s.observed_at,s.recorded_at DESC,s.snapshot_id DESC LIMIT 1",
  )
    .bind(now)
    .first<{ snapshot_id: string }>();
  if (!snap) return 0;
  const id = snap.snapshot_id;
  await env.PUBLIC_DB.batch([
    env.PUBLIC_DB.prepare("UPDATE publication_batches SET state='withdrawn' WHERE batch_id=?").bind(
      id,
    ),
    env.PUBLIC_DB.prepare(
      "UPDATE published_model_snapshots SET state='expired',public_json='{}' WHERE snapshot_id=?",
    ).bind(id),
  ]);
  const members = (
    await env.PRIVATE_DB.prepare(
      'SELECT catalog_observation_id,price_observation_id FROM model_snapshot_members WHERE snapshot_id=? LIMIT 25',
    )
      .bind(id)
      .all<{ catalog_observation_id: string; price_observation_id: string | null }>()
  ).results;
  for (const member of members) {
    for (const oid of [member.catalog_observation_id, member.price_observation_id].filter(
      (x): x is string => !!x,
    )) {
      // Superseding records are also expired at the same source-observation deadline.
      if (
        await env.PRIVATE_DB.prepare(
          'SELECT observation_id FROM observations WHERE supersedes_observation_id=? LIMIT 1',
        )
          .bind(oid)
          .first()
      )
        return 0;
      await env.PUBLIC_DB.batch([
        env.PUBLIC_DB.prepare(
          'DELETE FROM published_model_events WHERE observation_id=? OR previous_observation_id=?',
        ).bind(oid, oid),
        env.PUBLIC_DB.prepare(
          "DELETE FROM published_changes WHERE observation_id=? OR json_extract(public_json,'$.previous_observation_id')=?",
        ).bind(oid, oid),
        env.PUBLIC_DB.prepare(
          'DELETE FROM published_lineage WHERE observation_id=? OR input_observation_id=?',
        ).bind(oid, oid),
        env.PUBLIC_DB.prepare('DELETE FROM published_observations WHERE observation_id=?').bind(
          oid,
        ),
      ]);
    }
    const ids = [
      member.catalog_observation_id,
      ...(member.price_observation_id ? [member.price_observation_id] : []),
    ];
    const statements = [
      env.PRIVATE_DB.prepare(
        'DELETE FROM model_snapshot_members WHERE snapshot_id=? AND catalog_observation_id=?',
      ).bind(id, member.catalog_observation_id),
    ];
    for (const oid of ids)
      statements.push(
        env.PRIVATE_DB.prepare(
          'DELETE FROM model_events WHERE observation_id=? OR previous_observation_id=?',
        ).bind(oid, oid),
        env.PRIVATE_DB.prepare(
          'DELETE FROM change_events WHERE observation_id=? OR previous_observation_id=?',
        ).bind(oid, oid),
        env.PRIVATE_DB.prepare('DELETE FROM ai_model_catalog WHERE observation_id=?').bind(oid),
        env.PRIVATE_DB.prepare('DELETE FROM ai_api_prices WHERE observation_id=?').bind(oid),
        env.PRIVATE_DB.prepare('DELETE FROM observations WHERE observation_id=?').bind(oid),
      );
    await env.PRIVATE_DB.batch(statements);
  }
  if (members.length < 25) {
    await env.PUBLIC_DB.prepare('DELETE FROM published_model_events WHERE snapshot_id=?')
      .bind(id)
      .run();
    await env.PRIVATE_DB.batch([
      env.PRIVATE_DB.prepare('DELETE FROM model_events WHERE snapshot_id=?').bind(id),
      env.PRIVATE_DB.prepare(
        "UPDATE model_snapshots SET state='purged',scope_json='{}',issues_json='[]',metrics_json='{}' WHERE snapshot_id=?",
      ).bind(id),
    ]);
  }
  return members.length;
}
