import { beforeEach, expect, it, vi } from 'vitest';
import type { CollectorEnv } from '../src/schema';
vi.mock('../src/research/pipeline', () => ({ collectResearchPage: vi.fn() }));
vi.mock('../src/research/collector', () => ({ maintainPrivateGpuResearch: vi.fn() }));
import { collectResearchPage } from '../src/research/pipeline';
import { maintainPrivateGpuResearch } from '../src/research/collector';
import { runDCTracker, maintainDCTracker } from '../src/research/dc-collector';

const monday = '2026-10-26T18:17:00.000Z';
const required = [
  '0007_private_research.sql',
  '0008_research_retention.sql',
  '0009_research_retention_states.sql',
  '0014_research_assessments_append_only.sql',
  '0016_dc_tracker.sql',
];
const environment = (migrations = required) =>
  ({
    ENVIRONMENT: 'production',
    DC_TRACKER_ENABLED: 'true',
    PRIVATE_GPU_RESEARCH_ENABLED: 'true',
    COLLECTION_CRON: '17 18 * * *',
    PRIVATE_DB: {
      prepare: vi.fn(() => ({
        bind: vi.fn().mockReturnThis(),
        all: vi.fn().mockResolvedValue({ results: migrations.map((name) => ({ name })) }),
      })),
    },
  }) as unknown as CollectorEnv;
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.mocked(maintainPrivateGpuResearch).mockResolvedValue(true);
  vi.mocked(collectResearchPage).mockResolvedValue({ run_id: 'synthetic', state: 'complete' });
});

it('keeps DC disabled by default and ignores non-Monday dispatch without touching DB', async () => {
  const env = environment();
  await runDCTracker({ ...env, DC_TRACKER_ENABLED: 'false' }, monday, monday);
  await runDCTracker(env, '2026-10-27T18:17:00.000Z', monday);
  expect(env.PRIVATE_DB.prepare).not.toHaveBeenCalled();
  expect(collectResearchPage).not.toHaveBeenCalled();
});

it('skips acquisition on missing 0016 without adding it to the existing GPU schema gate', async () => {
  const env = environment(required.filter((name) => !name.startsWith('0016')));
  await runDCTracker(env, monday, monday);
  expect(collectResearchPage).not.toHaveBeenCalled();
  expect(maintainPrivateGpuResearch).not.toHaveBeenCalled();
  expect(vi.mocked(console.log).mock.calls.flat().join('')).toContain('dc_schema_unavailable');
});

it('runs eight sources independently and keeps existing research authority on each call', async () => {
  vi.mocked(collectResearchPage).mockRejectedValueOnce(new Error('untrusted page content'));
  const env = environment();
  await expect(runDCTracker(env, monday, monday)).resolves.toBeUndefined();
  expect(maintainPrivateGpuResearch).toHaveBeenCalledTimes(8);
  expect(collectResearchPage).toHaveBeenCalledTimes(8);
  for (const [receivedEnv, c, query, at, options] of vi.mocked(collectResearchPage).mock.calls) {
    expect(receivedEnv).toBe(env);
    expect(c.adapter).toBe('dc_tracker');
    expect(query).toEqual({ kind: 'dc_tracker' });
    expect(at).toBe(monday);
    expect(options).toMatchObject({ current_terms_version: c.terms.version, allow_network: true });
  }
  const logs = vi.mocked(console.log).mock.calls.flat().join('');
  expect(logs).toContain('operation_failed');
  expect(logs).not.toContain('untrusted page content');
});

it('keeps retention separate from weekly acquisition, rotating all eight sources on idle turns', async () => {
  const env = environment();
  const start = Date.parse('2026-10-27T18:20:00.000Z');
  for (let i = 0; i < 24; i++)
    await maintainDCTracker(env, new Date(start + i * 300000).toISOString(), monday);
  expect(maintainPrivateGpuResearch).toHaveBeenCalledTimes(8);
  expect(
    new Set(vi.mocked(maintainPrivateGpuResearch).mock.calls.map(([, c]) => c.source.source_id))
      .size,
  ).toBe(8);
  expect(collectResearchPage).not.toHaveBeenCalled();
  vi.mocked(maintainPrivateGpuResearch).mockClear();
  for (let i = 0; i < 3; i++)
    await maintainDCTracker(
      { ...env, DC_TRACKER_ENABLED: 'false' },
      new Date(start + i * 300000).toISOString(),
      monday,
    );
  expect(maintainPrivateGpuResearch).not.toHaveBeenCalled();
});
