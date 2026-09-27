import type { CollectorEnv, Source } from './schema';
import { syncSource } from './publication';
import { stable, hash, errorCode } from './util';
import { collectSource, type RunResult } from './pipeline';
import { canCollect } from './policy';

export async function recordSummary(
  env: CollectorEnv,
  slot: string,
  results: RunResult[],
  now: string,
) {
  const states = await env.PRIVATE_DB.prepare(
    'SELECT source_id,last_success_at FROM sources',
  ).all();
  const summary = {
    scheduled_for: slot,
    recorded_at: now,
    sources: results,
    success: results.filter((r) => r.state === 'complete').length,
    failed: results.filter((r) => r.state === 'failed' || r.state === 'missing').length,
    rights_skipped: results.filter((r) => r.state === 'policy_skipped').length,
    changed: results.reduce((n, r) => n + (r.changes ?? 0), 0),
    anomalies: results.reduce((n, r) => n + (r.quarantined ?? 0) + (r.issues ?? 0), 0),
    last_success: states.results,
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
  const id = await hash(slot + '|' + now + '|' + stable(results));
  const previous = await env.PRIVATE_DB.prepare(
    'SELECT summary_json FROM daily_summaries ORDER BY recorded_at DESC LIMIT 1',
  ).first<{ summary_json: string }>();
  const digest = (s: typeof summary) =>
    stable({
      states: s.sources.map((r) => [r.source_id, r.state, r.reason ?? null]),
      changed: s.changed,
      anomalies: s.anomalies,
    });
  await env.PRIVATE_DB.prepare('INSERT OR IGNORE INTO daily_summaries VALUES (?,?,?)')
    .bind(id, now, stable(summary))
    .run();
  if (!previous || digest(JSON.parse(previous.summary_json)) !== digest(summary)) {
    await env.PRIVATE_DB.prepare(
      "INSERT OR IGNORE INTO notification_outbox(notification_id,payload_json,state,recorded_at) VALUES (?,?,'pending',?)",
    )
      .bind(id, stable(summary), now)
      .run();
  }
  return summary;
}
export async function deliverNotifications(
  env: CollectorEnv,
  now: string,
  fetcher: typeof fetch = fetch,
) {
  if (!env.ALERT_WEBHOOK_URL) return { state: 'not_configured', sent: 0 };
  const url = new URL(env.ALERT_WEBHOOK_URL);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    /^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|\[)/i.test(url.hostname)
  )
    return { state: 'invalid_configuration', sent: 0 };
  const pending = await env.PRIVATE_DB.prepare(
    "SELECT notification_id,payload_json FROM notification_outbox WHERE state='pending' AND attempts<3 ORDER BY recorded_at LIMIT 5",
  ).all<{ notification_id: string; payload_json: string }>();
  let sent = 0;
  for (const row of pending.results) {
    try {
      await env.PRIVATE_DB.prepare(
        'UPDATE notification_outbox SET attempts=attempts+1,last_attempt_at=? WHERE notification_id=?',
      )
        .bind(now, row.notification_id)
        .run();
      const r = await fetcher(url.toString(), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': row.notification_id },
        body: row.payload_json,
        signal: AbortSignal.timeout(5000),
        redirect: 'error',
      });
      await r.body?.cancel();
      if (r.ok) {
        await env.PRIVATE_DB.prepare(
          "UPDATE notification_outbox SET state='sent',sent_at=? WHERE notification_id=?",
        )
          .bind(now, row.notification_id)
          .run();
        sent++;
      }
    } catch {
      /* Persisted pending outbox survives; never log URL or response body. */
    }
  }
  return { state: sent === pending.results.length ? 'delivered' : 'pending', sent };
}
export async function watchdog(env: CollectorEnv, sources: Source[], slot: string, now: string) {
  const results: RunResult[] = [];
  for (const s of sources) {
    const run = await hash(s.source_id + '|' + slot);
    try {
      await syncSource(env, s, now);
      const row = await env.PRIVATE_DB.prepare(
        'SELECT state,lease_until,recovery_count FROM collection_runs WHERE run_id=?',
      )
        .bind(run)
        .first<{ state: string; lease_until: string | null; recovery_count: number }>();
      if (!canCollect(s, now)) {
        results.push({ source_id: s.source_id, run_id: run, state: 'policy_skipped' });
        continue;
      }
      if (!row) {
        await env.PRIVATE_DB.prepare(
          "INSERT OR IGNORE INTO collection_runs(run_id,source_id,scheduled_for,state,finished_at,error_code) VALUES (?,?,?,'missing',?,'scheduled_run_missing')",
        )
          .bind(run, s.source_id, slot, now)
          .run();
        results.push({
          source_id: s.source_id,
          run_id: run,
          state: 'missing',
          reason: 'scheduled_run_missing',
        });
        continue;
      }
      if (['complete', 'quarantined', 'policy_skipped'].includes(row.state)) {
        results.push({ source_id: s.source_id, run_id: run, state: row.state });
        continue;
      }
      // Recovery only from saved evidence. Never refetch every source from a watchdog.
      const raw = await env.EVIDENCE.head('evidence/' + s.source_id + '/' + run + '.json');
      if (raw && row.recovery_count < 3 && (!row.lease_until || row.lease_until < now)) {
        await env.PRIVATE_DB.prepare(
          'UPDATE collection_runs SET recovery_count=recovery_count+1 WHERE run_id=?',
        )
          .bind(run)
          .run();
        results.push(await collectSource(env, s, slot, { now: () => now }));
      } else
        results.push({
          source_id: s.source_id,
          run_id: run,
          state: row.state,
          reason: 'incomplete_run',
        });
    } catch (error) {
      results.push({
        source_id: s.source_id,
        run_id: run,
        state: 'failed',
        reason: errorCode(error),
      });
    }
  }
  return results;
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
