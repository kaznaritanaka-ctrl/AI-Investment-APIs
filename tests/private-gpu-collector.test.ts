import { beforeEach, it, expect, vi } from 'vitest';
import type { CollectorEnv } from '../src/schema';
import highreso from '../config/proposals/research/highreso_public.json';
import rebro from '../config/proposals/research/rebro_public.json';

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
  vi.mocked(collectPublicGpuDay).mockResolvedValue([]);
  const statement = {
    bind: vi.fn().mockReturnThis(),
    first: vi.fn().mockResolvedValue(null),
    run: vi.fn().mockResolvedValue({}),
    all: vi.fn().mockResolvedValue({
      results: [
        '0007_private_research.sql',
        '0008_research_retention.sql',
        '0009_research_retention_states.sql',
        '0014_research_assessments_append_only.sql',
        '0015_private_gpu_daily.sql',
        '0018_research_identity_links.sql',
      ].map((name) => ({ name })),
    }),
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

it('uses one of three idle slots, alternating maintenance and acquiring only approved Highreso', async () => {
  env.PRIVATE_GPU_RESEARCH_ENABLED = 'true';
  for (let i = 0; i < 12; i++)
    await collector.scheduled(scheduled(start + i * 300000), env, {} as ExecutionContext);
  expect(expireGPUData).toHaveBeenCalledTimes(8);
  expect(purgeResearchEvidence).toHaveBeenCalledTimes(4);
  expect(collectPublicGpuDay).toHaveBeenCalledTimes(2);
  expect(
    vi.mocked(collectPublicGpuDay).mock.calls.map((call) => call[1].map((c) => c.source.source_id)),
  ).toEqual([['highreso_public'], ['highreso_public']]);
  const calls = vi.mocked(purgeResearchEvidence).mock.calls;
  expect(calls.map((c) => c[2]).sort()).toEqual([
    'highreso_public',
    'highreso_public',
    'rebro_public',
    'rebro_public',
  ]);
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
  const enabled = [highreso.source.enabled, rebro.source.enabled];
  highreso.source.enabled = true;
  rebro.source.enabled = true;
  vi.mocked(collectPublicGpuDay).mockRejectedValueOnce(new Error('synthetic acquisition failure'));
  try {
    await expect(
      collector.scheduled(scheduled(at), env, {} as ExecutionContext),
    ).resolves.toBeUndefined();
  } finally {
    [highreso.source.enabled, rebro.source.enabled] = enabled;
  }
  expect(collectPublicGpuDay).toHaveBeenCalledTimes(1);
  expect(vi.mocked(collectPublicGpuDay).mock.calls[0][2]).toBe('2026-10-21T18:17:00.000Z');
  expect(publicPrepare).toHaveBeenCalledTimes(3);
  expect(recordSummary).toHaveBeenCalledTimes(3);
  const output = vi
    .mocked(console.log)
    .mock.calls.map((c) => c[0])
    .join('');
  expect(output).toContain('operation_failed');
  expect(output).not.toContain('synthetic maintenance failure');
});

it('retains the daily logical slot and alternating acquisition dispatch when enabled in test memory', async () => {
  const enabled = [highreso.source.enabled, rebro.source.enabled];
  highreso.source.enabled = true;
  rebro.source.enabled = true;
  vi.mocked(collectPublicGpuDay).mockResolvedValue([]);
  try {
    for (let i = 0; i < 12; i++)
      await collector.scheduled(
        scheduled(start + i * 300000),
        { ...env, PRIVATE_GPU_RESEARCH_ENABLED: 'true' },
        {} as ExecutionContext,
      );
    const calls = vi.mocked(collectPublicGpuDay).mock.calls;
    expect(calls.map((c) => c[1][0].adapter).sort()).toEqual([
      'highreso_public',
      'highreso_public',
      'rebro_public',
      'rebro_public',
    ]);
    expect(new Set(calls.map((c) => c[2]))).toEqual(new Set(['2026-10-21T18:17:00.000Z']));
  } finally {
    [highreso.source.enabled, rebro.source.enabled] = enabled;
  }
});

it('reserves an e-Stat maintenance tick without starting GPU retention or research', async () => {
  vi.mocked(resumeCollections).mockResolvedValueOnce({
    results: [],
    models_work: false,
    estat_work: true,
  });
  await collector.scheduled(
    scheduled(start),
    { ...env, PRIVATE_GPU_RESEARCH_ENABLED: 'true' },
    {} as ExecutionContext,
  );
  expect(expireGPUData).not.toHaveBeenCalled();
  expect(purgeResearchEvidence).not.toHaveBeenCalled();
  expect(collectPublicGpuDay).not.toHaveBeenCalled();
  expect(expireEvidence).toHaveBeenCalledTimes(1);
});
