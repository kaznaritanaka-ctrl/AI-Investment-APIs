import { beforeEach, it, expect, vi } from 'vitest';
import type { CollectorEnv } from '../src/schema';

vi.mock('../src/collection-continuation', () => ({ resumeCollections: vi.fn() }));
vi.mock('../src/gpu-retention', () => ({ expireGPUData: vi.fn() }));
vi.mock('../src/operations', () => ({
  recordSummary: vi.fn(),
  deliverNotifications: vi.fn().mockResolvedValue({ state: 'not_configured', sent: 0 }),
  watchdog: vi.fn(),
  expireEvidence: vi.fn(),
}));
vi.mock('../src/notifications', () => ({ recordOperationalNotifications: vi.fn() }));
vi.mock('../src/research/pipeline', () => ({
  purgeResearchEvidence: vi.fn(),
  reconcileResearchRun: vi.fn(),
}));
vi.mock('../src/research/public-gpu', () => ({ collectPublicGpuDay: vi.fn() }));
import collector from '../src/collector-handlers';
import { resumeCollections } from '../src/collection-continuation';
import { expireGPUData } from '../src/gpu-retention';
import { expireEvidence, recordSummary } from '../src/operations';
import { purgeResearchEvidence } from '../src/research/pipeline';
import { collectPublicGpuDay } from '../src/research/public-gpu';
import { privateGpuResearchTurn } from '../src/research/collector';

const start = Date.parse('2026-10-21T18:20:00.000Z');
let privatePrepare: ReturnType<typeof vi.fn>, publicPrepare: ReturnType<typeof vi.fn>;
let env: CollectorEnv;
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.mocked(resumeCollections).mockResolvedValue({ results: [], models_work: false });
  vi.mocked(purgeResearchEvidence).mockResolvedValue(undefined);
  const statement = {
    bind: vi.fn().mockReturnThis(),
    first: vi.fn().mockResolvedValue(null),
    run: vi.fn().mockResolvedValue({}),
  };
  privatePrepare = vi.fn().mockReturnValue(statement);
  publicPrepare = vi.fn().mockReturnValue(statement);
  env = {
    PRIVATE_DB: { prepare: privatePrepare } as unknown as D1Database,
    PUBLIC_DB: { prepare: publicPrepare } as unknown as D1Database,
    EVIDENCE: { get: vi.fn().mockResolvedValue(null) } as unknown as R2Bucket,
    ENVIRONMENT: 'production',
    COLLECTION_ENABLED: 'true',
    COLLECTION_CRON: '17 18 * * *',
    WATCHDOG_CRON: '47 18 * * *',
    GPU_RESUME_CRON: '*/5 18-23 * * *',
  };
});
const scheduled = (at: number) => ({ cron: env.GPU_RESUME_CRON!, scheduledTime: at, noRetry() {} });

it.each([undefined, 'false', 'TRUE'])(
  'preserves every legacy idle action with flag %s and never touches research DB/R2',
  async (flag) => {
    for (let i = 0; i < 6; i++)
      await collector.scheduled(
        scheduled(start + i * 300000),
        { ...env, PRIVATE_GPU_RESEARCH_ENABLED: flag },
        {} as ExecutionContext,
      );
    expect(expireGPUData).toHaveBeenCalledTimes(6);
    expect(expireEvidence).toHaveBeenCalledTimes(6);
    expect(recordSummary).toHaveBeenCalledTimes(6);
    expect(publicPrepare).toHaveBeenCalledTimes(6);
    expect(privatePrepare).not.toHaveBeenCalled();
    expect(env.EVIDENCE.get).not.toHaveBeenCalled();
    expect(purgeResearchEvidence).not.toHaveBeenCalled();
    expect(collectPublicGpuDay).not.toHaveBeenCalled();
  },
);

it('uses one of three idle slots, alternating sources with a stable daily collection identity', async () => {
  env.PRIVATE_GPU_RESEARCH_ENABLED = 'true';
  for (let i = 0; i < 12; i++)
    await collector.scheduled(scheduled(start + i * 300000), env, {} as ExecutionContext);
  expect(expireGPUData).toHaveBeenCalledTimes(8);
  expect(purgeResearchEvidence).toHaveBeenCalledTimes(4);
  expect(collectPublicGpuDay).toHaveBeenCalledTimes(4);
  const calls = vi.mocked(collectPublicGpuDay).mock.calls;
  expect(calls.map((c) => c[1][0].adapter).sort()).toEqual([
    'highreso_public',
    'highreso_public',
    'rebro_public',
    'rebro_public',
  ]);
  expect(new Set(calls.map((c) => c[2]))).toEqual(new Set(['2026-10-21T18:17:00.000Z']));
  expect(calls.every((c) => c[0].ENVIRONMENT === 'production')).toBe(true);
  expect(publicPrepare).toHaveBeenCalledTimes(12);
});

it('gives active legacy collection priority and isolates maintenance/acquisition faults', async () => {
  env.PRIVATE_GPU_RESEARCH_ENABLED = 'true';
  const at = Array.from({ length: 3 }, (_, i) => start + i * 300000).find(
    (t) => privateGpuResearchTurn(env, new Date(t).toISOString()) !== null,
  )!;
  vi.mocked(resumeCollections).mockResolvedValueOnce({ results: [], models_work: true });
  await collector.scheduled(scheduled(at), env, {} as ExecutionContext);
  expect(purgeResearchEvidence).not.toHaveBeenCalled();
  vi.mocked(purgeResearchEvidence).mockRejectedValueOnce(
    new Error('synthetic maintenance failure'),
  );
  await collector.scheduled(scheduled(at), env, {} as ExecutionContext);
  expect(collectPublicGpuDay).not.toHaveBeenCalled();
  vi.mocked(collectPublicGpuDay).mockRejectedValueOnce(new Error('synthetic acquisition failure'));
  await expect(
    collector.scheduled(scheduled(at), env, {} as ExecutionContext),
  ).resolves.toBeUndefined();
  expect(publicPrepare).toHaveBeenCalledTimes(3);
  expect(recordSummary).toHaveBeenCalledTimes(3);
});
