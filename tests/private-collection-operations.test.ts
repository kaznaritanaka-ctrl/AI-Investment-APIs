import { beforeEach, afterEach, it, expect } from 'vitest';
import { localEnv } from '../scripts/local-env';
import { gpuSource, finishGPU } from './gpu-helpers';
import { readOperationalStatus, evaluateSource } from '../src/operational-status';
import { readGPUCollectionEvidence } from '../src/operational-gpu';
import { overnightSource } from '../src/overnight';
import { runDTO, readAdmin } from '../src/admin-read';
import { operationsHandoff } from '../src/operations-handoff';
import { syncSource } from '../src/publication';
import { SourceSchema, type Source } from '../src/schema';
import { canCollect } from '../src/policy';
import { readFileSync } from 'node:fs';

const slot = '2026-10-04T18:17:00.000Z';
const checked = '2026-10-04T19:00:00.000Z';
let local: Awaited<ReturnType<typeof localEnv>>;
const privateSource = () => {
  const s = gpuSource('price_of_compute');
  for (const key of Object.keys(s.policy.rights) as Array<keyof Source['policy']['rights']>)
    if (!['automated_collection', 'private_storage', 'internal_analysis'].includes(key))
      s.policy.rights[key] = 'review_required';
  return s;
};
const fetcher: typeof fetch = async () =>
  new Response(
    JSON.stringify({
      sku: 'H100-SXM',
      day: '2026-10-03',
      updated_at: '2026-10-03T10:00:00Z',
      providers: [
        {
          provider: 'synthetic-private-provider',
          pricing_type: 'on_demand',
          usd_per_gpu_hr: 1.234567,
        },
      ],
    }),
    { headers: { 'content-type': 'application/json' } },
  );
beforeEach(async () => {
  local = await localEnv();
  local.env.COLLECTION_ENABLED = 'true';
  local.env.COLLECTION_CRON = '17 18 * * *';
});
afterEach(async () => {
  await local?.mf.dispose();
});
const report = (s: Source, now = checked) => readOperationalStatus(local.env, [s], now);

it('keeps the review proposal incapable of collecting before explicit source and retention approval', () => {
  const proposal = SourceSchema.parse(
    JSON.parse(readFileSync('config/proposals/price_of_compute.private-collection.json', 'utf8')),
  );
  expect(proposal.enabled).toBe(false);
  expect(Object.values(proposal.policy.rights).every((r) => r === 'review_required')).toBe(true);
  expect(canCollect({ ...proposal, enabled: true }, '2026-10-07T00:00:00.000Z')).toBe(false);
});

it('reports private collection success without claiming publication or fresh provider prices, and never writes on read', async () => {
  const s = privateSource();
  expect((await finishGPU(local.env, s, fetcher, slot)).result.state).toBe('complete');
  const count = async () =>
    await local.env.PRIVATE_DB.prepare('SELECT COUNT(*) n FROM collection_runs').first('n');
  const before = await count();
  const result = await report(s);
  expect(result.sources[0]).toMatchObject({
    collection: 'complete',
    snapshot: 'complete',
    publication: 'not_applicable',
    publication_required: false,
    observation_count: 1,
    accepted_count: 1,
    quality: { state: 'clear', count: 0 },
    price_freshness: {
      state: 'not_evaluated',
      source_day_from: '2026-10-03',
      provider_observed_from: null,
      provider_time_missing: 1,
    },
  });
  expect(result.overnight.sources[0]).toMatchObject({
    collection_status: 'complete',
    publication_status: 'not_applicable',
    severity: 'ok',
    remaining_human_action: 'none',
    missing_observation: false,
    missing_observation_count: 0,
    briefing: '非公開の収集完了。公開は対象外',
  });
  const admin = await readAdmin(
    'runs',
    { source: s.source_id, from: slot, to: checked },
    local.env,
    checked,
    [s],
  );
  expect(admin.state).toBe('ready');
  expect(admin.runs![0]).toMatchObject({
    capture_verified: true,
    publication: { state: 'not_applicable', visible_count: 0 },
    recovery: {
      recovery_result: 'not_needed',
      missing_observation: false,
      missing_observation_count: 0,
      remaining_human_action: 'none',
      briefing: '非公開の収集完了。公開は対象外',
    },
  });
  expect((await operationsHandoff(admin, slot, checked)).items).toEqual([]);
  const overview = await readAdmin('overview', {}, local.env, checked, [s]);
  expect(overview.overview).toMatchObject({
    expected: 1,
    completed: 1,
    published: 0,
    publication_expected: 0,
  });
  expect(
    overview.overview!.attention.filter((a) => /:(rights|publication|capture)$/.test(a.id)),
  ).toEqual([]);
  expect(JSON.stringify(result)).not.toContain('synthetic-private-provider');
  expect(JSON.stringify(result)).not.toContain('1.234567');
  expect(await count()).toBe(before);
  expect(
    await local.env.PRIVATE_DB.prepare('SELECT COUNT(*) n FROM notification_outbox').first('n'),
  ).toBe(0);
  for (const table of ['published_observations', 'published_gpu_metrics', 'published_coverage'])
    expect(await local.env.PUBLIC_DB.prepare('SELECT COUNT(*) n FROM ' + table).first('n')).toBe(0);
});

it('Admin and handoff keep incomplete private snapshots, configuration drift and public read failures actionable', async () => {
  const s = privateSource();
  await finishGPU(local.env, s, fetcher, slot);
  await local.env.PRIVATE_DB.prepare(
    'UPDATE gpu_snapshots SET reported_total=received_count+1',
  ).run();
  const admin = await readAdmin(
    'runs',
    { source: s.source_id, from: slot, to: checked },
    local.env,
    checked,
    [s],
  );
  expect(admin.runs![0]).toMatchObject({
    capture_verified: false,
    publication: { state: 'not_applicable' },
    recovery: {
      recovery_result: 'not_completed',
      missing_observation: null,
      remaining_human_action: 'investigate_collection_or_publication',
    },
  });
  expect((await operationsHandoff(admin, slot, checked)).items).toHaveLength(1);
  const overview = await readAdmin('overview', {}, local.env, checked, [s]);
  expect(overview.overview!.completed).toBe(0);
  expect(overview.overview!.attention.some((a) => a.id.endsWith(':capture'))).toBe(true);
  await local.env.PRIVATE_DB.prepare(
    'UPDATE gpu_snapshots SET reported_total=received_count',
  ).run();
  const brokenPublic = {
    ...local.env,
    PUBLIC_DB: new Proxy(local.env.PUBLIC_DB, {
      get(target, key) {
        if (key === 'prepare')
          return () => {
            throw new Error('synthetic database unavailable');
          };
        return Reflect.get(target, key);
      },
    }),
  };
  const unavailable = await readAdmin(
    'runs',
    { source: s.source_id, from: slot, to: checked },
    brokenPublic,
    checked,
    [s],
  );
  expect(unavailable.runs![0].publication.state).toBe('unavailable');
  expect(unavailable.runs![0].recovery!.remaining_human_action).not.toBe('none');
  await local.env.PRIVATE_DB.prepare(
    "UPDATE sources SET policy_version='unreviewed' WHERE source_id=?",
  )
    .bind(s.source_id)
    .run();
  const drift = await readAdmin(
    'runs',
    { source: s.source_id, from: slot, to: checked },
    local.env,
    checked,
    [s],
  );
  expect(drift.runs![0].capture_verified).toBeNull();
  expect(drift.runs![0].publication.state).not.toBe('not_applicable');
  expect(drift.runs![0].recovery!.remaining_human_action).not.toBe('none');
});

it('does not turn a missing private run into zero records or successful acquisition', async () => {
  const s = privateSource();
  await syncSource(local.env, s, slot);
  const result = await report(s);
  expect(result.sources[0]).toMatchObject({
    collection: 'missing',
    observation_count: null,
    publication: 'not_applicable',
  });
  expect(result.overnight.sources[0]).toMatchObject({
    severity: 'action_required',
    missing_observation: true,
    missing_observation_count: null,
  });
});

it('requires every configured partition, exact scope and count even when the run says complete', async () => {
  const s = privateSource();
  await finishGPU(local.env, s, fetcher, slot);
  await local.env.PRIVATE_DB.prepare(
    'UPDATE gpu_snapshots SET reported_total=received_count+1',
  ).run();
  let result = await report(s);
  expect(result.sources[0].snapshot).toBe('incomplete');
  expect(result.overnight.sources[0]).toMatchObject({
    severity: 'action_required',
    missing_observation_count: null,
  });
  await local.env.PRIVATE_DB.prepare(
    "UPDATE gpu_snapshots SET reported_total=received_count,scope_hash='incorrect'",
  ).run();
  result = await report(s);
  expect(result.sources[0].snapshot).toBe('incomplete');
  s.gpu!.partitions.push({ id: 'uncollected', query: { sku: 'b200' }, models: [] });
  expect((await report(s)).sources[0].snapshot).toBe('incomplete');
});

it('distinguishes a revoked public grant from intentionally private collection', async () => {
  const s = privateSource();
  await finishGPU(local.env, s, fetcher, slot);
  const row = await local.env.PRIVATE_DB.prepare('SELECT * FROM collection_runs').first<
    Record<string, unknown>
  >();
  const run = await runDTO(local.env, row!, checked);
  const evidence = await readGPUCollectionEvidence(local.env, s, run.run_id, checked, run);
  s.policy.rights.public_display = 'expired';
  const status = evaluateSource(s, slot, checked, {
    run,
    ...evidence,
    previousQuality: null,
    sourceDate: null,
  });
  expect(status).toMatchObject({
    collection: 'complete',
    snapshot: 'complete',
    publication: 'policy_stopped',
    publication_required: null,
  });
  expect(overnightSource(status)).toMatchObject({
    severity: 'action_required',
    remaining_human_action: 'investigate_collection_or_publication',
  });
});

it('uses the GPU capture window and never declares a fetching run complete', async () => {
  const s = privateSource();
  await finishGPU(local.env, s, fetcher, slot);
  await local.env.PRIVATE_DB.prepare(
    "UPDATE collection_runs SET state='fetching',finished_at=NULL,last_progress_at=?",
  )
    .bind(checked)
    .run();
  expect((await report(s)).sources[0]).toMatchObject({
    collection: 'in_progress',
    snapshot: 'in_progress',
  });
  expect((await report(s, '2026-10-05T00:18:00.000Z')).sources[0].collection).toBe(
    'deadline_exceeded',
  );
});

it('keeps read failures unknown and private-only incomplete snapshots actionable', async () => {
  const s = privateSource();
  await finishGPU(local.env, s, fetcher, slot);
  const db = local.env.PRIVATE_DB;
  local.env.PRIVATE_DB = new Proxy(db, {
    get(target, key) {
      if (key === 'prepare')
        return (sql: string) => {
          if (sql.includes('FROM gpu_snapshots'))
            throw new Error('synthetic private detail not for logs');
          return target.prepare(sql);
        };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  expect((await report(s)).sources[0]).toMatchObject({
    collection: 'unknown',
    snapshot: 'unknown',
    publication: 'unknown',
    observation_count: null,
  });
  expect(
    overnightSource({
      source_id: s.source_id,
      run_id: null,
      collection: 'complete',
      snapshot: 'incomplete',
      publication: 'not_applicable',
      publication_required: false,
      observation_count: 1,
      accepted_count: 1,
    }),
  ).toMatchObject({ severity: 'action_required', missing_observation_count: null });
});
