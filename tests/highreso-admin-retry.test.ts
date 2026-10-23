import { afterEach, beforeEach, expect, it } from 'vitest';
import { localEnv } from '../scripts/local-env';
import { collectResearchPage } from '../src/research/pipeline';
import { FetchFailure } from '../src/network';
import { gpuRetryAt } from '../src/research/retry';
import { highresoReader } from '../src/admin-highreso';
import { publicGpuSource, gpuTime, gpuOptions, gpuFetcher } from './public-gpu-helpers';
import { revokeResearchSource } from '../src/research/retention';

let local: Awaited<ReturnType<typeof localEnv>>;
beforeEach(async () => {
  local = await localEnv('test');
});
afterEach(async () => {
  await local?.mf.dispose();
});

it.each(['timeout', 'network_error'])(
  'retries %s twice after 45 minutes, then waits a day',
  async (code) => {
    const c = await publicGpuSource();
    let at = gpuTime;
    let calls = 0;
    const original = gpuFetcher('highreso_public');
    const fetcher: typeof fetch = async (url, init) => {
      calls++;
      if (String(url).endsWith('/compute/instances')) throw new FetchFailure(code);
      return original(url, init);
    };
    for (let attempt = 1; attempt <= 3; attempt++) {
      await expect(
        collectResearchPage(local.env, c, { kind: 'highreso_public' }, gpuTime, {
          current_terms_version: c.terms.version,
          now: () => at,
          allow_network: true,
          fetcher,
        }),
      ).rejects.toThrow(code);
      const row = await local.env.PRIVATE_DB.prepare(
        "SELECT retry_at,(SELECT COUNT(*) FROM fetch_attempts WHERE fetch_attempts.run_id=research_runs.run_id AND code='research_gpu_sequence') sequence_attempts FROM research_runs",
      ).first();
      expect(row).toEqual({ retry_at: gpuRetryAt(at, code, attempt), sequence_attempts: attempt });
      at = String(row!.retry_at);
    }
    expect(calls).toBe(9);
    expect(
      await local.env.PRIVATE_DB.prepare('SELECT http_page_attempts FROM research_runs').first(),
    ).toEqual({ http_page_attempts: 3 });
  },
);

it('completes the same daily run after a transient page timeout', async () => {
  const c = await publicGpuSource();
  let at = gpuTime;
  let failed = false;
  const original = gpuFetcher('highreso_public');
  const fetcher: typeof fetch = async (url, init) => {
    if (!failed && String(url).endsWith('/compute/instances')) {
      failed = true;
      throw new FetchFailure('timeout');
    }
    return original(url, init);
  };
  const options = {
    current_terms_version: c.terms.version,
    now: () => at,
    allow_network: true,
    fetcher,
  };
  await expect(
    collectResearchPage(local.env, c, { kind: 'highreso_public' }, gpuTime, options),
  ).rejects.toThrow('timeout');
  expect(
    (await collectResearchPage(local.env, c, { kind: 'highreso_public' }, gpuTime, options)).state,
  ).toBe('deferred');
  at = gpuRetryAt(gpuTime, 'timeout', 1);
  expect(
    (await collectResearchPage(local.env, c, { kind: 'highreso_public' }, gpuTime, options)).state,
  ).toBe('complete');
  expect(
    await local.env.PRIVATE_DB.prepare('SELECT COUNT(*) n FROM research_runs').first('n'),
  ).toBe(1);
});

it.each(['http_403', 'rate_limited', 'public_gpu_robots_review_required'])(
  'does not retry %s the same day',
  (code) => {
    expect(gpuRetryAt(gpuTime, code, 1)).toBe('2026-10-19T01:00:00.000Z');
  },
);

it('projects private runs and prices, validates limits, masks errors and fails closed on revocation', async () => {
  const c = await publicGpuSource();
  const run = await collectResearchPage(
    local.env,
    c,
    { kind: 'highreso_public' },
    gpuTime,
    gpuOptions(c),
  );
  // Copy synthetic observations into an explicitly local real-run projection fixture.
  // Retention and identity columns on the original run remain immutable.
  const columns = (
    await local.env.PRIVATE_DB.prepare('PRAGMA table_info(research_runs)').all<{ name: string }>()
  ).results.map((r) => r.name);
  await local.env.PRIVATE_DB.prepare(
    `INSERT INTO research_runs (${columns.join(',')}) SELECT ${columns.map((n) => (n === 'run_id' ? "'" + 'a'.repeat(64) + "'" : n === 'synthetic' ? '0' : n === 'last_error' ? "'arbitrary-sensitive-error'" : n)).join(',')} FROM research_runs WHERE run_id=?`,
  )
    .bind(run.run_id)
    .run();
  const observationColumns = (
    await local.env.PRIVATE_DB.prepare('PRAGMA table_info(research_gpu_observations)').all<{
      name: string;
    }>()
  ).results.map((r) => r.name);
  await local.env.PRIVATE_DB.prepare(
    `INSERT INTO research_gpu_observations (${observationColumns.join(',')}) SELECT ${observationColumns.map((n) => (n === 'run_id' ? "'" + 'a'.repeat(64) + "'" : n === 'observation_id' ? "observation_id || '-admin'" : n)).join(',')} FROM research_gpu_observations WHERE run_id=?`,
  )
    .bind(run.run_id)
    .run();
  const reader = highresoReader(local.env, c, gpuTime);
  const result = await reader.highresoRuns();
  expect(result.runs[0]).toMatchObject({
    state: 'success',
    run_date_jst: '2026-10-18',
    observation_count: 4,
    last_error: 'operation_failed',
  });
  await expect(reader.highresoRuns(31)).rejects.toThrow();
  const prices = await reader.highresoLatestPrices();
  expect(prices.prices).toHaveLength(4);
  expect(prices.prices[0]).toMatchObject({ first_seen: gpuTime, last_changed: gpuTime });
  expect(JSON.stringify(prices)).not.toMatch(/evidence|domain_json/);
  await revokeResearchSource(local.env, c.source.source_id, gpuTime);
  await expect(reader.highresoRuns()).rejects.toThrow();
  await expect(reader.highresoLatestPrices()).rejects.toThrow();
});
