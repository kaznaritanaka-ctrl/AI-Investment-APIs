import { sources } from '../src/sources';
const time = '2026-10-03T18:17:00.000Z';
const source = (id: string): Source => structuredClone(sources.find((s) => s.source_id === id)!);
const responder = (body: string): typeof fetch =>
  (async () =>
    new Response(body, { headers: { 'content-type': 'application/json' } })) as typeof fetch;
import { collectSource } from '../src/pipeline';
import { stable } from '../src/util';
import { gpuRequestPlan } from '../src/request-plan';
import type { CollectorEnv, Source } from '../src/schema';
export function gpuSource(id = 'ebay_browse'): Source {
  const s = source(id);
  s.enabled = true;
  for (const key of Object.keys(s.policy.rights))
    s.policy.rights[key as keyof typeof s.policy.rights] = 'allowed';
  s.policy.version = id + '-synthetic-only-v1';
  s.policy.fields = ['gpu_projection_v1'];
  s.policy.valid_from = '2026-01-01T00:00:00.000Z';
  s.policy.valid_until = null;
  s.gpu!.owner_approval_ref = 'synthetic-test-only';
  s.gpu!.retention = {
    evidence_days: 30,
    archive_days: 30,
    normalized_days: 30,
    backup_days: 30,
    reviewed_ref: 'synthetic-test-only',
  };
  s.gpu!.partitions = s.gpu!.partitions.slice(0, 1);
  s.gpu!.partitions[0].models = [];
  s.gpu!.pages_per_invocation = 1;
  s.gpu!.page_size = 50;
  s.max_records = 100;
  s.gpu!.max_pages = id === 'ebay_browse' ? 100 : 1;
  return s;
}
export function item(id: number, price = '100', title = 'NVIDIA A100 80GB PCIe single GPU') {
  return {
    itemId: 'synthetic-' + id,
    title,
    condition: 'Used',
    buyingOptions: ['FIXED_PRICE'],
    price: { value: price, currency: 'USD' },
    itemLocation: { country: 'US' },
    itemCreationDate: '2026-09-01T00:00:00.000Z',
  };
}
export function ebayFetcher(
  s: Source,
  items: ReturnType<typeof item>[],
  slot = time,
  options: { failPage?: number; missingNext?: boolean } = {},
): typeof fetch {
  return (async (url: RequestInfo | URL) => {
    const u = new URL(String(url));
    if (u.pathname.includes('oauth2'))
      return responder(stable({ access_token: 'synthetic-token', expires_in: 7200 }))(
        'https://fixture.test',
      );
    const page = Number(u.searchParams.get('offset')) / s.gpu!.page_size;
    if (page === options.failPage)
      return new Response('unavailable', {
        status: 503,
        headers: { 'content-type': 'application/json' },
      });
    const next =
      (page + 1) * s.gpu!.page_size < items.length
        ? gpuRequestPlan(s, s.gpu!.partitions[0], page + 1, slot).url
        : undefined;
    const body = {
      total: items.length,
      limit: s.gpu!.page_size,
      offset: page * s.gpu!.page_size,
      itemSummaries: items.slice(page * s.gpu!.page_size, (page + 1) * s.gpu!.page_size),
      ...(next && !options.missingNext ? { next } : {}),
    };
    return responder(stable(body))('https://fixture.test');
  }) as typeof fetch;
}
export async function finishGPU(env: CollectorEnv, s: Source, fetcher: typeof fetch, slot = time) {
  const results = [];
  for (let n = 0; n < 150; n++) {
    const r = await collectSource(
      {
        ...env,
        EBAY_CLIENT_ID: 'synthetic-client',
        EBAY_CLIENT_SECRET: 'synthetic-secret',
        LAMBDA_API_KEY: 'synthetic-key',
        SAKURA_ACCESS_TOKEN: 'synthetic-token',
        SAKURA_ACCESS_SECRET: 'synthetic-secret',
      },
      s,
      slot,
      { synthetic: true, now: () => slot, network: { fetcher, sleep: async () => {} } },
    );
    results.push(r);
    if (['complete', 'partial', 'failed', 'policy_skipped'].includes(r.state))
      return { result: r, results };
  }
  throw new Error('synthetic_iteration_limit');
}

export async function seedRental(
  env: CollectorEnv,
  s: Source,
  quotes: import('../src/gpu').GPURental[],
  slot: string,
) {
  const { hash } = await import('../src/util'),
    { syncSource } = await import('../src/publication'),
    { ingestGPUPage, snapshot, finalizeGPU } = await import('../src/gpu-store'),
    { finalizeGPUMetrics } = await import('../src/gpu-metrics');
  await syncSource(env, s, slot);
  const run = await hash(s.source_id + '|' + slot),
    scope = await hash(s.source_id + '|synthetic-rental-scope'),
    id = await hash(run + '|synthetic');
  await env.PRIVATE_DB.prepare(
    "INSERT INTO collection_runs(run_id,source_id,scheduled_for,state) VALUES (?,?,?,'pending')",
  )
    .bind(run, s.source_id, slot)
    .run();
  await env.PRIVATE_DB.prepare(
    "INSERT INTO gpu_snapshots(snapshot_id,run_id,source_id,policy_version,dataset,partition_id,scope_hash,scope_json,state,started_at,data_origin) VALUES (?,?,?,?,'gpu_rental','catalog',?,'{}','collecting',?,'synthetic')",
  )
    .bind(id, run, s.source_id, s.policy.version, scope, slot)
    .run();
  const body = stable({ records: quotes }),
    h = await hash(body),
    e = {
      format: 'gpu_projection_v1' as const,
      body,
      observed_at: slot,
      response_status: 200,
      payload_hash: h,
      evidence_hash: h,
      bytes: body.length,
      etag: null,
      last_modified: null,
      synthetic: true,
      source_id: s.source_id,
      source_policy_version: s.policy.version,
      gpu_page: {
        snapshot_id: id,
        partition_id: 'catalog',
        scope_hash: scope,
        page_number: 0,
        next_page: null,
        reported_total: quotes.length,
        received_count: quotes.length,
        complete: true,
        issues: [],
      },
    };
  await env.EVIDENCE.put('synthetic/' + id, stable(e));
  await ingestGPUPage(env, s, run, slot, 'synthetic/' + id, e, slot);
  await finalizeGPU(env, s, await snapshot(env, id), slot);
  for (let i = 0; i < 10; i++) {
    const current = await snapshot(env, id);
    if (current.processing_stage === 'done') break;
    await finalizeGPUMetrics(env, s, current, slot);
  }
  return id;
}
export async function rental(
  country = 'US',
  price = '100',
  offer = 'synthetic-offer',
): Promise<import('../src/gpu').GPURental> {
  const { emptyRental } = await import('../src/gpu-adapters');
  const d = emptyRental('synthetic-' + country, offer, 'A100 80GB PCIe', true);
  return Object.assign(d, {
    country,
    region: 'synthetic-' + country,
    region_evidence: 'synthetic-only',
    gpu_count: 1,
    dedicated_or_shared: 'dedicated' as const,
    contract_type: 'on_demand' as const,
    interruptible: false,
    minimum_term: '1 hour',
    commitment: 'none',
    amount_decimal: price,
    currency: country === 'JP' ? 'JPY' : 'USD',
    billing_unit: 'gpu_hour' as const,
    includes_cpu_ram_storage: 'synthetic-equal-node',
    egress_notes: 'synthetic-equal-egress',
    tax_status: 'excluded' as const,
    tax_jurisdiction: country,
    sale_unit: 'single_gpu' as const,
    price_scope: 'public' as const,
    minimum_gpu_count: 1,
    network_conditions: 'synthetic-equal-network',
    availability_status: 'available' as const,
    availability_evidence: 'synthetic-only',
    availability_observed_at: time,
    evidence_pointer: 'synthetic-only',
  });
}
