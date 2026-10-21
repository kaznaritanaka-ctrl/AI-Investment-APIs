import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

export const HEALTH_URL = 'https://api.ai-investment-research.net/health';
const LIMIT = 64 * 1024,
  MAX_AGE = 36 * 3600000;
const stamp = (value) =>
  typeof value === 'string' &&
  /^\d{4}-\d\d-\d\dT/.test(value) &&
  Number.isFinite(Date.parse(value));
const unknown = (reason, now, status = null) => ({
  schema_version: 'external-health-v1',
  checked_at: new Date(now).toISOString(),
  reachability: reason,
  http_status: status,
  collection: 'unknown',
  publication: 'unknown',
  monitoring: 'not_verified',
  severity: 'error',
  reasons: [reason],
});
export function evaluateHealth(body, now = Date.now()) {
  if (
    !body ||
    !['public_data_available', 'no_public_data'].includes(body.status) ||
    !body.collector ||
    ![0, 1].includes(body.collector.collection_enabled) ||
    !Array.isArray(body.datasets) ||
    body.datasets.length > 100
  )
    return unknown('invalid_contract', now, 200);
  const reasons = [];
  const completed = body.collector.last_collector_completed_at;
  let collection = 'recent_record';
  if (body.collector.collection_enabled === 0) {
    collection = 'disabled_record';
    reasons.push('collection_disabled_record');
  } else if (!stamp(completed) || Date.parse(completed) > now + 60000) {
    collection = 'unknown';
    reasons.push('collection_timestamp_unknown');
  } else if (now - Date.parse(completed) > MAX_AGE) {
    collection = 'stale_record';
    reasons.push('collection_record_stale');
  }
  for (const name of ['fx', 'ai_api_prices']) {
    const rows = body.datasets.filter((row) => row?.dataset === name);
    const row = rows[0];
    if (
      rows.length !== 1 ||
      !Number.isSafeInteger(row.count) ||
      row.count < 1 ||
      !stamp(row.last_observed_at) ||
      Date.parse(row.last_observed_at) > now + 60000
    )
      reasons.push(name + '_publication_unknown');
    else if (now - Date.parse(row.last_observed_at) > MAX_AGE)
      reasons.push(name + '_publication_stale');
  }
  if (body.status === 'no_public_data') reasons.push('no_public_data');
  return {
    schema_version: 'external-health-v1',
    checked_at: new Date(now).toISOString(),
    reachability: 'reachable',
    http_status: 200,
    collection,
    publication: reasons.some(
      (reason) => reason.includes('publication') || reason === 'no_public_data',
    )
      ? 'needs_attention'
      : 'recent_observations',
    monitoring: 'not_verified',
    severity: reasons.length ? 'warning' : 'ok',
    reasons,
  };
}

export async function checkHealth({ fetcher = fetch, now = Date.now, timeoutMs = 10000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetcher(HEALTH_URL, {
      method: 'GET',
      redirect: 'manual',
      credentials: 'omit',
      cache: 'no-store',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    if (r.status !== 200) {
      await r.body?.cancel();
      return unknown(
        [401, 403].includes(r.status)
          ? 'access_blocked'
          : r.status === 429
            ? 'rate_limited'
            : 'http_error',
        now(),
        r.status,
      );
    }
    if (
      !/\bapplication\/json\b/i.test(r.headers.get('content-type') ?? '') ||
      Number(r.headers.get('content-length')) > LIMIT
    ) {
      await r.body?.cancel();
      return unknown('invalid_contract', now(), 200);
    }
    if (!r.body) return unknown('invalid_contract', now(), 200);
    const reader = r.body.getReader(),
      parts = [];
    let bytes = 0;
    const cancel = () => {
      void reader.cancel().catch(() => {});
    };
    controller.signal.addEventListener('abort', cancel, { once: true });
    try {
      while (true) {
        const next = await reader.read();
        if (controller.signal.aborted) return unknown('timeout', now(), 200);
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > LIMIT) {
          await reader.cancel();
          return unknown('body_too_large', now(), 200);
        }
        parts.push(Buffer.from(next.value));
      }
    } finally {
      controller.signal.removeEventListener('abort', cancel);
      reader.releaseLock();
    }
    return evaluateHealth(JSON.parse(Buffer.concat(parts).toString('utf8')), now());
  } catch {
    return unknown(controller.signal.aborted ? 'timeout' : 'network_or_contract_error', now());
  } finally {
    clearTimeout(timer);
  }
}

// The scheduler/notification provider owns persisted incident state. No messages are sent here.
export function transition(previous, report) {
  if (report.severity === 'ok')
    return { incident: null, notify: false, event: previous?.incident ? 'recovered' : 'unchanged' };
  const incident = [...report.reasons].sort().join('|');
  // Consecutive failures remain one incident even when its symptom changes.
  const failures = previous?.incident ? Math.min((previous.failures ?? 0) + 1, 3) : 1;
  return {
    incident,
    failures,
    notify: failures === 2,
    event: failures === 1 ? 'pending_confirmation' : failures === 2 ? 'new_incident' : 'unchanged',
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0] !== '--allow-network') {
    console.log(
      JSON.stringify({
        mode: 'offline',
        network_performed: false,
        schedule_configured: false,
        notifications_sent: false,
      }),
    );
    if (args.length) process.exitCode = 2;
  } else {
    const result = await checkHealth();
    console.log(JSON.stringify({ ...result, notifications_sent: false }));
    if (result.severity !== 'ok') process.exitCode = 1;
  }
}
