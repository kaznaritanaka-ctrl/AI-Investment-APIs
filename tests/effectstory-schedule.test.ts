import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CollectorEnv } from '../src/schema';

vi.mock('../src/pipeline', () => ({ collectAll: vi.fn() }));
vi.mock('../src/gpu-pipeline', () => ({
  collectGPU: vi.fn(),
  queueGPURuns: vi.fn(),
  resumeGPURuns: vi.fn(),
}));
vi.mock('../src/collection-continuation', () => ({ resumeCollections: vi.fn() }));
vi.mock('../src/gpu-retention', () => ({ expireGPUData: vi.fn() }));
vi.mock('../src/operations', () => ({
  recordSummary: vi.fn(),
  expireEvidence: vi.fn(),
  watchdog: vi.fn(),
  deliverNotifications: vi.fn().mockResolvedValue({ state: 'not_configured', sent: 0 }),
}));
vi.mock('../src/notifications', () => ({ recordOperationalNotifications: vi.fn() }));
vi.mock('../src/research/dc-collector', () => ({
  runDCTracker: vi.fn(),
  maintainDCTracker: vi.fn(),
}));
vi.mock('../src/research/collector', () => ({
  privateGpuResearchTurn: vi.fn().mockReturnValue(null),
  runPrivateGpuResearch: vi.fn(),
}));
import collector from '../src/collector-handlers';
import { collectAll } from '../src/pipeline';
import { collectGPU, queueGPURuns, resumeGPURuns } from '../src/gpu-pipeline';
import { expireGPUData } from '../src/gpu-retention';
import { resumeCollections } from '../src/collection-continuation';
import { effectstoryTurn } from '../src/effectstory-schedule';
import { watchdog } from '../src/operations';

const continuation = '*/5 18-23 * * *';
let env: CollectorEnv;
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const statement = { bind: vi.fn().mockReturnThis(), run: vi.fn().mockResolvedValue({}) };
  env = {
    PUBLIC_DB: { prepare: vi.fn().mockReturnValue(statement) } as unknown as D1Database,
    COLLECTION_ENABLED: 'true',
    COLLECTION_CRON: '17 18 * * *',
    WATCHDOG_CRON: '47 18 * * *',
    GPU_RESUME_CRON: continuation,
  } as CollectorEnv;
  vi.mocked(collectGPU).mockResolvedValue({
    source_id: 'effectstory',
    run_id: 'test',
    state: 'pending',
  });
  vi.mocked(resumeGPURuns).mockResolvedValue([]);
  vi.mocked(resumeCollections).mockResolvedValue({ results: [], models_work: false });
  vi.mocked(collectAll).mockResolvedValue([]);
  vi.mocked(queueGPURuns).mockResolvedValue([]);
  vi.mocked(watchdog).mockResolvedValue([]);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function scheduled(minute: number, cron = continuation) {
  const at = Date.parse('2026-10-29T18:00:00.000Z') + minute * 60000;
  vi.setSystemTime(at);
  await collector.scheduled({ cron, scheduledTime: at, noRetry() {} }, env, {} as ExecutionContext);
}

it('reserves exactly four existing events before the 68 post-intake continuations', () => {
  const early = [],
    later = [];
  for (let i = 0; i < 72; i++) {
    const at = new Date(Date.parse('2026-10-29T18:00:00.000Z') + i * 5 * 60000).toISOString();
    if (effectstoryTurn(at)) early.push(at);
    else later.push(at);
  }
  expect(early.map((at) => at.slice(11, 16))).toEqual(['18:00', '18:05', '18:10', '18:15']);
  expect(later).toHaveLength(68);
});

it('uses only EffectStory intake, two saved-only resumes and one retention invocation in that window', async () => {
  for (const minute of [0, 5, 10, 15]) await scheduled(minute);
  expect(collectGPU).toHaveBeenCalledTimes(1);
  expect(vi.mocked(collectGPU).mock.calls[0][2]).toBe('2026-10-29T18:00:00.000Z');
  expect(resumeGPURuns).toHaveBeenCalledTimes(2);
  for (const call of vi.mocked(resumeGPURuns).mock.calls) {
    expect(call[1].map((s) => s.source_id)).toEqual(['effectstory']);
    expect(call[3]).toBe(true);
  }
  expect(expireGPUData).toHaveBeenCalledTimes(1);
  expect(vi.mocked(expireGPUData).mock.calls[0][1].map((s) => s.source_id)).toEqual([
    'effectstory',
  ]);
  expect(resumeCollections).not.toHaveBeenCalled();
  expect(collectAll).not.toHaveBeenCalled();
  expect(queueGPURuns).not.toHaveBeenCalled();
});

it('does not fetch if the 18:00 event is missed, and keeps EffectStory out of daily intake and later work', async () => {
  await scheduled(5);
  await scheduled(10);
  await scheduled(15);
  expect(collectGPU).not.toHaveBeenCalled();
  await scheduled(17, env.COLLECTION_CRON);
  await scheduled(20);
  await scheduled(47, env.WATCHDOG_CRON);
  expect(collectGPU).not.toHaveBeenCalled();
  for (const fn of [collectAll, queueGPURuns, resumeCollections]) {
    expect(fn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fn).mock.calls[0][1].some((s) => s.source_id === 'effectstory')).toBe(false);
  }
  expect(
    vi
      .mocked(expireGPUData)
      .mock.calls.at(-1)![1]
      .some((s) => s.source_id === 'effectstory'),
  ).toBe(false);
});

it('anchors delayed intake to the 18:00 scheduled event', async () => {
  const at = Date.parse('2026-10-29T18:00:00.000Z');
  vi.setSystemTime(at + 60000);
  await collector.scheduled(
    { cron: continuation, scheduledTime: at, noRetry() {} },
    env,
    {} as ExecutionContext,
  );
  expect(vi.mocked(collectGPU).mock.calls[0][2]).toBe('2026-10-29T18:00:00.000Z');
});
