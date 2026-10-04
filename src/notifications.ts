import type { CollectorEnv, Source } from './schema';
import { hash, notificationEpoch, stable } from './util';
import { readOperationalStatus, type Signal } from './operational-status';

type Incident = {
  active: number;
  revision: number;
  last_condition: string;
  last_code: string;
  checked_at: string;
  last_notice_at: string | null;
  last_event_id: string | null;
};
const DAY = 86400000;
export function notificationActivation(env: CollectorEnv, now: string) {
  return notificationEpoch(env.NOTIFICATIONS_ACTIVE_FROM, now);
}
export function notificationDecision(prior: Incident, signal: Signal, now: string) {
  if (now <= prior.checked_at) return null;
  if (signal.condition === 'alert')
    return !prior.active
      ? 'opened'
      : !prior.last_notice_at || Date.parse(now) - Date.parse(prior.last_notice_at) >= DAY
        ? 'reminder'
        : null;
  return signal.condition === 'clear' && prior.active ? 'recovered' : null;
}

// Operational metadata only. A reviewed activation timestamp creates a new epoch;
// old summary notifications never acquire an epoch and can never be sent here.
export async function recordNotificationSignals(
  env: CollectorEnv,
  signals: Signal[],
  now: string,
  dryRun = false,
) {
  const activation = notificationActivation(env, now);
  if (!activation) return { state: 'activation_required', events: [] as string[] };
  const events: string[] = [];
  for (const signal of signals) {
    if (!/^(ecb|models_dev):[a-z_]+$/.test(signal.key) || !/^[a-z0-9_]{1,100}$/.test(signal.code))
      continue;
    const previous = await env.PRIVATE_DB.prepare(
      'SELECT active,revision,last_condition,last_code,checked_at,last_notice_at,last_event_id FROM notification_incidents WHERE activation_at=? AND incident_key=?',
    )
      .bind(activation, signal.key)
      .first<Incident>();
    const prior = previous ?? {
      active: 0,
      revision: 0,
      last_condition: 'unknown',
      last_code: 'initial',
      checked_at: '',
      last_notice_at: null,
      last_event_id: null,
    };
    if (now <= prior.checked_at) continue;
    const kind = notificationDecision(prior, signal, now);
    const id = kind
      ? await hash(
          'notification-v2|' + activation + '|' + signal.key + '|' + prior.revision + '|' + kind,
        )
      : prior.last_event_id;
    if (kind) events.push(signal.key + ':' + kind);
    if (dryRun) continue;
    const active =
      signal.condition === 'alert' ? 1 : signal.condition === 'clear' ? 0 : prior.active;
    const payload = stable({
      schema_version: 2,
      incident_key: signal.key,
      event: kind,
      code: signal.code,
      checked_at: now,
    });
    const statements = [
      env.PRIVATE_DB.prepare(
        "INSERT OR IGNORE INTO notification_incidents(activation_at,incident_key,last_condition,last_code,checked_at) VALUES (?,?,'unknown','initial','')",
      ).bind(activation, signal.key),
      env.PRIVATE_DB.prepare(
        'UPDATE notification_incidents SET active=?,revision=revision+1,last_condition=?,last_code=?,checked_at=?,last_notice_at=?,last_event_id=? WHERE activation_at=? AND incident_key=? AND revision=? AND checked_at=?',
      ).bind(
        active,
        signal.condition,
        signal.code,
        now,
        kind ? now : prior.last_notice_at,
        id,
        activation,
        signal.key,
        prior.revision,
        prior.checked_at,
      ),
    ];
    if (kind)
      statements.push(
        env.PRIVATE_DB.prepare(
          "INSERT OR IGNORE INTO notification_outbox(notification_id,payload_json,state,recorded_at,activation_at,incident_key,event_kind) SELECT ?,?,'pending',?,?,?,? WHERE EXISTS(SELECT 1 FROM notification_incidents WHERE activation_at=? AND incident_key=? AND revision=? AND last_event_id=?)",
        ).bind(
          id,
          payload,
          now,
          activation,
          signal.key,
          kind,
          activation,
          signal.key,
          prior.revision + 1,
          id,
        ),
      );
    await env.PRIVATE_DB.batch(statements);
  }
  return { state: dryRun ? 'dry_run' : 'recorded', events };
}

export async function recordOperationalNotifications(
  env: CollectorEnv,
  sources: Source[],
  now: string,
) {
  if (!notificationActivation(env, now))
    return { state: env.ALERT_WEBHOOK_URL ? 'activation_required' : 'not_configured', events: [] };
  const report = await readOperationalStatus(env, sources, now);
  return recordNotificationSignals(
    env,
    report.sources.flatMap((s) =>
      s.signals.map((signal) =>
        signal.condition === 'unknown' ? { ...signal, condition: 'alert' as const } : signal,
      ),
    ),
    now,
  );
}

export async function deliverNotifications(
  env: CollectorEnv,
  now: string,
  fetcher: typeof fetch = fetch,
  options: { dryRun?: boolean } = {},
) {
  if (!env.ALERT_WEBHOOK_URL) return { state: 'not_configured', sent: 0 };
  const activation = notificationActivation(env, now);
  if (!activation) return { state: 'activation_required', sent: 0 };
  let url: URL;
  try {
    url = new URL(env.ALERT_WEBHOOK_URL);
  } catch {
    return { state: 'invalid_configuration', sent: 0 };
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    /^(localhost|127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|0\.|\[)/i.test(
      url.hostname,
    )
  )
    return { state: 'invalid_configuration', sent: 0 };
  const since = new Date(Math.max(Date.parse(activation), Date.parse(now) - DAY)).toISOString();
  const retryBefore = new Date(Date.parse(now) - 15 * 60000).toISOString();
  const freshAfter = new Date(Date.parse(now) - 20 * 60000).toISOString();
  const query = `SELECT o.notification_id,o.payload_json,o.attempts FROM notification_outbox o JOIN notification_incidents i ON i.activation_at=o.activation_at AND i.incident_key=o.incident_key AND i.last_event_id=o.notification_id WHERE o.activation_at=? AND o.state='pending' AND o.attempts<3 AND o.recorded_at>=? AND o.recorded_at<=? AND i.checked_at>=? AND (o.last_attempt_at IS NULL OR o.last_attempt_at<=?) AND ((o.event_kind IN ('opened','reminder') AND i.active=1 AND i.last_condition='alert') OR (o.event_kind='recovered' AND i.active=0 AND i.last_condition='clear')) ORDER BY o.recorded_at,o.notification_id LIMIT 5`;
  const pending = await env.PRIVATE_DB.prepare(query)
    .bind(activation, since, now, freshAfter, retryBefore)
    .all<{ notification_id: string; payload_json: string; attempts: number }>();
  if (options.dryRun) return { state: 'dry_run', sent: 0, eligible: pending.results.length };
  let sent = 0,
    claimed = 0;
  for (const row of pending.results) {
    const claim = await env.PRIVATE_DB.prepare(
      "UPDATE notification_outbox SET attempts=attempts+1,last_attempt_at=? WHERE notification_id=? AND state='pending' AND attempts=? AND attempts<3 AND (last_attempt_at IS NULL OR last_attempt_at<=?) AND EXISTS(SELECT 1 FROM notification_incidents i WHERE i.activation_at=notification_outbox.activation_at AND i.incident_key=notification_outbox.incident_key AND i.last_event_id=notification_outbox.notification_id AND i.checked_at>=? AND ((notification_outbox.event_kind IN ('opened','reminder') AND i.active=1 AND i.last_condition='alert') OR (notification_outbox.event_kind='recovered' AND i.active=0 AND i.last_condition='clear')))",
    )
      .bind(now, row.notification_id, row.attempts, retryBefore, freshAfter)
      .run();
    if (claim.meta.changes !== 1) continue;
    claimed++;
    try {
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
      /* Never log endpoint, headers, response or arbitrary exception text. */
    }
  }
  return { state: !claimed ? 'nothing_due' : sent === claimed ? 'delivered' : 'pending', sent };
}
