import { it, expect } from 'vitest';
import { gpuSource, rental, item } from './gpu-helpers';
import { identifyGPU, classifyListing, gpuComparison, gpuExclusions } from '../src/gpu';
import { gpuEvidenceFromBody, parseGPUProjection } from '../src/gpu-adapters';
import { gpuRequestPlan, validateNextURL } from '../src/request-plan';
import { fetchGPURequest } from '../src/network';
import { stable } from '../src/util';
import { inspectPreflight } from '../scripts/preflight-core';
import deployment from '../config/deployment.json';
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
const collector = JSON.parse(
  readFileSync(new NodeURL('../wrangler.collector.jsonc', import.meta.url), 'utf8'),
);
const apiConfig = JSON.parse(
  readFileSync(new NodeURL('../wrangler.api.jsonc', import.meta.url), 'utf8'),
);
import { sources } from '../src/sources';
import { DCPortfolioSchema } from '../src/dc';
const time = '2026-10-03T18:17:00.000Z';
it('identifies explicit SKU evidence, keeps GiB and ambiguous products unresolved, and separates racks and parts', () => {
  expect(identifyGPU('H100 80GB SXM5').gpu_sku_id).toBe('nvidia-h100-80gb-sxm5');
  expect(identifyGPU('H100 80GiB PCIe').gpu_sku_id).toBeNull();
  expect(identifyGPU('A100 80GB SXM5').gpu_sku_id).toBeNull();
  expect(identifyGPU('GB300 NVL72 rack 288GB').gpu_sku_id).toBeNull();
  for (const title of [
    'A100 80GB PCIe heatsink',
    'H100 80GB SXM5 rental per hour',
    'A100 80GB PCIe server no GPU',
    'broken A100 80GB PCIe single GPU',
  ])
    expect(classifyListing(title, 'used').classification_status).toBe('excluded');
  expect(classifyListing('2x A100 80GB PCIe', 'used').gpu_count_in_lot).toBe(2);
  expect(classifyListing('A100 80GB PCIe', 'used').gpu_count_in_lot).toBeNull();
});
it('never mixes SKU, VRAM, lot, currency, region, or contract conditions', async () => {
  const q = await rental(),
    base = stable(gpuComparison(q));
  for (const patch of [
    { gpu_sku_id: 'different' },
    { vram_gb: '40' },
    { gpu_count: 2 },
    { currency: 'JPY' },
    { region: 'different' },
    { contract_type: 'spot' as const },
  ])
    expect(stable(gpuComparison({ ...q, ...patch }))).not.toBe(base);
  expect(gpuExclusions({ ...q, secondary_source: true })).toContain(
    'secondary_source_not_independent',
  );
});
it('parses documented Lambda projection without substituting host RAM for VRAM or empty regions for zero stock', async () => {
  const s = gpuSource('lambda');
  const body = {
    data: {
      'synthetic-node': {
        instance_type: {
          name: 'synthetic-node',
          gpu_description: 'H100 (80 GB SXM5)',
          price_cents_per_hour: 123,
          specs: { vcpus: 8, memory_gib: 999, storage_gib: 100, gpus: 2 },
        },
        regions_with_capacity_available: [],
      },
    },
  };
  const e = await gpuEvidenceFromBody(
    s,
    s.gpu!.partitions[0],
    'snapshot',
    'scope',
    0,
    time,
    stable(body),
    time,
    true,
  );
  const d = parseGPUProjection(s, e)[0].domain as any;
  expect(d).toMatchObject({
    vram_gb: '80',
    gpu_count: 2,
    amount_decimal: '1.23',
    billing_unit: 'node_hour',
    country: null,
    availability_status: 'unknown',
    availability_gpu_count: null,
  });
  expect(d.includes_cpu_ram_storage).toContain('999');
});
it('preserves Sakura Japan source evidence, per-second billing, date-only validity and account-specific scope', async () => {
  const s = gpuSource('sakura_dok'),
    body = {
      meta: { page: 1, page_size: 50, total_pages: 1, count: 1, next: null, previous: null },
      results: [
        {
          plan: 'h100-80gb',
          price: '7',
          is_overridden: true,
          begin_at: '2026-10-01',
          end_at: '2026-10-31',
        },
      ],
    };
  const e = await gpuEvidenceFromBody(
    s,
    s.gpu!.partitions[0],
    'snapshot',
    'scope',
    0,
    time,
    stable(body),
    time,
    true,
  );
  const d = parseGPUProjection(s, e)[0].domain as any;
  expect(d).toMatchObject({
    country: 'JP',
    region: 'is1a',
    currency: 'JPY',
    billing_unit: 'second',
    price_scope: 'account_specific',
    source_effective_until_date: '2026-10-31',
    form_factor: 'unknown',
    gpu_sku_id: null,
  });
});
it('stores only the approved minimal listing projection and rejects response-supplied pagination destinations', async () => {
  const s = gpuSource(),
    row = {
      ...item(1),
      seller: { username: 'DO_NOT_STORE' },
      description: 'DO_NOT_STORE',
      image: { imageUrl: 'https://fixture.test/DO_NOT_STORE' },
    };
  const e = await gpuEvidenceFromBody(
    s,
    s.gpu!.partitions[0],
    'snapshot',
    'scope',
    0,
    time,
    stable({ total: 1, limit: 50, offset: 0, itemSummaries: [row] }),
    time,
    true,
  );
  expect(e.body).not.toContain('DO_NOT_STORE');
  expect(e.body).not.toContain('title');
  expect(() =>
    validateNextURL(s, s.gpu!.partitions[0], 0, time, 'https://untrusted.test/next'),
  ).toThrow();
  expect(() =>
    gpuRequestPlan({ ...s, endpoint: 'https://untrusted.test' }, s.gpu!.partitions[0], 0, time),
  ).toThrow();
});
it('marks Price of Compute provider quotes secondary and leaves availability unknown', async () => {
  const s = gpuSource('price_of_compute');
  const e = await gpuEvidenceFromBody(
    s,
    s.gpu!.partitions[0],
    'snapshot',
    'scope',
    0,
    time,
    stable({
      sku: 'H100-SXM',
      providers: [{ provider: 'synthetic', pricing_type: 'on_demand', usd_per_gpu_hr: '7' }],
    }),
    time,
    true,
  );
  const d = parseGPUProjection(s, e)[0].domain as any;
  expect(d).toMatchObject({
    secondary_source: true,
    availability_status: 'unknown',
    origin_offer_id: null,
  });
  expect(gpuExclusions(d)).toContain('secondary_source_not_independent');
});
it('stops missing authentication, 403 and long Retry-After safely without following redirects or leaking bearer tokens into URLs', async () => {
  const s = gpuSource('lambda');
  let calls = 0;
  const fetcher = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls++;
    expect(String(url)).not.toContain('secret');
    expect(init?.redirect).toBe('manual');
    return new Response('{}', { status: 403, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  await expect(
    fetchGPURequest(s, {} as any, s.gpu!.partitions[0], 0, time, { now: () => time, fetcher }),
  ).rejects.toThrow('authentication_not_configured');
  expect(calls).toBe(0);
  await expect(
    fetchGPURequest(
      s,
      { LAMBDA_API_KEY: 'synthetic-secret' } as any,
      s.gpu!.partitions[0],
      0,
      time,
      { now: () => time, fetcher },
    ),
  ).rejects.toThrow();
  expect(calls).toBe(1);
  const limited = (async () =>
    new Response('{}', {
      status: 429,
      headers: { 'retry-after': '3600', 'content-type': 'application/json' },
    })) as typeof fetch;
  await expect(
    fetchGPURequest(
      s,
      { LAMBDA_API_KEY: 'synthetic-secret' } as any,
      s.gpu!.partitions[0],
      0,
      time,
      { now: () => time, fetcher: limited },
    ),
  ).rejects.toMatchObject({ retry_at: '2026-10-03T19:17:00.000Z' });
});
it('fails offline preflight on placeholders, mismatched accounts, Cron activation and unreviewed retention', () => {
  const report = inspectPreflight(deployment, collector, apiConfig, sources, {});
  expect(report.static_valid).toBe(true);
  expect(report.ready).toBe(false);
  expect(report.blockers).toContain('d1_ids_placeholder');
  expect(
    inspectPreflight(
      deployment,
      { ...collector, triggers: { crons: ['17 18 * * *'] } },
      apiConfig,
      sources,
    ).errors,
  ).toContain('bootstrap_cron_not_stopped');
  expect(
    inspectPreflight(deployment, collector, { ...apiConfig, r2_buckets: [{}] }, sources).errors,
  ).toContain('public_worker_private_binding_or_trigger');
  expect(
    inspectPreflight(deployment, collector, apiConfig, sources, {
      CLOUDFLARE_ACCOUNT_ID: 'different',
    }).errors,
  ).toContain('environment_target_account_mismatch');
  const s = gpuSource();
  s.gpu!.retention.reviewed_ref = null;
  expect(inspectPreflight(deployment, collector, apiConfig, [s]).blockers).toContain(
    'ebay_browse:retention_unreviewed',
  );
});
it('keeps DC project/site/phase capacity bases distinct and rejects corporate collaboration as site delivery', () => {
  const evidence = {
    source_id: 'synthetic',
    source_url: 'https://fixture.test',
    source_policy_version: 'synthetic',
    observed_at: time,
    published_at: null,
    source_date: null,
    evidence_ref: 'synthetic-only',
    basis: 'announced' as const,
    confidence: 'unverified' as const,
  };
  const valid = {
    schema_version: 'dc-research-v1',
    projects: [
      {
        project_id: 'p',
        name: 'Synthetic project',
        operator_entity_id: null,
        country: null,
        evidence,
      },
    ],
    sites: [
      {
        site_id: 's',
        project_id: 'p',
        name: 'Synthetic site',
        region: null,
        location_evidence_ref: null,
        evidence,
      },
    ],
    phases: [
      {
        phase_id: 'f',
        site_id: 's',
        phase_label: 'Synthetic phase',
        status: 'proposed',
        planned_service_date: null,
        actual_service_date: null,
        evidence,
      },
    ],
    capacity_observations: ['planned_mw', 'it_operational_mw'].map((kind, i) => ({
      measure_id: String(i),
      mw: String(i),
      measure_kind: kind,
      scope: 'phase',
      scope_id: 'f',
      as_of_date: null,
      evidence,
    })),
    relationships: [],
  };
  expect(DCPortfolioSchema.safeParse(valid).success).toBe(true);
  expect(
    DCPortfolioSchema.safeParse({
      ...valid,
      relationships: [
        {
          relationship_id: 'r',
          from_entity_id: 'a',
          to_entity_id: 'b',
          kind: 'corporate_collaboration',
          project_id: 'p',
          site_id: 's',
          phase_id: 'f',
          delivery_date: '2026-10-01',
          evidence,
        },
      ],
    }).success,
  ).toBe(false);
});
