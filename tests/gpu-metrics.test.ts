import { beforeEach, afterEach, it, expect } from 'vitest';
import { localEnv } from '../scripts/local-env';
import { gpuSource, rental, seedRental, item, ebayFetcher, finishGPU } from './gpu-helpers';
import { source, time, fxFetch } from './helpers';
import { collectSource } from '../src/pipeline';
import { handle } from '../src/api';
import { revokeSource } from '../src/publication';
import { compareGPUConditions } from '../src/gpu-comparisons';
import { gpuComparison } from '../src/gpu';
import { expireGPUData } from '../src/gpu-retention';
let local: Awaited<ReturnType<typeof localEnv>>;
beforeEach(async () => {
  local = await localEnv();
});
afterEach(async () => {
  await local?.mf.dispose();
});
const api = async (path: string, now = time) =>
  (
    await handle(
      new Request('https://fixture.test' + path),
      { PUBLIC_DB: local.env.PUBLIC_DB },
      now,
    )
  ).json() as Promise<any>;
it('persists JP-US FX conversion with original currency and input observation IDs, and withdraws on FX rights suspension', async () => {
  await collectSource(local.env, source('ecb'), time, {
    synthetic: true,
    now: () => time,
    network: { fetcher: fxFetch() },
  });
  const us = gpuSource('lambda'),
    jp = gpuSource('lambda');
  us.source_id = 'synthetic_us';
  jp.source_id = 'synthetic_jp';
  await seedRental(local.env, us, [await rental('US', '100')], time);
  await seedRental(local.env, jp, [await rental('JP', '15000')], time);
  const data = (await api('/v1/gpu/comparisons')).data;
  expect(data).toHaveLength(1);
  expect(data[0]).toMatchObject({ kind: 'jp_us', status: 'ok', ratio: '1' });
  expect(data[0].fx_conversion).toMatchObject({
    original_amount: '15000',
    original_currency: 'JPY',
    converted_amount: '100',
    source_date: '2026-10-02',
  });
  expect(data[0].fx_conversion.fx_observation_ids).toHaveLength(2);
  expect(
    await local.env.PRIVATE_DB.prepare(
      'SELECT COUNT(*) AS n FROM gpu_metric_lineage WHERE input_observation_id IS NOT NULL',
    ).first('n'),
  ).toBe(2);
  await revokeSource(local.env, 'ecb');
  expect((await api('/v1/gpu/comparisons')).data).toHaveLength(0);
  expect((await api('/v1/gpu/metrics')).data).toHaveLength(2);
});
it('returns incompatible tax/contract/region evidence as exclusions and never invents FX history', async () => {
  const a = await rental('US'),
    b = await rental('JP', '15000');
  b.tax_status = 'unknown';
  expect(compareGPUConditions(gpuComparison(a), gpuComparison(b), 'jp_us')).toContain(
    'unknown_tax',
  );
  b.tax_status = 'excluded';
  b.network_conditions = 'different';
  expect(compareGPUConditions(gpuComparison(a), gpuComparison(b), 'jp_us')).toContain(
    'mismatched_network',
  );
  const us = gpuSource('lambda'),
    jp = gpuSource('lambda');
  us.source_id = 'synthetic_us';
  jp.source_id = 'synthetic_jp';
  await seedRental(local.env, us, [a], time);
  b.network_conditions = a.network_conditions;
  await seedRental(local.env, jp, [b], time);
  expect((await api('/v1/gpu/comparisons')).data[0]).toMatchObject({
    status: 'incomparable',
    ratio: null,
    comparison_exclusions: ['insufficient_fx_history'],
  });
});
it('computes exact 7-day and matched-offer changes separately from composition, and preserves insufficient 30/90-day results', async () => {
  const s = gpuSource('lambda');
  await seedRental(
    local.env,
    s,
    [await rental('US', '100', 'a'), await rental('US', '200', 'b')],
    time,
  );
  const next = '2026-10-10T18:17:00.000Z';
  await seedRental(
    local.env,
    s,
    [await rental('US', '200', 'a'), await rental('US', '600', 'c')],
    next,
  );
  const data = (await api('/v1/gpu/metrics', next)).data.at(-1);
  expect(data.median).toBe('400');
  expect(data.changes['7d'].price_median_percent).toBe('166.6666666666666666666666666666666666667');
  expect(data.matched_offers).toMatchObject({
    sample_count: 1,
    median_change_percent: '100',
    newly_seen: 1,
    not_seen: 1,
  });
  expect(data.changes['30d'].status).toBe('insufficient_data');
  expect(data.changes['90d'].price_median_percent).toBeNull();
});
it('keeps private-only source and account-specific prices out of public tables', async () => {
  const privateSource = gpuSource('lambda');
  privateSource.source_id = 'synthetic_private';
  privateSource.policy.rights.public_display = 'denied';
  await seedRental(local.env, privateSource, [await rental()], time);
  const sourceAccount = gpuSource('lambda'),
    q = await rental();
  q.price_scope = 'account_specific';
  await seedRental(local.env, sourceAccount, [q], time);
  expect((await api('/v1/observations?dataset=gpu_rental')).data).toHaveLength(0);
  expect((await api('/v1/gpu/metrics')).data).toHaveLength(0);
});
it('excludes aggregator observations from independent sample counts and purges normalized data under reviewed source retention', async () => {
  const s = gpuSource('lambda'),
    q = await rental();
  q.secondary_source = true;
  await seedRental(local.env, s, [q], time);
  const data = (await api('/v1/gpu/metrics')).data[0];
  expect(data).toMatchObject({ sample_count: 0, median: null, status: 'insufficient_data' });
  expect(data.exclusions).toContainEqual({ reason: 'secondary_source_not_independent', count: 1 });
  expect(await expireGPUData(local.env, [s], '2026-11-10T18:17:00.000Z')).toBe(1);
  expect(
    await local.env.PRIVATE_DB.prepare('SELECT COUNT(*) AS n FROM gpu_rental').first('n'),
  ).toBe(0);
  expect((await local.env.PRIVATE_DB.prepare('PRAGMA foreign_key_check').all()).results).toEqual(
    [],
  );
});
it('stores a complete empty scope as zero observed listings and hides stale offers from latest', async () => {
  const s = gpuSource();
  await finishGPU(local.env, s, ebayFetcher(s, [item(1)]));
  const next = '2026-10-04T18:17:00.000Z';
  expect((await finishGPU(local.env, s, ebayFetcher(s, [], next), next)).result.state).toBe(
    'complete',
  );
  expect((await api('/v1/gpu/coverage', next)).data.at(-1)).toMatchObject({
    coverage: 'complete',
    observed_offer_count: 0,
  });
  expect((await api('/v1/latest?dataset=gpu_secondary', next)).error.code).toBe('no_observation');
});

it('calculates condition-matched spot and generation ratios with both sample counts', async () => {
  const s = gpuSource('lambda'),
    regular = await rental('US', '100', 'regular'),
    spot = await rental('US', '50', 'spot'),
    next = await rental('US', '200', 'next');
  spot.contract_type = 'spot';
  spot.interruptible = true;
  const { identifyGPU } = await import('../src/gpu');
  Object.assign(next, identifyGPU('H100 80GB PCIe'));
  await seedRental(local.env, s, [regular, spot, next], time);
  const data = (await api('/v1/gpu/comparisons')).data;
  expect(data.find((x: any) => x.kind === 'spot_difference')).toMatchObject({
    status: 'ok',
    ratio: '0.5',
    sample_counts: [1, 1],
  });
  const generation = data.find((x: any) => x.kind === 'generation_ratio' && x.status === 'ok');
  expect(generation).toBeTruthy();
  expect(['0.5', '2']).toContain(generation.ratio);
  expect(generation.performance_adjusted).toBe(false);
});
it('never copies a comparison with a private-only input into the public database', async () => {
  const jp = gpuSource('lambda'),
    us = gpuSource('lambda');
  jp.source_id = 'synthetic_private_jp';
  jp.policy.rights.public_display = 'denied';
  us.source_id = 'synthetic_public_us';
  await seedRental(local.env, jp, [await rental('JP', '15000')], time);
  await seedRental(local.env, us, [await rental('US', '100')], time);
  expect(
    await local.env.PRIVATE_DB.prepare(
      "SELECT COUNT(*) AS n FROM derived_observations WHERE json_extract(value_json,'$.kind')='jp_us'",
    ).first('n'),
  ).toBe(1);
  expect(
    await local.env.PUBLIC_DB.prepare(
      "SELECT COUNT(*) AS n FROM published_gpu_metrics WHERE json_extract(public_json,'$.kind')='jp_us'",
    ).first('n'),
  ).toBe(0);
});
