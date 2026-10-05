import { it as test } from 'vitest';
import { fetchGPURequest } from '../src/network';
import { gpuSource } from './gpu-helpers';
import type { CollectorEnv } from '../src/schema';
import assert from 'node:assert/strict';
import { projectPriceOfCompute, ATTRIBUTION } from '../src/price-of-compute';
import { gpuEvidenceFromBody, parseGPUProjection } from '../src/gpu-adapters';
import { canCollect, canPublish } from '../src/policy';
import sourceConfig from '../config/sources/price_of_compute.json';
import type { Source } from '../src/schema';

// All prices and provider identities in this file are invented. No live response fixture.
const now = '2026-10-05T00:10:00.000Z';
const row = (patch = {}) => ({
  provider: 'synthetic-lab',
  pricing_type: 'on_demand',
  usd_per_gpu_hr: '1.234567890123456789',
  region: null,
  observed_at: '2026-10-04T22:00:00Z',
  ...patch,
});
const document = (rows = [row()], patch = {}) => ({
  sku: 'H100-SXM',
  day: '2026-10-04',
  prices: { on_demand: { usd_per_gpu_hr: 1234, providers: rows.length } },
  providers: rows,
  updated_at: '2026-10-04T23:00:00Z',
  attribution: 'synthetic attribution',
  ...patch,
});
const project = (value = document()) =>
  projectPriceOfCompute(JSON.stringify(value), 'h100-sxm', now);

test('preserves exact decimal numeric tokens without float rounding', () => {
  const input = JSON.stringify(document()).replace(
    '"1.234567890123456789"',
    '1.234567890123456789',
  );
  assert.equal(
    projectPriceOfCompute(input, 'h100-sxm', now).records[0].amount_decimal,
    '1.234567890123456789',
  );
});
test('rejects numeric identities instead of converting them to labels', () => {
  for (const patch of [{ provider: 123 }, { region: 123 }, { pricing_type: 123 }])
    assert.throws(() => project(document([row(patch)])), /invalid_label/);
  assert.throws(() => project(document(undefined, { sku: 123 })), /invalid_label/);
});
test('keeps on-demand, spot and community as three distinct records for the same provider', () => {
  const records = project(
    document(['on_demand', 'spot', 'community'].map((pricing_type) => row({ pricing_type }))),
  ).records;
  assert.equal(new Set(records.map((x) => x.record_key)).size, 3);
  assert.deepEqual(
    records.map((x) => x.source_pricing_type),
    ['on_demand', 'spot', 'community'],
  );
});
test('retains region without inferring country or guarantees', () => {
  const records = project(
    document([row({ region: 'opaque-region-A' }), row({ region: 'opaque-region-B' })]),
  ).records;
  assert.equal(new Set(records.map((x) => x.record_key)).size, 2);
  assert.equal(records[0].source_region, 'opaque-region-A');
  assert.equal(records[0].country, null);
  assert.equal(records[0].availability_status, 'unknown');
  assert.equal(records[0].availability_guaranteed, null);
});
test('separates provider observation, source day, source update, and our retrieval time', () => {
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(project().records[0]).filter(([k]) =>
        ['source_observed_at', 'source_day', 'source_updated_at', 'retrieved_at'].includes(k),
      ),
    ),
    {
      source_observed_at: '2026-10-04T22:00:00Z',
      source_day: '2026-10-04',
      source_updated_at: '2026-10-04T23:00:00Z',
      retrieved_at: now,
    },
  );
});
test('does not mix daily aggregate medians into provider observations', () => {
  assert.equal(project().records.length, 1);
  assert.equal(project().records[0].amount_decimal, '1.234567890123456789');
  assert.equal('prices' in project(), false);
});
test('retains canonical visible attribution and fixed source URL only', () => {
  assert.deepEqual(project().attribution, ATTRIBUTION);
  assert.equal(project().source_url, 'https://priceofcompute.com/api/v1/prices/h100-sxm');
  assert.equal(JSON.stringify(project()).includes('synthetic attribution'), false);
});
test('rejects unreviewed top-level contract fields rather than assuming unchanged scope or units', () => {
  for (const patch of [
    { extra: 'unapproved text' },
    { next_cursor: 'opaque-next-page' },
    { pagination: { has_more: true, next_cursor: 'opaque-next-page' } },
    { currency: 'EUR' },
    { unit: 'node_hour' },
    { price_basis: 'monthly_commitment' },
    { region_scope: 'different-market' },
  ])
    assert.throws(() => project(document(undefined, patch)), /unsupported_root_field/);
});
test('treats secondary quotes as secondary without claiming a verified provider offer', () => {
  const record = project().records[0];
  assert.equal(record.secondary_source, true);
  assert.equal(record.origin_offer_id, null);
  assert.equal(record.observation_basis, 'advertised_quote');
});
test('rejects a response for another SKU', () =>
  assert.throws(() => project(document(undefined, { sku: 'B300' })), /sku_mismatch/));
test('rejects unapproved requested SKU', () =>
  assert.throws(
    () => projectPriceOfCompute(JSON.stringify(document()), 'h200-sxm', now),
    /sku_not_approved/,
  ));
test('rejects unknown pricing types rather than silently classifying them as unknown', () =>
  assert.throws(
    () => project(document([row({ pricing_type: 'reserved' })])),
    /unsupported_pricing_type/,
  ));
test('rejects additional per-provider conditions pending an explicit schema update', () =>
  assert.throws(
    () => project(document([row({ minimum_hours: 24 })])),
    /unsupported_provider_field/,
  ));
test('rejects duplicate same-condition rows instead of colliding silently', () =>
  assert.throws(() => project(document([row(), row()])), /duplicate_provider_condition/));
test('preserves zero as a warning instead of declaring the GPU free', () =>
  assert.deepEqual(project(document([row({ usd_per_gpu_hr: 0 })])).records[0].quality_flags, [
    'zero_price_reported',
  ]));
test('rejects null, negative, nonnumeric and unbounded price values', () => {
  for (const value of [
    null,
    -1,
    'NaN',
    'Infinity',
    '1e1000',
    '1'.repeat(129),
    '1e-9000000000000001',
  ])
    assert.throws(() => project(document([row({ usd_per_gpu_hr: value })])), /invalid_price/);
  const tiny = JSON.stringify(document()).replace('"1.234567890123456789"', '1e-9000000000000001');
  assert.throws(() => projectPriceOfCompute(tiny, 'h100-sxm', now), /invalid_price/);
});
test('rejects ordinary and token-spoofing object or array prices', () => {
  for (const value of [{}, [], { isLosslessNumber: true, value: '1.25' }, { value: '1.25' }])
    assert.throws(() => project(document([row({ usd_per_gpu_hr: value })])), /invalid_price/);
});
test('accepts missing optional provider time and region as unknown', () => {
  const input: any = row();
  delete input.observed_at;
  delete input.region;
  const record = project(document([input])).records[0];
  assert.equal(record.source_observed_at, null);
  assert.equal(record.source_region, null);
  assert.deepEqual(record.quality_flags, ['provider_observation_time_missing']);
});
test('rejects future metadata and impossible calendar dates', () => {
  for (const patch of [
    { day: '2026-10-06' },
    { updated_at: '2026-10-06T00:00:00Z' },
    { day: '2026-02-30' },
  ])
    assert.throws(() => project(document(undefined, patch)), /future_source_time|invalid_day/);
  assert.throws(
    () => project(document([row({ observed_at: '2026-10-06T00:00:00Z' })])),
    /future_source_time/,
  );
  assert.throws(
    () => project(document([row({ observed_at: '2026-02-30T00:00:00Z' })])),
    /invalid_timestamp/,
  );
  assert.throws(
    () => project(document([row({ observed_at: '2026-10-04T22:00:00.000999Z' })])),
    /invalid_timestamp/,
  );
});
test('fails closed if a future API adds pagination', () => {
  assert.throws(
    () => project(document(undefined, { next: 'https://untrusted.invalid' })),
    /pagination_unsupported/,
  );
  assert.throws(
    () => project(document(undefined, { links: { next: '/api/v1/prices/h100-sxm?page=2' } })),
    /pagination_unsupported/,
  );
});
test('bounds bytes and provider records; an empty feed remains empty', () => {
  assert.throws(
    () => projectPriceOfCompute(' '.repeat(262145), 'h100-sxm', now),
    /response_too_large/,
  );
  assert.throws(
    () =>
      project(document(Array.from({ length: 51 }, (_, i) => row({ provider: 'synthetic-' + i })))),
    /provider_limit/,
  );
  assert.equal(project(document([])).records.length, 0);
});
test('rejects error and malformed responses', () => {
  assert.throws(() => project(document(undefined, { errors: ['synthetic'] })), /source_error/);
  assert.throws(() => projectPriceOfCompute('<html>synthetic</html>', 'h100-sxm', now));
});
test('preserves pricing type, region, source clocks, and distinct identity through the current GPU adapter', async () => {
  const source = structuredClone(sourceConfig) as Source;
  const evidence = await gpuEvidenceFromBody(
    source,
    source.gpu!.partitions[0],
    'test-snapshot',
    'test-scope',
    0,
    now,
    JSON.stringify(
      document(
        ['on_demand', 'spot', 'community'].map((pricing_type) =>
          row({ pricing_type, region: 'opaque-region-A' }),
        ),
      ),
    ),
    now,
    true,
  );
  const candidates = parseGPUProjection(source, evidence);
  assert.equal(candidates.length, 3);
  assert.equal(new Set(candidates.map((x) => x.entity_key)).size, 3);
  assert.deepEqual(
    candidates.map((x) => (x.domain as any).contract_type),
    ['on_demand', 'spot', 'unknown'],
  );
  assert.ok(
    candidates.every(
      (x) =>
        (x.domain as any).region === 'opaque-region-A' &&
        x.source_date === '2026-10-04' &&
        x.source_published_at === null,
    ),
  );
});
test('existing gates support an isolated synthetic private-only policy without publication', () => {
  const source = structuredClone(sourceConfig) as Source;
  source.enabled = true;
  source.policy.fields = ['gpu_projection_v1'];
  source.gpu!.owner_approval_ref = 'synthetic-owner-review';
  source.gpu!.retention = {
    evidence_days: 7,
    archive_days: 7,
    normalized_days: 180,
    backup_days: 30,
    reviewed_ref: 'synthetic-retention-review',
  };
  source.policy.retention_days = 7;
  source.policy.rights.automated_collection = 'allowed';
  source.policy.rights.private_storage = 'allowed';
  source.policy.rights.internal_analysis = 'allowed';
  assert.equal(canCollect(source, now), true);
  assert.equal(canPublish(source, now), false);
  assert.equal(canPublish(source, now, true), false);
  source.gpu!.retention.reviewed_ref = null;
  assert.equal(canCollect(source, now), false);
});

test('PoC 2xx body errors never internally retry; other GPU adapters retain their retry behavior', async () => {
  for (const id of ['price_of_compute', 'lambda']) {
    const source = gpuSource(id);
    let calls = 0;
    const result = fetchGPURequest(
      source,
      { LAMBDA_API_KEY: 'synthetic' } as CollectorEnv,
      source.gpu!.partitions[0],
      0,
      now,
      {
        now: () => now,
        sleep: async () => {},
        fetcher: (async () => {
          calls++;
          return new Response(new Uint8Array([0xff]), {
            headers: { 'content-type': 'application/json' },
          });
        }) as typeof fetch,
      },
    );
    await assert.rejects(result, (error) => {
      const e = error as Error & { retry_at: string | null };
      assert.equal(e.message, 'network_error');
      assert.equal(e.retry_at, id === 'price_of_compute' ? '2026-10-05T01:10:00.000Z' : null);
      return true;
    });
    assert.equal(calls, id === 'price_of_compute' ? 1 : 3);
  }
});
