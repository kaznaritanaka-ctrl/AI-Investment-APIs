import { isGPU } from './gpu';
import { collectGPU } from './gpu-pipeline';
import type { CollectorEnv, Source } from './schema';
import { syncSource } from './publication';
import { stable, hash, errorCode } from './util';
import { collectSource, type RunResult } from './pipeline';
import { canCollect } from './policy';
import { collectionIdentity, minuteSlot } from './run-identity';
import { observe, newlyCompleted, type ProcessKind, type SourceObserver } from './telemetry';
export { deliverNotifications } from './notifications';

export async function recordSummary(
  env: CollectorEnv,
  slot: string,
  results: RunResult[],
  now: string,
  context: { process_kind?: ProcessKind; event_scheduled_at?: string; logical_slot?: string } = {},
) {
  const states = await env.PRIVATE_DB.prepare(
    'SELECT source_id,last_success_at FROM sources',
  ).all();
  const summary = {
    process_kind: context.process_kind ?? 'collection',
    event_scheduled_at: context.event_scheduled_at ?? slot,
    logical_slot: context.logical_slot ?? null,
    scheduled_for: slot,
    recorded_at: now,
    sources: results,
    success: results.filter((r) => r.state === 'complete').length,
    failed: results.filter((r) => r.state === 'failed' || r.state === 'missing').length,
    rights_skipped: results.filter((r) => r.state === 'policy_skipped').length,
    changed: results.reduce((n, r) => n + (r.changes ?? 0), 0),
    anomalies: results.reduce((n, r) => n + (r.quarantined ?? 0) + (r.issues ?? 0), 0),
    last_success: states.results,
    observation_completed_sources: results.filter(newlyCompleted).map((r) => r.source_id),
    freshness_evaluation: 'source_calendar_not_evaluated',
    stale: results
      .filter((r) => !['complete', 'policy_skipped'].includes(r.state))
      .map((r) => r.source_id),
    setup_warnings: [
      ...(!env.ALERT_WEBHOOK_URL ? ['notification_not_configured'] : []),
      'agent_runtime_not_connected',
    ],
    agent_enabled: false,
    environment: env.ENVIRONMENT,
  };
  const id = await hash(summary.process_kind + '|' + slot + '|' + now + '|' + stable(results));
  await env.PRIVATE_DB.prepare('INSERT OR IGNORE INTO daily_summaries VALUES (?,?,?)')
    .bind(id, now, stable(summary))
    .run();
  return summary;
}
export async function watchdog(
  env: CollectorEnv,
  sources: Source[],
  slot: string,
  now: string,
  observer?: SourceObserver,
) {
  slot = minuteSlot(slot);
  const results: RunResult[] = [];
  for (const s of sources)
    results.push(await observe(observer, s, slot, () => inspectSource(env, s, slot, now)));
  return results;
}
async function inspectSource(
  env: CollectorEnv,
  s: Source,
  slot: string,
  now: string,
): Promise<RunResult> {
  let run = await hash(s.source_id + '|' + slot);
  const base = { source_id: s.source_id, logical_slot: slot, run_kind: 'collection' as const };
  try {
    await syncSource(env, s, now);
    const identity = await collectionIdentity(env.PRIVATE_DB, s.source_id, slot);
    run = identity.run_id;
    const row = identity.row;
    if (!canCollect(s, now)) {
      return { ...base, run_id: run, state: 'policy_skipped', reason: 'policy_blocked' };
    }
    if (!row) {
      await env.PRIVATE_DB.prepare(
        "INSERT OR IGNORE INTO collection_runs(run_id,source_id,scheduled_for,state,finished_at,error_code) VALUES (?,?,?,'missing',?,'scheduled_run_missing')",
      )
        .bind(run, s.source_id, slot, now)
        .run();
      return {
        ...base,
        run_id: run,
        state: 'missing',
        reason: 'scheduled_run_missing',
      };
    }
    if (['complete', 'quarantined', 'policy_skipped'].includes(row.state)) {
      return {
        ...base,
        run_id: run,
        state: row.state,
        reason: 'already_processed',
        observations: row.observation_count,
        accepted: row.accepted_count,
      };
    }
    if (isGPU(s.dataset_type)) {
      return collectGPU(env, s, identity.storedSlot, { now: () => now, savedOnly: true });
    }
    // Recovery only from saved evidence. Never refetch every source from a watchdog.
    const raw = await env.EVIDENCE.head('evidence/' + s.source_id + '/' + run + '.json');
    if (raw && row.recovery_count < 3 && (!row.lease_until || row.lease_until < now)) {
      await env.PRIVATE_DB.prepare(
        'UPDATE collection_runs SET recovery_count=recovery_count+1 WHERE run_id=?',
      )
        .bind(run)
        .run();
      return collectSource(env, s, identity.storedSlot, { now: () => now, savedOnly: true });
    } else
      return {
        ...base,
        run_id: run,
        state: row.state,
        reason: 'incomplete_run',
      };
  } catch (error) {
    return {
      ...base,
      run_id: run,
      state: 'failed',
      reason: errorCode(error),
    };
  }
}
export async function expireEvidence(env: CollectorEnv, now: string) {
  const rows = await env.PRIVATE_DB.prepare(
    "SELECT artifact_ref FROM raw_artifacts WHERE expires_at<=? AND state='retained' LIMIT 100",
  )
    .bind(now)
    .all<{ artifact_ref: string }>();
  for (const r of rows.results) {
    await env.EVIDENCE.delete(r.artifact_ref);
    await env.PRIVATE_DB.prepare("UPDATE raw_artifacts SET state='expired' WHERE artifact_ref=?")
      .bind(r.artifact_ref)
      .run();
  }
  return rows.results.length;
}
