import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { localEnv } from '../scripts/local-env';
import { applyMigrations } from '../scripts/migrations';
import { source, time, fxFetch } from './helpers';
import { expandedSource, catalog, finishModels } from './models-helpers';
import { collectSource } from '../src/pipeline';
import { collectModels } from '../src/models-pipeline';
import { recordSummary } from '../src/operations';
import {
  readOperationalStatus,
  evaluateSource,
  apiReachability,
  monitorHeartbeat,
  type Signal,
} from '../src/operational-status';
import { recordNotificationSignals, deliverNotifications } from '../src/notifications';
import { hash } from '../src/util';
import { readAdmin } from '../src/admin-read';
import { notificationActivation } from '../src/notifications';

let local: Awaited<ReturnType<typeof localEnv>>;
beforeEach(async () => {
  local = await localEnv();
  local.env.COLLECTION_CRON = '17 18 * * *';
  local.env.COLLECTION_ENABLED = 'true';
});
afterEach(async () => {
  await local?.mf.dispose();
});
const at = (n: number) => new Date(Date.parse(time) + n * 60000).toISOString();
const report = async (now = at(50)) =>
  readOperationalStatus(local.env, [source('ecb'), expandedSource()], now);
const fx = async (slot = time) =>
  collectSource(local.env, source('ecb'), slot, {
    synthetic: true,
    now: () => slot,
    network: { fetcher: fxFetch() },
  });
const incident: Signal = { key: 'ecb:collection', condition: 'alert', code: 'run_failed' };
const quiet: Signal = { ...incident, condition: 'clear', code: 'observations_complete' };
const enabled = () => ({
  ...local.env,
  NOTIFICATIONS_ACTIVE_FROM: time,
  ALERT_WEBHOOK_URL: 'https://notify.example.test/synthetic',
});

it('distinguishes same prices/source date, recorded invocation, observation, snapshot and publication with no writes', async () => {
  const prior = '2026-10-02T18:17:00.000Z';
  await fx(prior);
  const result = await fx();
  expect(result.changes).toBe(0);
  const dates = await local.env.PRIVATE_DB.prepare(
    'SELECT DISTINCT source_date FROM fx_observations',
  ).all();
  expect(dates.results).toHaveLength(1);
  await recordSummary(local.env, at(45), [], at(45), { process_kind: 'continuation' });
  const before = await local.env.PRIVATE_DB.prepare('SELECT COUNT(*) n FROM collection_runs').first(
    'n',
  );
  const status = await report();
  expect(status.collector.last_summary_at).toBe(at(45));
  expect(status.sources[0]).toMatchObject({
    collection: 'complete',
    publication: 'complete',
    source_calendar_evaluation: 'not_evaluated',
  });
  expect(status.sources[1].collection).toBe('missing');
  expect(
    await local.env.PRIVATE_DB.prepare('SELECT COUNT(*) n FROM collection_runs').first('n'),
  ).toBe(before);
  expect(
    await local.env.PRIVATE_DB.prepare('SELECT COUNT(*) n FROM notification_outbox').first('n'),
  ).toBe(0);
});
it('matches old second-bearing runs before false zero-second missing rows', async () => {
  const legacy = at(0.5);
  await local.env.PRIVATE_DB.prepare(
    "INSERT INTO collection_runs(run_id,source_id,scheduled_for,state) VALUES (?,'ecb',?,'pending')",
  )
    .bind(await hash('ecb|' + legacy), legacy)
    .run();
  await fx(legacy);
  await local.env.PRIVATE_DB.prepare(
    "INSERT INTO collection_runs(run_id,source_id,scheduled_for,state) VALUES (?,'ecb',?,'missing')",
  )
    .bind(await hash('ecb|' + time), time)
    .run();
  expect((await report()).sources[0].collection).toBe('complete');
});
it('keeps Models checkpoints in progress, then validates complete capture and publication; quarantine compares reasons and deltas', async () => {
  const s = expandedSource(),
    body = catalog(3);
  body.openai.models['synthetic-model-0'].cost = {};
  await finishModels(local.env, s, body, '2026-10-02T18:17:00.000Z');
  await collectModels(local.env, s, time, {
    synthetic: true,
    now: () => time,
    network: {
      fetcher: async () =>
        new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }),
    },
  });
  const progress = await readOperationalStatus(local.env, [s], at(15));
  expect(progress.sources[0].collection).toBe('in_progress');
  expect(progress.sources[0].publication).toBe('awaiting_collection');
  expect((await readOperationalStatus(local.env, [s], at(25))).sources[0].collection).toBe(
    'progress_stalled',
  );
  expect((await readOperationalStatus(local.env, [s], at(361))).sources[0].collection).toBe(
    'deadline_exceeded',
  );
  await finishModels(local.env, s, body);
  const ready = (await readOperationalStatus(local.env, [s], at(50))).sources[0];
  expect(ready).toMatchObject({
    collection: 'complete',
    snapshot: 'complete',
    publication: 'complete',
    quality: { count: 1, delta: 0, state: 'clear' },
  });
  const e = {
    run: null,
    completeCapture: true,
    quality: { count: 2, reasons: { price_component_missing: 1, large_change_review: 1 } },
    previousQuality: { count: 2, reasons: { price_component_missing: 2 } },
    sourceDate: null,
  };
  // A complete projection with unchanged total but a new quarantine reason still needs review.
  const current = await local.env.PRIVATE_DB.prepare(
    'SELECT run_id FROM collection_runs WHERE scheduled_for=?',
  )
    .bind(time)
    .first<{ run_id: string }>();
  const { runDTO } = await import('../src/admin-read');
  const r = await local.env.PRIVATE_DB.prepare(
    'SELECT run_id,source_id,scheduled_for,state,started_at,finished_at,last_progress_at,observation_count,accepted_count,error_code,recovery_count,next_attempt_at FROM collection_runs WHERE run_id=?',
  )
    .bind(current!.run_id)
    .first<Record<string, unknown>>();
  expect(
    evaluateSource(s, time, at(50), { ...e, run: await runDTO(local.env, r!, at(50)) }).quality
      .state,
  ).toBe('alert');
  const dto = await runDTO(local.env, r!, at(50));
  expect(
    evaluateSource(s, time, at(50), {
      ...e,
      run: dto,
      quality: { count: 3, reasons: { price_component_missing: 2, unretained_mode_conditions: 1 } },
      previousQuality: {
        count: 3,
        reasons: { price_component_missing: 1, unretained_mode_conditions: 2 },
      },
    }).quality,
  ).toMatchObject({
    state: 'alert',
    delta: 0,
    new_codes: [],
    increased_codes: ['price_component_missing'],
  });
  dto.publication.visible_count = 0;
  expect(evaluateSource(s, time, at(50), { ...e, run: dto }).publication).toBe('count_mismatch');
}, 60000);
it('separates source failure, expected disabled policy, active policy stop and inaccessible metadata', async () => {
  await fx();
  await local.env.PRIVATE_DB.prepare(
    "UPDATE collection_runs SET state='failed',error_code='http_403' WHERE source_id='ecb'",
  ).run();
  expect((await report()).sources[0].collection).toBe('failed');
  const disabled = source('ecb');
  disabled.enabled = false;
  expect((await readOperationalStatus(local.env, [disabled], at(50))).sources[0].collection).toBe(
    'not_applicable',
  );
  const stopped = source('ecb');
  stopped.policy.rights.automated_collection = 'denied';
  expect((await readOperationalStatus(local.env, [stopped], at(50))).sources[0].collection).toBe(
    'policy_stopped',
  );
  const broken = {
    ...local.env,
    PRIVATE_DB: {
      prepare() {
        throw new Error('SYNTHETIC_PRIVATE');
      },
    } as unknown as D1Database,
  };
  const unknown = await readOperationalStatus(broken, [source('ecb')], at(50));
  expect(unknown.sources[0].collection).toBe('unknown');
  expect(JSON.stringify(unknown)).not.toContain('SYNTHETIC_PRIVATE');
  await local.env.PRIVATE_DB.prepare("UPDATE sources SET suspended=1 WHERE source_id='ecb'").run();
  expect((await report()).sources[0].signals).toContainEqual({
    key: 'ecb:configuration',
    condition: 'alert',
    code: 'source_suspended',
  });
});
it('does not confuse API network/auth/rate limiting with collection; detects missing monitor receipts separately', () => {
  expect([null, 401, 403, 429, 500, 200].map(apiReachability)).toEqual([
    'connection_error',
    'authentication_or_access_blocked',
    'authentication_or_access_blocked',
    'rate_limited',
    'http_error',
    'reachable',
  ]);
  expect(monitorHeartbeat(at(50), null, 10)).toBe('unknown');
  expect(monitorHeartbeat(at(50), time, 10)).toBe('stale');
  expect(monitorHeartbeat(at(50), at(45), 10)).toBe('recent_receipt');
});
it('preserves old pending through the forward migration and an activation, with a read-only dry-run', async () => {
  await local.mf.dispose();
  local = await localEnv('test', undefined, 5);
  const db = local.env.PRIVATE_DB;
  await db
    .prepare(
      "INSERT INTO notification_outbox(notification_id,payload_json,state,recorded_at) VALUES ('legacy','{}','pending',?)",
    )
    .bind(time)
    .run();
  await applyMigrations(db, 'private', 6);
  const http = vi.fn().mockResolvedValue(new Response('ok'));
  expect(
    (
      await deliverNotifications(
        { ...local.env, ALERT_WEBHOOK_URL: 'https://notify.example.test/synthetic' },
        at(1),
        http,
      )
    ).state,
  ).toBe('activation_required');
  expect((await deliverNotifications(enabled(), at(1), http)).sent).toBe(0);
  const configured = { ...enabled(), NOTIFICATIONS_ACTIVE_FROM: time.replace('.000Z', 'Z') };
  expect(notificationActivation(configured, time)).toBe(time);
  const settings = await readAdmin(
    'settings',
    {},
    { ...local.env, ALERT_WEBHOOK_URL: configured.ALERT_WEBHOOK_URL },
    at(1),
    [source('ecb')],
  );
  expect(settings.settings![0].blockers).toContain('notification_activation_required');
  const overview = await readAdmin('overview', {}, configured, at(1), [source('ecb')]);
  expect(overview.overview!.attention.some((x) => x.id.endsWith(':notification'))).toBe(false);
  await recordNotificationSignals(enabled(), [incident], at(1), true);
  expect(await db.prepare('SELECT COUNT(*) n FROM notification_incidents').first('n')).toBe(0);
  await recordNotificationSignals(enabled(), [incident], at(1));
  expect((await deliverNotifications(enabled(), at(1), http, { dryRun: true })).state).toBe(
    'dry_run',
  );
  expect(http).not.toHaveBeenCalled();
  expect(
    await db
      .prepare(
        "SELECT payload_json,state,attempts,activation_at FROM notification_outbox WHERE notification_id='legacy'",
      )
      .first(),
  ).toEqual({ payload_json: '{}', state: 'pending', attempts: 0, activation_at: null });
});
it('deduplicates concurrency, limits reminders, bounds retries, and sends a single recovery', async () => {
  const env = enabled();
  await Promise.all([
    recordNotificationSignals(env, [incident], at(1)),
    recordNotificationSignals(env, [incident], at(1)),
  ]);
  expect(
    await env.PRIVATE_DB.prepare('SELECT COUNT(*) n FROM notification_outbox').first('n'),
  ).toBe(1);
  const fail = vi
    .fn()
    .mockImplementation(async () => new Response('synthetic failure', { status: 500 }));
  await Promise.all([
    deliverNotifications(env, at(1), fail),
    deliverNotifications(env, at(1), fail),
  ]);
  expect(fail).toHaveBeenCalledTimes(1);
  await deliverNotifications(env, at(2), fail);
  expect(fail).toHaveBeenCalledTimes(1);
  await deliverNotifications(env, at(16), fail);
  await recordNotificationSignals(env, [incident], at(31));
  await deliverNotifications(env, at(31), fail);
  await deliverNotifications(env, at(46), fail);
  expect(fail).toHaveBeenCalledTimes(3);
  await recordNotificationSignals(env, [incident], at(60));
  expect(
    await env.PRIVATE_DB.prepare('SELECT COUNT(*) n FROM notification_outbox').first('n'),
  ).toBe(1);
  await recordNotificationSignals(env, [incident], at(1441));
  expect(
    await env.PRIVATE_DB.prepare('SELECT COUNT(*) n FROM notification_outbox').first('n'),
  ).toBe(2);
  await recordNotificationSignals(env, [quiet], at(1442));
  const ok = vi.fn().mockImplementation(async () => new Response('ok'));
  expect((await deliverNotifications(env, at(1442), ok)).sent).toBe(1);
  expect(JSON.parse(ok.mock.calls[0][1].body).event).toBe('recovered');
  await recordNotificationSignals(env, [quiet], at(1443));
  expect((await deliverNotifications(env, at(1443), ok)).sent).toBe(0);
});
it('does not replay old epochs, expired events, or an incident now unresolved/unknown', async () => {
  const env = enabled();
  await recordNotificationSignals(env, [incident], at(1));
  const send = vi.fn().mockResolvedValue(new Response('ok'));
  expect(
    (await deliverNotifications({ ...env, NOTIFICATIONS_ACTIVE_FROM: at(2) }, at(3), send)).sent,
  ).toBe(0);
  expect((await deliverNotifications(env, at(1442), send)).sent).toBe(0);
  await recordNotificationSignals(
    env,
    [{ ...incident, condition: 'pending', code: 'in_progress' }],
    at(4),
  );
  expect((await deliverNotifications(env, at(4), send)).sent).toBe(0);
  expect(send).not.toHaveBeenCalled();
});
