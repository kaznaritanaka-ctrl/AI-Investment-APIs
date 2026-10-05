import type { CollectorEnv } from '../src/schema';
import { sources } from '../src/sources';
import { readOperationalStatus } from '../src/operational-status';
import { recordNotificationSignals, deliverNotifications } from '../src/notifications';

// Executed inside workerd against synthetic D1. All delivery uses this local stub.
export async function operationsRuntime(env: CollectorEnv) {
  const now = '2026-10-03T19:00:00.000Z';
  const configured = {
    ...env,
    COLLECTION_CRON: '17 18 * * *',
    COLLECTION_ENABLED: 'true',
    NOTIFICATIONS_ACTIVE_FROM: now,
    ALERT_WEBHOOK_URL: 'https://notify.example.test/synthetic',
  };
  const status = await readOperationalStatus(
    configured,
    sources.filter((s) => s.source_id === 'ecb'),
    now,
  );
  await recordNotificationSignals(
    configured,
    [{ key: 'ecb:collection', condition: 'alert', code: 'synthetic_failure' }],
    now,
  );
  let calls = 0;
  const fail: typeof fetch = async () => {
    calls++;
    return new Response('synthetic failure', { status: 500 });
  };
  const dry = await deliverNotifications(configured, now, fail, { dryRun: true });
  const dryCalls = calls;
  const failed = await deliverNotifications(configured, now, fail);
  await recordNotificationSignals(
    configured,
    [{ key: 'ecb:collection', condition: 'clear', code: 'observations_complete' }],
    '2026-10-03T19:01:00.000Z',
  );
  const recovered = await deliverNotifications(configured, '2026-10-03T19:01:00.000Z', async () => {
    calls++;
    return new Response('synthetic success');
  });
  return Response.json({
    collection: status.sources[0].collection,
    publication: status.sources[0].publication,
    dry,
    dryCalls,
    failed,
    recovered,
    calls,
    external_http: false,
  });
}
