import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { localEnv } from '../scripts/local-env';
import { collectSource, type RunResult } from '../src/pipeline';
import { recordSummary, watchdog } from '../src/operations';
import { sourceObserver, safeLogCode } from '../src/telemetry';
import { revokeSource } from '../src/publication';
// Node exercises the unchanged scheduled handler; admin-rpc.test covers the workerd entrypoint.
import collector from '../src/collector-handlers';
import { stable } from '../src/util';
import { source, fxFetch, time } from './helpers';

let local: Awaited<ReturnType<typeof localEnv>>;
beforeEach(async () => {
  local = await localEnv();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await local?.mf.dispose();
});
const records = () => {
  const logs: Record<string, unknown>[] = [];
  let elapsed = 0;
  return {
    logs,
    observer: sourceObserver(
      local.env,
      'collection',
      time,
      (r) => logs.push(r),
      () => time,
      () => (elapsed += 125),
    ),
  };
};
const fx = () =>
  collectSource(local.env, source('ecb'), time, {
    synthetic: true,
    now: () => time,
    network: { fetcher: fxFetch() },
  });

it('logs actual source duration and API-visible published counts, with an explicit field allowlist', async () => {
  const { logs, observer } = records();
  const result = await observer(source('ecb'), time, async () => ({
    ...(await fx()),
    secret: 'SYNTHETIC_SECRET',
    headers: { Authorization: 'SYNTHETIC_AUTH' },
    body: 'SYNTHETIC_SOURCE_BODY',
  }));
  expect(result.published).toBe(3);
  expect(logs[0]).toMatchObject({
    phase: 'source_start',
    run_id: null,
    process_kind: 'collection',
  });
  expect(logs[1]).toMatchObject({
    phase: 'source_finish',
    logical_slot: time,
    state: 'complete',
    observation_count: 2,
    published_count: 3,
    elapsed_ms: 125,
    observation_completed_in_this_process: true,
  });
  expect(logs[1].run_id).toBe(result.run_id);
  expect(JSON.stringify(logs)).not.toMatch(
    /SYNTHETIC_SECRET|SYNTHETIC_AUTH|SYNTHETIC_SOURCE_BODY|Authorization|payload_hash|publication_batches/,
  );
  await revokeSource(local.env, 'ecb');
  const revoked = await observer(source('ecb'), time, async () => ({
    ...result,
    reason: 'already_processed',
  }));
  expect(revoked.published).toBe(0);
  expect(logs[3].observation_completed_in_this_process).toBe(false);
});

it('does not log arbitrary error messages or mistake partial and policy skip for completed observations', async () => {
  const { logs, observer } = records();
  const secret = 'synthetic_secret_token';
  for (const state of ['partial', 'pending', 'policy_skipped', 'failed']) {
    const result = await observer(source('ecb'), time, async () => ({
      source_id: 'ecb',
      run_id: 'a'.repeat(64),
      state,
      reason: state === 'policy_skipped' ? 'policy_blocked' : secret,
    }));
    expect(JSON.parse(stable(result))).toEqual(result);
  }
  await expect(
    observer(source('ecb'), time, async () => {
      throw new Error('Authorization: ' + secret);
    }),
  ).rejects.toThrow(secret);
  expect(
    logs
      .filter((l) => l.phase === 'source_finish')
      .every((l) => !l.observation_completed_in_this_process),
  ).toBe(true);
  expect(JSON.stringify(logs)).not.toContain(secret);
  expect(JSON.stringify(logs)).not.toContain('Authorization');
  expect(safeLogCode('http_429')).toBe('http_429');
  expect(safeLogCode('policy_blocked')).toBe('policy_blocked');
});

it('keeps idle continuation summaries but creates no idle notifications or fresh-data claims', async () => {
  const results = [await fx()];
  const summary = await recordSummary(local.env, time, results, time, {
    process_kind: 'collection',
    logical_slot: time,
  });
  expect(summary.observation_completed_sources).toEqual(['ecb']);
  expect(results[0].changes).toBe(0); // same/initial price is a successful observation, not a failure
  await recordSummary(local.env, time, [], '2026-10-03T18:20:00.000Z', {
    process_kind: 'continuation',
  });
  const checks = await watchdog(
    local.env,
    [source('ecb')],
    time,
    '2026-10-03T18:47:00.000Z',
    sourceObserver(
      local.env,
      'watchdog',
      time,
      () => {},
      () => time,
    ),
  );
  const checked = await recordSummary(local.env, time, checks, '2026-10-03T18:47:00.000Z', {
    process_kind: 'watchdog',
    logical_slot: time,
  });
  expect(checked.observation_completed_sources).toEqual([]);
  await recordSummary(local.env, time, [], '2026-10-03T18:50:00.000Z', {
    process_kind: 'continuation',
  });
  const next = '2026-10-04T18:17:00.000Z';
  const reobserved = await collectSource(local.env, source('ecb'), next, {
    synthetic: true,
    now: () => next,
    network: { fetcher: fxFetch() },
  });
  expect(reobserved).toMatchObject({ state: 'complete', observations: 2, changes: 0 });
  expect(reobserved.run_id).not.toBe(results[0].run_id);
  const again = await recordSummary(local.env, next, [reobserved], next, {
    process_kind: 'collection',
  });
  expect(again.observation_completed_sources).toEqual(['ecb']);
  expect(again.last_success).toContainEqual({ source_id: 'ecb', last_success_at: next });
  expect(
    await local.env.PRIVATE_DB.prepare('SELECT COUNT(*) n FROM daily_summaries').first('n'),
  ).toBe(5);
  expect(
    await local.env.PRIVATE_DB.prepare('SELECT COUNT(*) n FROM notification_outbox').first('n'),
  ).toBe(2);
  const failure: RunResult = {
    source_id: 'ecb',
    run_id: 'a'.repeat(64),
    state: 'missing',
    reason: 'scheduled_run_missing',
  };
  await recordSummary(local.env, time, [failure], '2026-10-04T18:47:00.000Z', {
    process_kind: 'watchdog',
  });
  expect(
    await local.env.PRIVATE_DB.prepare('SELECT COUNT(*) n FROM notification_outbox').first('n'),
  ).toBe(3);
  expect(checked.freshness_evaluation).toBe('source_calendar_not_evaluated');
});

it('retains untyped legacy summary/outbox rows and compares only the same process kind', async () => {
  const legacy = JSON.stringify({ sources: [], changed: 0, anomalies: 0 });
  await local.env.PRIVATE_DB.prepare('INSERT INTO daily_summaries VALUES (?,?,?)')
    .bind('legacy', time, legacy)
    .run();
  await local.env.PRIVATE_DB.prepare(
    "INSERT INTO notification_outbox(notification_id,payload_json,state,recorded_at) VALUES (?,?,'pending',?)",
  )
    .bind('legacy', legacy, time)
    .run();
  await recordSummary(local.env, time, [], time, { process_kind: 'continuation' });
  expect(
    await local.env.PRIVATE_DB.prepare(
      'SELECT payload_json,attempts,state FROM notification_outbox WHERE notification_id=?',
    )
      .bind('legacy')
      .first(),
  ).toEqual({ payload_json: legacy, attempts: 0, state: 'pending' });
  expect(
    await local.env.PRIVATE_DB.prepare(
      'SELECT summary_json FROM daily_summaries WHERE summary_id=?',
    )
      .bind('legacy')
      .first('summary_json'),
  ).toBe(legacy);
});

it('scheduled idle continuation reports execution completion without a source update or outbound HTTP', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const http = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected_network'));
  await collector.scheduled(
    { cron: '*/5 18-23 * * *', scheduledTime: Date.parse(time), noRetry() {} },
    {
      ...local.env,
      COLLECTION_ENABLED: 'true',
      COLLECTION_CRON: '17 18 * * *',
      WATCHDOG_CRON: '47 18 * * *',
      GPU_RESUME_CRON: '*/5 18-23 * * *',
    },
    {} as ExecutionContext,
  );
  expect(http).not.toHaveBeenCalled();
  const logs = log.mock.calls.map(([s]) => JSON.parse(s));
  expect(logs.map((l) => l.phase)).toEqual(['collector_start', 'collector_finish']);
  expect(logs[1]).toMatchObject({
    state: 'complete',
    process_kind: 'continuation',
    sources_processed: 0,
    notification_state: 'not_configured',
    logical_slot: null,
  });
  expect(logs[1].elapsed_ms).toBeGreaterThanOrEqual(0);
  expect(
    await local.env.PRIVATE_DB.prepare('SELECT COUNT(*) n FROM notification_outbox').first('n'),
  ).toBe(0);
  const summary = JSON.parse(
    (await local.env.PRIVATE_DB.prepare('SELECT summary_json FROM daily_summaries').first<string>(
      'summary_json',
    ))!,
  );
  expect(summary.observation_completed_sources).toEqual([]);
  expect(summary.last_success).toEqual([]);
  expect(
    await local.env.PUBLIC_DB.prepare(
      'SELECT last_collector_completed_at FROM public_health',
    ).first('last_collector_completed_at'),
  ).toBeTruthy();
});
