import { beforeEach, afterEach, it, expect } from 'vitest';
import { localEnv } from '../scripts/local-env';
import { applyMigrations } from '../scripts/migrations';
import { collectSource } from '../src/pipeline';
import { handle } from '../src/api';
import { revokeSource } from '../src/publication';
import { gpuSource, item, ebayFetcher, finishGPU } from './gpu-helpers';
import { time, source, fxFetch, modelSource, aiFetch } from './helpers';
let local: Awaited<ReturnType<typeof localEnv>>;
beforeEach(async () => {
  local = await localEnv();
});
afterEach(async () => {
  await local?.mf.dispose();
});
const api = (path: string, now = time) =>
  handle(new Request('https://fixture.test' + path), { PUBLIC_DB: local.env.PUBLIC_DB }, now);
it('collects synthetic GPU listings through R2, both DBs, publication and metrics', async () => {
  const s = gpuSource(),
    r = await finishGPU(
      local.env,
      s,
      ebayFetcher(s, [item(1, '100'), item(2, '200'), item(3, '300')]),
    );
  expect(r.result).toMatchObject({ state: 'complete', observations: 3 });
  const res = await api('/v1/observations?dataset=gpu_secondary&sku=nvidia-a100-80gb-pcie');
  expect(res.status).toBe(200);
  const body = (await res.json()) as any;
  expect(body.data).toHaveLength(3);
  expect(body.data[0].data_origin).toBe('synthetic');
  const metrics = (await (await api('/v1/gpu/metrics')).json()) as any;
  expect(metrics.data[0]).toMatchObject({ median: '200', q25: '150', q75: '250', sample_count: 3 });
  expect(metrics.data[0].changes['7d'].status).toBe('insufficient_data');
  expect(((await (await api('/v1/gpu/coverage')).json()) as any).data[0].coverage).toBe('complete');
  for (const endpoint of ['latest', 'observations', 'gpu/coverage', 'gpu/metrics']) {
    const res = await api('/v1/' + endpoint + '?as_of=' + time.replace('.000Z', 'Z'));
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).data.length).toBeGreaterThan(0);
  }
  expect((await api('/v1/gpu/metrics?source=')).status).toBe(400);
  expect((await api('/v1/gpu/metrics?cursor=null')).status).toBe(400);
});
it('blocks all network and storage for unapproved GPU rights or missing owner/retention approval', async () => {
  for (const s of [
    source('ebay_browse'),
    { ...gpuSource(), gpu: { ...gpuSource().gpu!, owner_approval_ref: null } },
  ]) {
    let calls = 0;
    const result = await collectSource(local.env, s, time, {
      synthetic: true,
      now: () => time,
      network: {
        fetcher: (async () => {
          calls++;
          throw new Error('unexpected');
        }) as typeof fetch,
      },
    });
    expect(result.state).toBe('policy_skipped');
    expect(calls).toBe(0);
  }
  expect(
    await local.env.PRIVATE_DB.prepare('SELECT COUNT(*) AS n FROM observations').first('n'),
  ).toBe(0);
});
it('keeps partial pages private and recovers without refetching saved evidence', async () => {
  const s = gpuSource(),
    items = Array.from({ length: 60 }, (_, i) => item(i)),
    fetcher = ebayFetcher(s, items);
  const env = { ...local.env, EBAY_CLIENT_ID: 'synthetic', EBAY_CLIENT_SECRET: 'synthetic' };
  const first = await collectSource(env, s, time, {
    synthetic: true,
    now: () => time,
    network: { fetcher },
    afterEvidenceSaved: async () => {
      throw new Error('synthetic_fault');
    },
  });
  expect(first.state).toBe('failed');
  let calls = 0;
  const replay = await collectSource(env, s, time, {
    synthetic: true,
    now: () => time,
    network: {
      fetcher: (async () => {
        calls++;
        throw new Error('unexpected_fetch');
      }) as typeof fetch,
    },
  });
  expect(replay.state).toBe('pending');
  expect(calls).toBe(0);
  expect(
    ((await (await api('/v1/observations?dataset=gpu_secondary')).json()) as any).data,
  ).toHaveLength(0);
  const failed = await collectSource(env, s, time, {
    synthetic: true,
    now: () => time,
    network: { fetcher: ebayFetcher(s, items, time, { failPage: 1 }), sleep: async () => {} },
  });
  expect(failed.state).toBe('failed');
  expect(((await (await api('/v1/gpu/coverage')).json()) as any).data[0]).toMatchObject({
    coverage: 'partial',
    observed_offer_count: 50,
  });
  expect((await finishGPU(env, s, fetcher)).result.state).toBe('complete');
  expect(
    ((await (await api('/v1/observations?dataset=gpu_secondary&limit=100')).json()) as any).data,
  ).toHaveLength(60);
});
it('accepts confirmed large market changes and records disappearance without inferring a sale', async () => {
  const s = gpuSource();
  await finishGPU(local.env, s, ebayFetcher(s, [item(1), item(2), item(3)]));
  const next = '2026-10-04T18:17:00.000Z';
  expect(
    (await finishGPU(local.env, s, ebayFetcher(s, [item(1, '400')], next), next)).result.state,
  ).toBe('complete');
  const latest = (await (await api('/v1/latest?dataset=gpu_secondary', next)).json()) as any;
  expect(latest.data).toHaveLength(1);
  expect(latest.data[0].value.asking_price).toBe('400');
  expect(latest.data[0].quality_flags).toContain('confirmed_large_price_change');
  const changes = (await (await api('/v1/changes?dataset=gpu_secondary', next)).json()) as any;
  expect(changes.data.filter((c: any) => c.event_kind === 'not_seen')).toHaveLength(2);
  expect(
    changes.data
      .filter((c: any) => c.event_kind === 'not_seen')
      .every((c: any) => c.sold === false),
  ).toBe(true);
  const coverage = (await (await api('/v1/gpu/coverage', next)).json()) as any;
  expect(coverage.data.at(-1).warnings).toContain('confirmed_observed_count_decline');
  await revokeSource(local.env, s.source_id);
  expect(
    ((await (await api('/v1/observations?dataset=gpu_secondary', next)).json()) as any).data,
  ).toHaveLength(0);
  expect(((await (await api('/v1/gpu/metrics', next)).json()) as any).data).toHaveLength(0);
  expect(((await (await api('/v1/gpu/coverage', next)).json()) as any).data).toHaveLength(0);
});
it('quarantines missing pagination and never converts failure to zero availability', async () => {
  const s = gpuSource(),
    rows = Array.from({ length: 60 }, (_, i) => item(i));
  const r = await finishGPU(local.env, s, ebayFetcher(s, rows, time, { missingNext: true }));
  expect(r.result.state).toBe('partial');
  const coverage = (await (await api('/v1/gpu/coverage')).json()) as any;
  expect(coverage.data[0]).toMatchObject({
    coverage: 'partial',
    missing_reason: 'pagination_incomplete',
    received_api_records: 50,
  });
  expect(
    ((await (await api('/v1/observations?dataset=gpu_secondary')).json()) as any).data,
  ).toHaveLength(0);
});
it('migrates populated Phase 1 databases and preserves FK and append-only protections', async () => {
  await local.mf.dispose();
  local = await localEnv('test', undefined, 1);
  expect(
    (
      await collectSource(local.env, source('ecb'), time, {
        synthetic: true,
        now: () => time,
        network: { fetcher: fxFetch() },
      })
    ).state,
  ).toBe('complete');
  expect(
    (
      await collectSource(local.env, modelSource(), time, {
        synthetic: true,
        now: () => time,
        network: { fetcher: aiFetch() },
      })
    ).state,
  ).toBe('complete');
  const idsBefore = (
    await local.env.PRIVATE_DB.prepare(
      'SELECT observation_id FROM observations ORDER BY observation_id',
    ).all()
  ).results;
  await applyMigrations(local.env.PRIVATE_DB, 'private');
  await applyMigrations(local.env.PUBLIC_DB, 'public');
  expect(
    await local.env.PRIVATE_DB.prepare('SELECT COUNT(*) AS n FROM observations').first('n'),
  ).toBe(3);
  expect(
    (
      await local.env.PRIVATE_DB.prepare(
        'SELECT observation_id FROM observations ORDER BY observation_id',
      ).all()
    ).results,
  ).toEqual(idsBefore);
  expect(await local.env.PRIVATE_DB.prepare('SELECT COUNT(*) AS n FROM lineage').first('n')).toBe(
    2,
  );
  expect((await local.env.PRIVATE_DB.prepare('PRAGMA foreign_key_check').all()).results).toEqual(
    [],
  );
  await expect(
    local.env.PRIVATE_DB.prepare("UPDATE observations SET entity_key='changed'").run(),
  ).rejects.toThrow();
  expect((await api('/v1/latest')).status).toBe(200);
});

it('quarantines changed lot conditions and appends reviewed corrections without backdating knowledge', async () => {
  const s = gpuSource();
  await finishGPU(local.env, s, ebayFetcher(s, [item(1)]));
  const next = '2026-10-04T18:17:00.000Z',
    correctedAt = '2026-10-05T18:17:00.000Z';
  const result = await finishGPU(
    local.env,
    s,
    ebayFetcher(s, [item(1, '400', '2x A100 80GB PCIe')], next),
    next,
  );
  expect(result.result).toMatchObject({ state: 'complete', accepted: 0, quarantined: 1 });
  const snap = await local.env.PRIVATE_DB.prepare(
    'SELECT snapshot_id FROM gpu_snapshots WHERE started_at=?',
  )
    .bind(next)
    .first<{ snapshot_id: string }>();
  const { correctGPUPage } = await import('../src/gpu-corrections');
  const corrected = await correctGPUPage(
    local.env,
    s,
    snap!.snapshot_id,
    0,
    {
      parser: 'gpu-reviewed-v2',
      review_ref: 'synthetic-condition-review',
      recorded_at: correctedAt,
    },
    (rows) => rows,
  );
  const current = (await (
    await api('/v1/latest?dataset=gpu_secondary', correctedAt)
  ).json()) as any;
  expect(current.data).toHaveLength(1);
  expect(current.data[0]).toMatchObject({
    observed_at: next,
    recorded_at: correctedAt,
    snapshot_id: corrected.snapshot_id,
    backfill: true,
  });
  expect(current.data[0].supersedes_observation_id).toBeTruthy();
  const revision = {
    parser: 'gpu-reviewed-v2',
    review_ref: 'synthetic-condition-review',
    recorded_at: correctedAt,
  };
  expect(
    (await correctGPUPage(local.env, s, snap!.snapshot_id, 0, revision, (rows) => rows))
      .snapshot_id,
  ).toBe(corrected.snapshot_id);
  await expect(
    correctGPUPage(local.env, s, snap!.snapshot_id, 0, revision, (rows) =>
      rows.map((r) => ('asking_price' in r ? { ...r, asking_price: '500' } : r)),
    ),
  ).rejects.toThrow('correction_version_mutated');
  expect(
    (
      (await (
        await api('/v1/latest?dataset=gpu_secondary&as_of=' + next, correctedAt)
      ).json()) as any
    ).error.code,
  ).toBe('no_observation');
  expect(
    await local.env.PRIVATE_DB.prepare('SELECT COUNT(*) AS n FROM observations').first('n'),
  ).toBe(3);
  const week = '2026-10-11T18:17:00.000Z';
  await finishGPU(local.env, s, ebayFetcher(s, [item(1, '400', '2x A100 80GB PCIe')], week), week);
  const metrics = ((await (await api('/v1/gpu/metrics', week)).json()) as any).data.at(-1);
  expect(metrics.changes['7d']).toMatchObject({
    status: 'ok',
    reference_snapshot_id: corrected.snapshot_id,
    price_median_percent: '0',
  });
}, 60000);
it('leases a GPU run against concurrent acquisition and excludes future observations at as_of', async () => {
  const s = gpuSource(),
    base = ebayFetcher(s, [item(1)]);
  let calls = 0;
  const fetcher = (async (...args: Parameters<typeof fetch>) => {
    calls++;
    return base(...args);
  }) as typeof fetch;
  const env = { ...local.env, EBAY_CLIENT_ID: 'synthetic', EBAY_CLIENT_SECRET: 'synthetic' };
  const opts = { synthetic: true, now: () => time, network: { fetcher } };
  const both = await Promise.all([
    collectSource(env, s, time, opts),
    collectSource(env, s, time, opts),
  ]);
  expect(both.some((r) => r.state === 'in_progress')).toBe(true);
  expect(calls).toBe(2);
  await finishGPU(env, s, base);
  const past = '2026-10-02T18:17:00.000Z';
  expect(
    ((await (await api('/v1/observations?dataset=gpu_secondary&as_of=' + past)).json()) as any)
      .data,
  ).toHaveLength(0);
});

it('runs authenticated Lambda rental projection through the same private/public observation API', async () => {
  const s = gpuSource('lambda'),
    body = {
      data: {
        'synthetic-h100': {
          instance_type: {
            name: 'synthetic-h100',
            gpu_description: 'H100 (80 GB SXM5)',
            price_cents_per_hour: 123,
            specs: { vcpus: 8, memory_gib: 100, storage_gib: 100, gpus: 1 },
          },
          regions_with_capacity_available: [{ name: 'us-west-1', description: 'synthetic-region' }],
        },
      },
    };
  const result = await finishGPU(
    local.env,
    s,
    (async () =>
      new Response(JSON.stringify(body), {
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch,
  );
  expect(result.result.state).toBe('complete');
  const data = (
    (await (await api('/v1/latest?dataset=gpu_rental&country=US&provider=lambda')).json()) as any
  ).data;
  expect(data).toHaveLength(1);
  expect(data[0].value).toMatchObject({
    currency: 'USD',
    amount_decimal: '1.23',
    gpu_sku_id: 'nvidia-h100-80gb-sxm5',
    country: 'US',
    availability_status: 'available',
  });
  expect(data[0].statistical_exclusions).toContain('contract_unknown');
});
