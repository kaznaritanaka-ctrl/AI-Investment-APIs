import { afterEach, beforeEach, expect, it } from 'vitest';
import { localEnv } from '../scripts/local-env';
import { collectGPU } from '../src/gpu-pipeline';
import { handle } from '../src/api';
import { readAdmin } from '../src/admin-read';
import { domainFields } from '../src/admin-read-data';
import { gpuSource, finishGPU } from './gpu-helpers';
import { GPU_PARSER, PRICE_OF_COMPUTE_PARSER, gpuParser } from '../src/gpu-store';
import { sourceObserver } from '../src/telemetry';
import { gpuRecordKey, gpuComparison, type GPURental } from '../src/gpu';
import { correctGPUPage, finishGPUCorrection } from '../src/gpu-corrections';
import { sources } from '../src/sources';
import { ATTRIBUTION } from '../src/price-of-compute';
import type { Evidence, Observation } from '../src/schema';

// Invented prices, providers and regions only. Never a real API response fixture.
const now = '2026-10-04T18:17:00.000Z';
const row = (patch: Record<string, unknown> = {}) => ({
  provider: 'synthetic-provider',
  pricing_type: 'on_demand',
  usd_per_gpu_hr: '1.234567890123456789',
  region: 'synthetic-region-a',
  observed_at: '2026-10-04T16:00:00Z',
  ...patch,
});
const document = (rows = [row()], patch: Record<string, unknown> = {}) => ({
  sku: 'H100-SXM',
  day: '2026-10-03',
  updated_at: '2026-10-04T17:00:00Z',
  providers: rows,
  prices: { on_demand: { usd_per_gpu_hr: 99999 } },
  attribution: 'UNTRUSTED_ATTRIBUTION',
  ...patch,
});
const fetcher = (body = JSON.stringify(document())): typeof fetch =>
  (async () =>
    new Response(body, { headers: { 'content-type': 'application/json' } })) as typeof fetch;
function privateSource() {
  const s = gpuSource('price_of_compute');
  for (const key of Object.keys(s.policy.rights) as Array<keyof typeof s.policy.rights>)
    s.policy.rights[key] = [
      'automated_collection',
      'private_storage',
      'internal_analysis',
    ].includes(key)
      ? 'allowed'
      : 'review_required';
  return s;
}
let local: Awaited<ReturnType<typeof localEnv>>;
beforeEach(async () => {
  local = await localEnv();
});
afterEach(async () => {
  await local?.mf.dispose();
});
async function observations() {
  const rows = await local.env.PRIVATE_DB.prepare(
    'SELECT o.metadata_json,d.domain_json FROM observations o JOIN gpu_rental d USING(observation_id) ORDER BY o.entity_key',
  ).all<{ metadata_json: string; domain_json: string }>();
  return rows.results.map(
    (r) =>
      ({ ...JSON.parse(r.metadata_json), domain: JSON.parse(r.domain_json) }) as Observation & {
        domain: GPURental;
      },
  );
}
async function assertPrivate() {
  expect(
    await local.env.PUBLIC_DB.prepare('SELECT COUNT(*) n FROM published_observations').first('n'),
  ).toBe(0);
  expect(
    await local.env.PUBLIC_DB.prepare('SELECT COUNT(*) n FROM published_gpu_metrics').first('n'),
  ).toBe(0);
  for (const path of [
    '/v1/latest?dataset=gpu_rental',
    '/v1/observations?dataset=gpu_rental',
    '/v1/gpu/metrics',
    '/v1/gpu/coverage',
  ]) {
    const response = await handle(
      new Request('https://fixture.test' + path),
      { PUBLIC_DB: local.env.PUBLIC_DB },
      now,
    );
    if (path.startsWith('/v1/latest')) {
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ error: { code: 'no_observation' } });
    } else {
      expect(response.status).toBe(200);
      expect(((await response.json()) as { data: unknown[] }).data).toEqual([]);
    }
  }
}
it('persists separate native pricing/region conditions, exact decimals and four clocks through real local D1/R2, privately', async () => {
  const s = privateSource();
  const input = document([
    row(),
    row({ pricing_type: 'spot' }),
    row({ pricing_type: 'community' }),
    row({ region: 'synthetic-region-b' }),
  ]);
  const text = JSON.stringify(input).replaceAll('"1.234567890123456789"', '1.234567890123456789');
  expect((await finishGPU(local.env, s, fetcher(text), now)).result).toMatchObject({
    state: 'complete',
    observations: 4,
  });
  const rows = await observations();
  expect(rows).toHaveLength(4);
  expect(new Set(rows.map((r) => r.entity_key)).size).toBe(4);
  expect(new Set(rows.map((r) => gpuRecordKey(r.domain))).size).toBe(4);
  expect(new Set(rows.map((r) => JSON.stringify(gpuComparison(r.domain)))).size).toBe(4);
  for (const r of rows) {
    expect(r).toMatchObject({
      observed_at: now,
      source_date: '2026-10-03',
      source_published_at: null,
      source_effective_at: null,
      parser_version: PRICE_OF_COMPUTE_PARSER,
    });
    expect(r.domain).toMatchObject({
      amount_decimal: '1.234567890123456789',
      secondary_source: true,
      origin_offer_id: null,
      country: null,
      availability_status: 'unknown',
      availability_observed_at: null,
      availability_guaranteed: null,
      price_of_compute: {
        source_observed_at: '2026-10-04T16:00:00Z',
        source_day: '2026-10-03',
        source_updated_at: '2026-10-04T17:00:00Z',
        retrieved_at: now,
        attribution: ATTRIBUTION,
      },
    });
  }
  expect(
    rows.find((r) => r.domain.price_of_compute?.source_pricing_type === 'spot')?.domain
      .contract_type,
  ).toBe('spot');
  expect(
    rows.find((r) => r.domain.price_of_compute?.source_pricing_type === 'community')?.domain
      .contract_type,
  ).toBe('unknown');
  const objects = await local.env.EVIDENCE.list({ prefix: 'evidence/' });
  expect(objects.objects).toHaveLength(1);
  const saved = await local.env.EVIDENCE.get(objects.objects[0].key);
  const evidence = await saved!.json<Evidence>();
  expect(evidence.format).toBe('gpu_projection_v1');
  expect(evidence.body).not.toMatch(/UNTRUSTED_ATTRIBUTION|99999|"prices"/);
  expect(JSON.parse(evidence.body).price_of_compute.attribution).toEqual(ATTRIBUTION);
  expect((await local.env.PRIVATE_DB.prepare('PRAGMA foreign_key_check').all()).results).toEqual(
    [],
  );
  const snapshot = await local.env.PRIVATE_DB.prepare(
    'SELECT scope_json FROM gpu_snapshots',
  ).first<{ scope_json: string }>();
  expect(JSON.parse(snapshot!.scope_json).classification_version).toBe(PRICE_OF_COMPUTE_PARSER);
  await assertPrivate();
});
it('recovers immutable evidence after interruption without refetching, duplicating, or changing source clocks', async () => {
  const s = privateSource();
  let calls = 0;
  const first = await collectGPU(local.env, s, now, {
    synthetic: true,
    now: () => now,
    network: { fetcher: fetcher() },
    afterEvidenceSaved: async () => {
      throw Error('synthetic_failure');
    },
  });
  expect(first.state).toBe('failed');
  const objects = await local.env.EVIDENCE.list({ prefix: 'evidence/' }),
    key = objects.objects[0].key;
  const before = await (await local.env.EVIDENCE.get(key))!.text();
  const noNetwork = (async () => {
    calls++;
    throw Error('unexpected_network');
  }) as typeof fetch;
  const later = '2026-10-04T18:18:00.000Z';
  let state = '';
  for (let n = 0; n < 5 && state !== 'complete'; n++) {
    state = (
      await collectGPU(local.env, s, now, {
        synthetic: true,
        savedOnly: true,
        now: () => later,
        network: { fetcher: noNetwork },
      })
    ).state;
  }
  expect(state).toBe('complete');
  expect(calls).toBe(0);
  expect(await (await local.env.EVIDENCE.get(key))!.text()).toBe(before);
  const rows = await observations();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ observed_at: now, recorded_at: later });
  const again = await collectGPU(local.env, s, now, {
    synthetic: true,
    now: () => later,
    network: { fetcher: noNetwork },
  });
  expect(again.reason).toBe('already_processed');
  expect(await observations()).toEqual(rows);
  await expect(
    local.env.PRIVATE_DB.prepare("UPDATE observations SET entity_key='mutated'").run(),
  ).rejects.toThrow();
  await expect(
    local.env.PRIVATE_DB.prepare("UPDATE gpu_rental SET domain_json='{}'").run(),
  ).rejects.toThrow();
  await assertPrivate();
});
it.each([
  ['malformed JSON', '<html>synthetic</html>'],
  ['SKU mismatch', JSON.stringify(document(undefined, { sku: 'B300' }))],
  ['unknown pricing type', JSON.stringify(document([row({ pricing_type: 'reserved' })]))],
  [
    'unreviewed root pagination',
    JSON.stringify(document(undefined, { pagination: { has_more: true } })),
  ],
  ['unreviewed root currency', JSON.stringify(document(undefined, { currency: 'EUR' }))],
  [
    'unreviewed root price basis',
    JSON.stringify(document(undefined, { price_basis: 'monthly_commitment' })),
  ],
  ['new provider conditions', JSON.stringify(document([row({ minimum_hours: 24 })]))],
  ['duplicate native condition', JSON.stringify(document([row(), row()]))],
  ['numeric provider', JSON.stringify(document([row({ provider: 123 })]))],
  [
    'spoof numeric object',
    JSON.stringify(document([row({ usd_per_gpu_hr: { isLosslessNumber: true, value: '1.25' } })])),
  ],
  [
    'unsupported pagination',
    JSON.stringify(document(undefined, { next: 'https://untrusted.invalid/next' })),
  ],
  ['missing source clocks', JSON.stringify({ sku: 'H100-SXM', providers: [row()] })],
])('rejects %s before any observation or payload persistence', async (_label, text) => {
  const result = await collectGPU(local.env, privateSource(), now, {
    synthetic: true,
    now: () => now,
    network: { fetcher: fetcher(text) },
  });
  expect(result.state).toBe('failed');
  expect(await observations()).toEqual([]);
  expect((await local.env.EVIDENCE.list({ prefix: 'evidence/' })).objects).toEqual([]);
  expect(
    await local.env.PRIVATE_DB.prepare('SELECT COUNT(*) n FROM raw_artifacts').first('n'),
  ).toBe(0);
  await assertPrivate();
});
it('keeps empty feed metadata and missing optional time/region/zero conservative in persistence', async () => {
  const s = privateSource();
  const input = row({ usd_per_gpu_hr: 0, region: null, observed_at: null });
  expect(
    (await finishGPU(local.env, s, fetcher(JSON.stringify(document([input]))), now)).result.state,
  ).toBe('complete');
  const [r] = await observations();
  expect(r.quality_flags).toEqual(['zero_price_reported', 'provider_observation_time_missing']);
  expect(r.domain).toMatchObject({
    amount_decimal: '0',
    region: null,
    country: null,
    availability_status: 'unknown',
    price_of_compute: { source_observed_at: null },
  });
  const next = '2026-10-05T18:17:00.000Z';
  expect(
    (await finishGPU(local.env, s, fetcher(JSON.stringify(document([]))), next)).result,
  ).toMatchObject({ state: 'complete', observations: 0 });
  const empty = await local.env.PRIVATE_DB.prepare(
    'SELECT received_count,reported_total FROM gpu_snapshots WHERE started_at=?',
  )
    .bind(next)
    .first();
  expect(empty).toEqual({ received_count: 0, reported_total: 0 });
  const objects = await local.env.EVIDENCE.list({ prefix: 'evidence/' });
  const evidence = await Promise.all(
    objects.objects.map(async (o) => (await local.env.EVIDENCE.get(o.key))!.json<Evidence>()),
  );
  const emptyEvidence = evidence.find((e) => JSON.parse(e.body).records.length === 0)!;
  expect(JSON.parse(emptyEvidence.body).price_of_compute).toMatchObject({
    source_day: '2026-10-03',
    retrieved_at: next,
    attribution: ATTRIBUTION,
  });
  await assertPrivate();
});
it('exposes only allowlisted PoC scalars and canonical attribution in owner-only Admin data', async () => {
  const s = privateSource();
  await finishGPU(
    local.env,
    s,
    fetcher(JSON.stringify(document([row({ pricing_type: 'community' })]))),
    now,
  );
  const result = await readAdmin('data', { dataset: 'gpu_rental' }, local.env, now, [s]);
  expect(result.data).toHaveLength(1);
  const d = result.data![0];
  expect(d).toMatchObject({
    private_readable: true,
    attribution: ATTRIBUTION.text,
    source_url: ATTRIBUTION.url,
    source_period: '2026-10-03',
    public_fields: [],
    publication: { state: 'not_published' },
  });
  expect(d.fields).toContainEqual({
    name: 'price_of_compute.source_pricing_type',
    value: 'community',
    unit: null,
  });
  expect(d.fields).toContainEqual({
    name: 'price_of_compute.source_observed_at',
    value: '2026-10-04T16:00:00Z',
    unit: null,
  });
  expect(d.fields).toContainEqual({
    name: 'price_of_compute.retrieved_at',
    value: now,
    unit: null,
  });
  const projected = domainFields({
    price_of_compute: {
      source_pricing_type: 'spot',
      source_observed_at: null,
      Authorization: 'SENTINEL',
      evidence_pointer: 'PRIVATE',
      attribution: { text: 'UNTRUSTED' },
    },
    evidence_pointer: 'PRIVATE',
  });
  expect(projected).toContainEqual({
    name: 'price_of_compute.source_observed_at',
    value: null,
    unit: null,
  });
  expect(JSON.stringify(projected)).not.toMatch(
    /SENTINEL|PRIVATE|UNTRUSTED|Authorization|evidence_pointer/,
  );
  await assertPrivate();
});
it('uses source-scoped parser metadata in telemetry and rejects corrections using the current PoC parser', async () => {
  const s = privateSource();
  const logs: Record<string, unknown>[] = [];
  const observe = sourceObserver(
    local.env,
    'collection',
    now,
    (r) => logs.push(r),
    () => now,
  );
  await observe(s, now, async () => ({
    source_id: s.source_id,
    run_id: 'synthetic',
    state: 'complete',
  }));
  expect(logs.every((r) => r.configured_parser_version === PRICE_OF_COMPUTE_PARSER)).toBe(true);
  for (const id of ['lambda', 'sakura_dok', 'ebay_browse'])
    expect(gpuParser(gpuSource(id))).toBe(GPU_PARSER);
  await expect(
    correctGPUPage(
      local.env,
      s,
      'absent',
      0,
      { parser: PRICE_OF_COMPUTE_PARSER, review_ref: 'synthetic', recorded_at: now },
      (r) => r,
    ),
  ).rejects.toThrow('correction_review_required');
  expect(sources.find((s) => s.source_id === 'price_of_compute')).toMatchObject({
    enabled: true,
    policy: {
      rights: {
        automated_collection: 'allowed',
        private_storage: 'allowed',
        internal_analysis: 'allowed',
        external_llm_processing: 'denied',
        raw_redistribution: 'denied',
        public_display: 'review_required',
      },
    },
  });
});
it('preserves PoC page metadata across reviewed immutable corrections without refetch or clock rewriting', async () => {
  const s = privateSource();
  await finishGPU(local.env, s, fetcher(), now);
  const [original] = await observations();
  const later = '2026-10-04T19:17:00.000Z';
  const revised = await correctGPUPage(
    local.env,
    s,
    original.snapshot_id!,
    0,
    { parser: 'gpu-poc-synthetic-review-v2', review_ref: 'synthetic', recorded_at: later },
    (rows) => rows,
  );
  await finishGPUCorrection(local.env, s, revised.snapshot_id, later);
  const rows = await observations();
  expect(rows).toHaveLength(2);
  const correction = rows.find((r) => r.supersedes_observation_id === original.observation_id)!;
  expect(correction).toMatchObject({
    observed_at: now,
    recorded_at: later,
    parser_version: 'gpu-poc-synthetic-review-v2',
  });
  expect(correction.domain.price_of_compute).toEqual(original.domain.price_of_compute);
  expect((await local.env.EVIDENCE.list({ prefix: 'evidence/' })).objects).toHaveLength(2);
  await assertPrivate();
});
it('defers HTTP 200 schema failures and cross-slot requests for at least an hour without caching rejected payloads', async () => {
  const s = privateSource();
  let calls = 0;
  const invalid = (async () => {
    calls++;
    return fetcher(JSON.stringify(document(undefined, { sku: 'B300' })))('https://fixture.test');
  }) as typeof fetch;
  const first = await collectGPU(local.env, s, now, {
    synthetic: true,
    now: () => now,
    network: { fetcher: invalid },
  });
  expect(first).toMatchObject({ state: 'failed', reason: 'sku_mismatch' });
  expect(calls).toBe(1);
  const saved = await local.env.PRIVATE_DB.prepare(
    'SELECT next_attempt_at FROM collection_runs WHERE run_id=?',
  )
    .bind(first.run_id)
    .first<{ next_attempt_at: string }>();
  expect(saved?.next_attempt_at).toBe('2026-10-04T19:17:00.000Z');
  const tenMinutes = '2026-10-04T18:27:00.000Z';
  const same = await collectGPU(local.env, s, now, {
    synthetic: true,
    now: () => tenMinutes,
    network: { fetcher: invalid },
  });
  expect(same).toMatchObject({ state: 'deferred', reason: 'retry_after' });
  expect(calls).toBe(1);
  const next = await collectGPU(local.env, s, tenMinutes, {
    synthetic: true,
    now: () => tenMinutes,
    network: { fetcher: invalid },
  });
  expect(next).toMatchObject({ state: 'failed', reason: 'price_of_compute_success_cache' });
  expect(calls).toBe(1);
  expect((await local.env.EVIDENCE.list()).objects).toHaveLength(0);
  const later = '2026-10-04T19:18:00.000Z';
  const again = await collectGPU(local.env, s, now, {
    synthetic: true,
    now: () => later,
    network: { fetcher: invalid },
  });
  expect(again).toMatchObject({ state: 'failed', reason: 'sku_mismatch' });
  expect(calls).toBe(2);
});
it('enforces source-wide success cooldown for a new slot while retaining immutable same-slot replay', async () => {
  const s = privateSource();
  await finishGPU(local.env, s, fetcher(), now);
  let calls = 0;
  const network = (async () => {
    calls++;
    return fetcher()('https://fixture.test');
  }) as typeof fetch;
  const next = '2026-10-04T18:27:00.000Z';
  expect(
    (
      await collectGPU(local.env, s, next, {
        synthetic: true,
        now: () => next,
        network: { fetcher: network },
      })
    ).reason,
  ).toBe('price_of_compute_success_cache');
  expect(calls).toBe(0);
  expect(await observations()).toHaveLength(1);
});
it('rejects invalid PoC correction semantics before writing immutable evidence or a revision run', async () => {
  const s = privateSource();
  await finishGPU(local.env, s, fetcher(), now);
  const [original] = await observations();
  const later = '2026-10-04T19:17:00.000Z';
  const before = (await local.env.EVIDENCE.list()).objects.map((o) => o.key);
  const revision = { parser: 'gpu-poc-reviewed-v2', review_ref: 'synthetic', recorded_at: later };
  await expect(
    correctGPUPage(local.env, s, original.snapshot_id!, 0, revision, (rows) =>
      rows.map((d) => {
        if ('price_of_compute' in d && d.price_of_compute)
          d.price_of_compute.source_observed_at = later;
        return d;
      }),
    ),
  ).rejects.toThrow('gpu_source_metadata_mismatch');
  expect((await local.env.EVIDENCE.list()).objects.map((o) => o.key)).toEqual(before);
  expect(
    await local.env.PRIVATE_DB.prepare('SELECT COUNT(*) n FROM collection_runs').first('n'),
  ).toBe(1);
  expect(
    (await correctGPUPage(local.env, s, original.snapshot_id!, 0, revision, (rows) => rows)).state,
  ).toMatch(/correction_/);
});
it('prevents overlapping source requests from distinct slots before either 2xx attempt is logged', async () => {
  const s = privateSource();
  let calls = 0;
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const network = (async () => {
    calls++;
    enter();
    await released;
    return fetcher()('https://fixture.test');
  }) as typeof fetch;
  const first = collectGPU(local.env, s, now, {
    synthetic: true,
    now: () => now,
    network: { fetcher: network },
  });
  await entered;
  try {
    const next = '2026-10-04T18:18:00.000Z';
    const concurrent = await collectGPU(local.env, s, next, {
      synthetic: true,
      now: () => next,
      network: { fetcher: network },
    });
    expect(concurrent).toMatchObject({ state: 'failed', reason: 'source_backoff' });
    expect(calls).toBe(1);
  } finally {
    release();
  }
  expect((await first).state).toBe('pending');
});
it('records malformed HTTP 200 body failure once and defers the next PoC attempt without payload persistence', async () => {
  const s = privateSource();
  let calls = 0;
  const network = (async () => {
    calls++;
    return new Response(new Uint8Array([0xff]), {
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  const result = await collectGPU(local.env, s, now, {
    synthetic: true,
    now: () => now,
    network: { fetcher: network, sleep: async () => {} },
  });
  expect(result).toMatchObject({ state: 'failed', reason: 'network_error' });
  expect(calls).toBe(1);
  expect(
    await local.env.PRIVATE_DB.prepare('SELECT COUNT(*) n FROM fetch_attempts').first('n'),
  ).toBe(1);
  const run = await local.env.PRIVATE_DB.prepare(
    'SELECT next_attempt_at FROM collection_runs WHERE run_id=?',
  )
    .bind(result.run_id)
    .first();
  expect(run).toEqual({ next_attempt_at: '2026-10-04T19:17:00.000Z' });
  expect((await local.env.EVIDENCE.list()).objects).toHaveLength(0);
});
it.each(['valid', 'undecodable'])(
  'retains source-wide cooldown when a %s HTTP 200 body has a transient attempt metadata failure',
  async (bodyKind) => {
    const s = privateSource();
    let calls = 0,
      failAttempt = true;
    const database = new Proxy(local.env.PRIVATE_DB, {
      get(target, key) {
        if (key === 'prepare')
          return (sql: string) => {
            if (sql.startsWith('INSERT INTO fetch_attempts') && failAttempt) {
              failAttempt = false;
              return {
                bind: () => ({
                  run: async () => {
                    throw Error('synthetic_attempt_write_failure');
                  },
                }),
              } as unknown as D1PreparedStatement;
            }
            return target.prepare(sql);
          };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const env = { ...local.env, PRIVATE_DB: database };
    const network = (async () => {
      calls++;
      return bodyKind === 'undecodable'
        ? new Response(new Uint8Array([0xff]), { headers: { 'content-type': 'application/json' } })
        : fetcher()('https://fixture.test');
    }) as typeof fetch;
    const first = await collectGPU(env, s, now, {
      synthetic: true,
      now: () => now,
      network: { fetcher: network },
    });
    expect(first).toMatchObject({ state: 'failed', reason: 'attempt_log_failed' });
    expect(calls).toBe(1);
    expect(
      await local.env.PRIVATE_DB.prepare('SELECT COUNT(*) n FROM fetch_attempts').first('n'),
    ).toBe(0);
    const next = '2026-10-04T18:27:00.000Z';
    const replay = await collectGPU(local.env, s, now, {
      synthetic: true,
      now: () => next,
      network: { fetcher: network },
    });
    expect(replay).toMatchObject({ state: 'deferred', reason: 'retry_after' });
    const other = await collectGPU(local.env, s, next, {
      synthetic: true,
      now: () => next,
      network: { fetcher: network },
    });
    expect(other).toMatchObject({ state: 'failed', reason: 'source_backoff' });
    expect(calls).toBe(1);
    expect((await local.env.EVIDENCE.list()).objects).toHaveLength(0);
  },
);
it('keeps a pre-request reservation when both HTTP 200 attempt logging and failure-state persistence fail', async () => {
  const s = privateSource();
  let calls = 0,
    clock = now;
  const database = new Proxy(local.env.PRIVATE_DB, {
    get(target, key) {
      if (key === 'prepare')
        return (sql: string) => {
          if (
            sql.startsWith('INSERT INTO fetch_attempts') ||
            sql.startsWith("UPDATE collection_runs SET state='failed'")
          )
            return {
              bind: () => ({
                run: async () => {
                  throw Error('synthetic_post_response_db_outage');
                },
              }),
            } as unknown as D1PreparedStatement;
          return target.prepare(sql);
        };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const network = (async () => {
    calls++;
    const reserved = await local.env.PRIVATE_DB.prepare(
      'SELECT next_attempt_at FROM collection_runs WHERE source_id=?',
    )
      .bind(s.source_id)
      .first<{ next_attempt_at: string }>();
    expect(reserved?.next_attempt_at).toBe('2026-10-04T19:17:20.000Z');
    clock = '2026-10-04T18:17:10.000Z';
    return fetcher()('https://fixture.test');
  }) as typeof fetch;
  await expect(
    collectGPU({ ...local.env, PRIVATE_DB: database }, s, now, {
      synthetic: true,
      now: () => clock,
      network: { fetcher: network },
    }),
  ).rejects.toThrow('synthetic_post_response_db_outage');
  expect(calls).toBe(1);
  expect(
    await local.env.PRIVATE_DB.prepare('SELECT COUNT(*) n FROM fetch_attempts').first('n'),
  ).toBe(0);
  const original = await local.env.PRIVATE_DB.prepare(
    'SELECT state,next_attempt_at,lease_until FROM collection_runs',
  ).first();
  expect(original).toMatchObject({
    state: 'fetching',
    next_attempt_at: '2026-10-04T19:17:20.000Z',
    lease_until: '2026-10-04T18:27:00.000Z',
  });
  const recovered = '2026-10-04T18:28:00.000Z';
  const same = await collectGPU(local.env, s, now, {
    synthetic: true,
    now: () => recovered,
    network: { fetcher: network },
  });
  expect(same).toMatchObject({ state: 'deferred', reason: 'retry_after' });
  const other = await collectGPU(local.env, s, recovered, {
    synthetic: true,
    now: () => recovered,
    network: { fetcher: network },
  });
  expect(other).toMatchObject({ state: 'failed', reason: 'source_backoff' });
  expect(calls).toBe(1);
  expect((await local.env.EVIDENCE.list()).objects).toHaveLength(0);
});
it.each(['write', 'readback'])(
  'does not send a request when PoC reservation %s fails',
  async (failure) => {
    const s = privateSource();
    let calls = 0;
    const database = new Proxy(local.env.PRIVATE_DB, {
      get(target, key) {
        if (key === 'prepare')
          return (sql: string) => {
            if (
              failure === 'write' &&
              sql.startsWith('UPDATE collection_runs SET next_attempt_at=')
            )
              return {
                bind: () => ({
                  run: async () => {
                    throw Error('synthetic_reservation_write_failure');
                  },
                }),
              } as unknown as D1PreparedStatement;
            if (
              failure === 'readback' &&
              sql === 'SELECT next_attempt_at FROM collection_runs WHERE run_id=? AND lease_token=?'
            )
              return {
                bind: () => ({ first: async () => null }),
              } as unknown as D1PreparedStatement;
            return target.prepare(sql);
          };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const result = await collectGPU({ ...local.env, PRIVATE_DB: database }, s, now, {
      synthetic: true,
      now: () => now,
      network: {
        fetcher: (async () => {
          calls++;
          return fetcher()('https://fixture.test');
        }) as typeof fetch,
      },
    });
    expect(result).toMatchObject({
      state: 'failed',
      reason: 'price_of_compute_reservation_failed',
    });
    expect(calls).toBe(0);
    expect(
      await local.env.PRIVATE_DB.prepare(
        'SELECT COUNT(*) n FROM fetch_attempts WHERE status>=200 AND status<300',
      ).first('n'),
    ).toBe(0);
    expect((await local.env.EVIDENCE.list()).objects).toHaveLength(0);
  },
);
it('never shortens a newer reservation when an older timed-out reservation write completes late', async () => {
  const s = privateSource(),
    started = Date.now();
  let requests = 0,
    reservations = 0,
    postResponseFailure = false;
  const clock = () => new Date(Date.parse(now) + Date.now() - started).toISOString();
  let releaseOld!: () => void, oldDone!: () => void;
  const release = new Promise<void>((resolve) => {
    releaseOld = resolve;
  });
  const done = new Promise<void>((resolve) => {
    oldDone = resolve;
  });
  const deadlines: string[] = [];
  const database = new Proxy(local.env.PRIVATE_DB, {
    get(target, key) {
      if (key === 'prepare')
        return (sql: string) => {
          if (sql.startsWith('UPDATE collection_runs SET next_attempt_at=')) {
            const statement = target.prepare(sql);
            return {
              bind: (...args: unknown[]) => ({
                run: async () => {
                  const ordinal = ++reservations;
                  deadlines.push(args[0] as string);
                  if (ordinal === 1) {
                    await release;
                    try {
                      return await statement.bind(...args).run();
                    } finally {
                      oldDone();
                    }
                  }
                  const result = await statement.bind(...args).run();
                  releaseOld();
                  return result;
                },
              }),
            } as unknown as D1PreparedStatement;
          }
          if (
            postResponseFailure &&
            (sql.startsWith('INSERT INTO fetch_attempts') ||
              sql.startsWith("UPDATE collection_runs SET state='failed'"))
          )
            return {
              bind: () => ({
                run: async () => {
                  throw Error('synthetic_post_response_db_outage');
                },
              }),
            } as unknown as D1PreparedStatement;
          return target.prepare(sql);
        };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const network = (async () => {
    requests++;
    await done;
    postResponseFailure = true;
    return fetcher()('https://fixture.test');
  }) as typeof fetch;
  await expect(
    collectGPU({ ...local.env, PRIVATE_DB: database }, s, now, {
      synthetic: true,
      now: clock,
      network: { fetcher: network, timeout_ms: 1000, sleep: async () => {} },
    }),
  ).rejects.toThrow('synthetic_post_response_db_outage');
  expect(reservations).toBe(2);
  expect(requests).toBe(1);
  expect(deadlines[1] > deadlines[0]).toBe(true);
  const saved = await local.env.PRIVATE_DB.prepare(
    'SELECT next_attempt_at FROM collection_runs WHERE source_id=?',
  )
    .bind(s.source_id)
    .first<{ next_attempt_at: string }>();
  expect(saved?.next_attempt_at).toBe(deadlines[1]);
});
