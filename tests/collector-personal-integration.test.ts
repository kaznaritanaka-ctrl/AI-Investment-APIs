import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CollectorEnv } from '../src/schema';
import { activeSources } from '../src/sources';
import collector from '../src/collector-handlers';
import { collectAll } from '../src/pipeline';
import { resumeCollections } from '../src/collection-continuation';
import { queueGPURuns } from '../src/gpu-pipeline';
import { expireGPUData } from '../src/gpu-retention';
import { recordSummary, deliverNotifications, watchdog } from '../src/operations';
import { personalCloudScheduled } from '../src/research/personal-cloud-scheduled';
import { dailyScheduled } from '../src/research/daily-scheduled';

vi.mock('../src/pipeline', () => ({ collectAll: vi.fn() }));
vi.mock('../src/collection-continuation', () => ({ resumeCollections: vi.fn() }));
vi.mock('../src/gpu-pipeline', () => ({ queueGPURuns: vi.fn(), resumeGPURuns: vi.fn() }));
vi.mock('../src/gpu-retention', () => ({ expireGPUData: vi.fn() }));
vi.mock('../src/operations', () => ({
  recordSummary: vi.fn(),
  watchdog: vi.fn(),
  expireEvidence: vi.fn(),
  deliverNotifications: vi.fn(),
}));
vi.mock('../src/notifications', () => ({ recordOperationalNotifications: vi.fn() }));
vi.mock('../src/research/personal-cloud-scheduled', () => ({ personalCloudScheduled: vi.fn() }));
vi.mock('../src/research/daily-scheduled', () => ({ dailyScheduled: vi.fn() }));

const healthWrite = vi.fn();
function env(flags = false): CollectorEnv {
  // Only the scheduled handler's health write is stubbed. Real D1 migrations,
  // legacy capture and personal export are covered by separate integration tests.
  return {
    COLLECTION_ENABLED: 'true',
    COLLECTION_CRON: '17 18 * * *',
    WATCHDOG_CRON: '47 18 * * *',
    GPU_RESUME_CRON: '*/5 18-23 * * *',
    ...(flags
      ? {
          PERSONAL_MAINTENANCE_ENABLED: 'true',
          PERSONAL_DAILY_MAINTENANCE_ENABLED: 'true',
        }
      : {}),
    PUBLIC_DB: { prepare: () => ({ bind: () => ({ run: healthWrite }) }) },
  } as unknown as CollectorEnv;
}
const call = (e: CollectorEnv, minute: number, cron = e.GPU_RESUME_CRON!) =>
  collector.scheduled(
    {
      cron,
      scheduledTime: Date.parse('2026-10-18T18:00:00Z') + minute * 60000,
      noRetry() {},
    },
    e,
    {} as ExecutionContext,
  );

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected_network'));
  vi.mocked(resumeCollections).mockResolvedValue({ results: [], models_work: false });
  vi.mocked(collectAll).mockResolvedValue([]);
  vi.mocked(queueGPURuns).mockResolvedValue([]);
  vi.mocked(watchdog).mockResolvedValue([]);
  vi.mocked(deliverNotifications).mockResolvedValue({ state: 'not_configured', sent: 0 });
  vi.mocked(personalCloudScheduled).mockResolvedValue([]);
  vi.mocked(dailyScheduled).mockResolvedValue([]);
});
afterEach(() => vi.restoreAllMocks());

describe('production Collector plus disabled private research', () => {
  it('preserves the three enabled sources and private PoC policy', () => {
    expect(
      activeSources
        .filter((s) => s.enabled)
        .map((s) => s.source_id)
        .sort(),
    ).toEqual(['ecb', 'models_dev', 'price_of_compute']);
    const poc = activeSources.find((s) => s.source_id === 'price_of_compute')!;
    expect(poc.policy.version).toBe('price_of_compute-20261006-private-v1');
    expect(poc.policy.rights.public_display).toBe('review_required');
    expect(poc.gpu!.partitions).toHaveLength(1);
    expect(poc.gpu!.partitions[0].query).toEqual({ sku: 'h100-sxm' });
  });
  it('keeps legacy retention on every idle slot when personal flags are absent', async () => {
    for (const minute of [0, 5, 10]) await call(env(), minute);
    expect(expireGPUData).toHaveBeenCalledTimes(3);
    expect(personalCloudScheduled).not.toHaveBeenCalled();
    expect(dailyScheduled).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  it('separates GPU retention, initial and daily budgets across idle continuation slots', async () => {
    await call(env(true), 0);
    expect(expireGPUData).toHaveBeenCalledTimes(1);
    expect(personalCloudScheduled).not.toHaveBeenCalled();
    await call(env(true), 5);
    expect(personalCloudScheduled).toHaveBeenCalledTimes(1);
    expect(dailyScheduled).not.toHaveBeenCalled();
    await call(env(true), 10);
    expect(dailyScheduled).toHaveBeenCalledTimes(1);
    expect(expireGPUData).toHaveBeenCalledTimes(1);
    expect(healthWrite).toHaveBeenCalledTimes(3);
  });
  it.each(['models', 'gpu'] as const)(
    'does not stack private maintenance onto %s work',
    async (kind) => {
      vi.mocked(resumeCollections).mockResolvedValue({
        models_work: kind === 'models',
        results:
          kind === 'gpu'
            ? [
                {
                  source_id: 'price_of_compute',
                  run_id: 'synthetic',
                  state: 'pending',
                },
              ]
            : [],
      });
      await call(env(true), 5);
      await call(env(true), 10);
      expect(personalCloudScheduled).not.toHaveBeenCalled();
      expect(dailyScheduled).not.toHaveBeenCalled();
      expect(expireGPUData).not.toHaveBeenCalled();
    },
  );
  it.each([
    ['initial', 5],
    ['daily', 10],
  ] as const)(
    'continues selected %s maintenance after an unrelated summary failure',
    async (kind, minute) => {
      vi.mocked(recordSummary).mockRejectedValue(new Error('unapproved error details'));
      await expect(call(env(true), minute)).rejects.toThrow('operation_failed');
      expect(kind === 'initial' ? personalCloudScheduled : dailyScheduled).toHaveBeenCalledTimes(1);
      expect(healthWrite).not.toHaveBeenCalled();
      expect(expireGPUData).not.toHaveBeenCalled();
    },
  );
  it('defers private work if a failed resume leaves the remaining budget unknown', async () => {
    vi.mocked(resumeCollections).mockRejectedValue(new Error('synthetic resume failure'));
    await expect(call(env(true), 5)).rejects.toThrow('operation_failed');
    expect(personalCloudScheduled).not.toHaveBeenCalled();
    expect(dailyScheduled).not.toHaveBeenCalled();
  });
  it('isolates private failure, keeps legacy completion, and permits the next mode slot', async () => {
    vi.mocked(personalCloudScheduled).mockRejectedValue(new Error('private payload must not leak'));
    await call(env(true), 5);
    expect(healthWrite).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain('private payload');
    await call(env(true), 10);
    expect(dailyScheduled).toHaveBeenCalledTimes(1);
    expect(healthWrite).toHaveBeenCalledTimes(2);
  });
  it('does not add private work to daily intake and preserves legacy source dispatch', async () => {
    const e = env(true);
    await call(e, 17, e.COLLECTION_CRON);
    expect(collectAll).toHaveBeenCalledWith(
      e,
      activeSources.filter((s) => !s.gpu),
      '2026-10-18T18:17:00.000Z',
      expect.anything(),
    );
    expect(queueGPURuns).toHaveBeenCalledWith(
      e,
      activeSources,
      '2026-10-18T18:17:00.000Z',
      expect.any(String),
    );
    expect(personalCloudScheduled).not.toHaveBeenCalled();
    expect(dailyScheduled).not.toHaveBeenCalled();
    expect(expireGPUData).not.toHaveBeenCalled();
  });
  it('keeps disabled collection, unknown Cron and HTTP requests closed', async () => {
    await call({ ...env(true), COLLECTION_ENABLED: 'false' }, 5);
    await call(env(true), 5, 'unconfigured');
    expect(resumeCollections).not.toHaveBeenCalled();
    expect(personalCloudScheduled).not.toHaveBeenCalled();
    expect(dailyScheduled).not.toHaveBeenCalled();
    expect((await collector.fetch()).status).toBe(404);
  });
});
