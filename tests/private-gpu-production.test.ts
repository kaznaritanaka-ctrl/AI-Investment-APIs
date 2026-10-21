import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { localEnv } from '../scripts/local-env';
import {
  collectResearchPage,
  purgeResearchRun,
  purgeResearchEvidence,
  readResearchRun,
} from '../src/research/pipeline';
import {
  requestResearchDeletion,
  revokeResearchSource,
  runDeletionKey,
} from '../src/research/retention';
import { maintainPrivateGpuResearch } from '../src/research/collector';
import { publicGpuSource, gpuTime, gpuOptions, gpuFetcher } from './public-gpu-helpers';
import { researchSource, eiaQuery, opts, eiaPage } from './research-helpers';

let local: Awaited<ReturnType<typeof localEnv>>;
beforeEach(async () => {
  local = await localEnv('test');
});
afterEach(async () => {
  vi.restoreAllMocks();
  await local?.mf.dispose();
});
const query = { kind: 'highreso_public' } as const;
const production = () => ({
  ...local.env,
  ENVIRONMENT: 'production' as const,
  PRIVATE_GPU_RESEARCH_ENABLED: 'true',
});

it('requires the exact flag, source scope and full authority before production HTTP or storage', async () => {
  const c = await publicGpuSource();
  const http = vi.spyOn(globalThis, 'fetch').mockImplementation(gpuFetcher('highreso_public'));
  const options = {
    current_terms_version: c.terms.version,
    now: () => gpuTime,
    allow_network: true,
  };
  for (const flag of [undefined, 'false', 'TRUE', '1'])
    await expect(
      collectResearchPage(
        { ...production(), PRIVATE_GPU_RESEARCH_ENABLED: flag },
        c,
        query,
        gpuTime,
        options,
      ),
    ).rejects.toThrow('research_production_not_integrated');
  await expect(
    collectResearchPage(production(), researchSource(), eiaQuery, gpuTime, opts(eiaPage(0))),
  ).rejects.toThrow('research_production_not_integrated');
  for (const field of ['owner_approval_ref', 'wire_contract_review_ref'] as const)
    await expect(
      collectResearchPage(production(), { ...c, [field]: null }, query, gpuTime, options),
    ).rejects.toThrow('research_review_required');
  for (const right of ['automated_collection', 'private_storage', 'internal_analysis'] as const) {
    const blocked = structuredClone(c);
    blocked.source.policy.rights[right] = 'denied';
    await expect(
      collectResearchPage(production(), blocked, query, gpuTime, options),
    ).rejects.toThrow('policy_blocked');
  }
  const unreviewed = structuredClone(c);
  unreviewed.public_access!.terms_sha256 = null;
  await expect(
    collectResearchPage(production(), unreviewed, query, gpuTime, options),
  ).rejects.toThrow('public_access_review_required');
  const unretained = structuredClone(c);
  unretained.retention.normalized_mode = 'unapproved';
  await expect(
    collectResearchPage(production(), unretained, query, gpuTime, options),
  ).rejects.toThrow('retention_review_required');
  expect(http).not.toHaveBeenCalled();
  expect(
    await local.env.PRIVATE_DB.prepare('SELECT COUNT(*) n FROM research_runs').first('n'),
  ).toBe(0);
  await expect(collectResearchPage(production(), c, query, gpuTime, gpuOptions(c))).rejects.toThrow(
    'research_synthetic_boundary',
  );
  const first = await collectResearchPage(production(), c, query, gpuTime, options);
  expect(first.state).toBe('complete');
  expect(http).toHaveBeenCalledTimes(3);
  expect(await collectResearchPage(production(), c, query, gpuTime, options)).toEqual(first);
  await expect(
    collectResearchPage(production(), c, query, '2026-10-18T02:00:00.000Z', {
      ...options,
      now: () => '2026-10-18T02:00:00.000Z',
    }),
  ).rejects.toThrow('research_scope_changed_or_daily_limit');
  expect(http).toHaveBeenCalledTimes(3);
  expect((await readResearchRun(production(), c, first.run_id, options)).results).toHaveLength(4);
  expect(
    await local.env.PUBLIC_DB.prepare('SELECT COUNT(*) n FROM published_observations').first('n'),
  ).toBe(0);
});

it('runs finite production retention after grant expiry, and never touches electricity', async () => {
  const c = await publicGpuSource();
  c.retention.normalized_days = 1;
  const r = await collectResearchPage(local.env, c, query, gpuTime, gpuOptions(c));
  const eia = researchSource();
  eia.limits.page_size = 1;
  const e = await collectResearchPage(
    local.env,
    eia,
    eiaQuery,
    '2026-10-15T01:00:00.000Z',
    opts(eiaPage(0)),
  );
  const at = '2027-01-16T01:00:00.000Z';
  await maintainPrivateGpuResearch(production(), c, at);
  expect(
    await local.env.PRIVATE_DB.prepare('SELECT state FROM research_runs WHERE run_id=?')
      .bind(r.run_id)
      .first('state'),
  ).toBe('purged');
  expect(
    (await local.env.EVIDENCE.list({ prefix: 'research/highreso_public/' })).objects,
  ).toHaveLength(0);
  await expect(
    purgeResearchRun(production(), e.run_id, at, { time_travel_days: 7 }),
  ).rejects.toThrow('research_production_not_integrated');
  await expect(purgeResearchEvidence(production(), at)).rejects.toThrow(
    'research_production_not_integrated',
  );
  await expect(revokeResearchSource(production(), eia.source.source_id, at)).rejects.toThrow(
    'research_production_not_integrated',
  );
  await expect(
    requestResearchDeletion(production(), e.run_id, at, {
      basis_ref: 'synthetic-request',
      all_copies_delete_by: at,
    }),
  ).rejects.toThrow('research_production_not_integrated');
  expect(
    await local.env.PRIVATE_DB.prepare('SELECT state FROM research_runs WHERE run_id=?')
      .bind(e.run_id)
      .first('state'),
  ).toBe('partial');
});

it('processes evidence expiry, revocation and independent R2 restore; failed DELETE is retried', async () => {
  const c = await publicGpuSource();
  const r = await collectResearchPage(local.env, c, query, gpuTime, gpuOptions(c));
  const at = '2026-10-26T01:00:00.000Z';
  await maintainPrivateGpuResearch(production(), c, at);
  expect(
    await local.env.PRIVATE_DB.prepare('SELECT state FROM research_runs WHERE run_id=?')
      .bind(r.run_id)
      .first('state'),
  ).toBe('complete');
  expect(
    (await local.env.EVIDENCE.list({ prefix: 'research/highreso_public/' })).objects,
  ).toHaveLength(0);
  await revokeResearchSource(production(), c.source.source_id, at);
  await maintainPrivateGpuResearch(production(), c, at);
  const before = await local.env.PRIVATE_DB.prepare(
    'SELECT deleted_at,backup_residual_until FROM research_runs WHERE run_id=?',
  )
    .bind(r.run_id)
    .first();
  const marker = await (await local.env.EVIDENCE.get(
    runDeletionKey(c.source.source_id, r.run_id),
  ))!.text();
  const key = 'research/highreso_public/' + r.run_id + '/0.json';
  await local.env.EVIDENCE.put(key, 'synthetic restored evidence');
  const bucket = new Proxy(local.env.EVIDENCE, {
    get(target, prop) {
      if (prop === 'delete')
        return async () => {
          throw new Error('synthetic_delete_failure');
        };
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  await expect(
    maintainPrivateGpuResearch({ ...production(), EVIDENCE: bucket }, c, at),
  ).rejects.toThrow('synthetic_delete_failure');
  expect(
    await local.env.PRIVATE_DB.prepare('SELECT last_error FROM research_runs WHERE run_id=?')
      .bind(r.run_id)
      .first('last_error'),
  ).toBe('research_evidence_cleanup_pending');
  await maintainPrivateGpuResearch(production(), c, at);
  expect(await local.env.EVIDENCE.head(key)).toBeNull();
  expect(
    await local.env.PRIVATE_DB.prepare(
      'SELECT deleted_at,backup_residual_until FROM research_runs WHERE run_id=?',
    )
      .bind(r.run_id)
      .first(),
  ).toEqual(before);
  expect(
    await (await local.env.EVIDENCE.get(runDeletionKey(c.source.source_id, r.run_id)))!.text(),
  ).toBe(marker);
  await expect(
    collectResearchPage(production(), c, query, at, {
      current_terms_version: c.terms.version,
      now: () => at,
    }),
  ).rejects.toThrow('revoked');
});

it('bounds purge to 20 observations and resumes pending deletion without losing explicit deadlines', async () => {
  const c = await publicGpuSource();
  const html =
    '<html><body><h3>Synthetic GPU</h3><p>GPU：NVIDIA A100 80GB x 1枚</p><table><tr><td>インスタンス</td><td>従量課金 [1h・台]</td><td>月額課金 [月・台]</td><td>ストレージ</td></tr>' +
    Array.from(
      { length: 24 },
      (_, i) => `<tr><td>synthetic-${i}</td><td>123円</td><td>456円</td><td>777GB</td></tr>`,
    ).join('') +
    '</table></body></html>';
  const r = await collectResearchPage(local.env, c, query, gpuTime, gpuOptions(c, gpuTime, html));
  const at = '2026-10-19T01:00:00.000Z';
  await requestResearchDeletion(production(), r.run_id, at, {
    basis_ref: 'synthetic-owner-delete',
    all_copies_delete_by: '2026-11-20T01:00:00.000Z',
  });
  for (const remaining of [28, 8, 0]) {
    await maintainPrivateGpuResearch(production(), c, at);
    expect(
      await local.env.PRIVATE_DB.prepare(
        'SELECT COUNT(*) n FROM research_gpu_observations WHERE run_id=?',
      )
        .bind(r.run_id)
        .first('n'),
    ).toBe(remaining);
  }
  expect(
    await (await local.env.EVIDENCE.get(runDeletionKey(c.source.source_id, r.run_id)))!.json(),
  ).toMatchObject({
    deleted_from: at,
    all_copies_delete_by: '2026-11-20T01:00:00.000Z',
    basis_refs: ['synthetic-owner-delete'],
  });
});

it('accepts Rebro production only as private research with independent source/day limits', async () => {
  const c = await publicGpuSource('rebro_public');
  const http = vi.spyOn(globalThis, 'fetch').mockImplementation(gpuFetcher('rebro_public'));
  const options = {
    current_terms_version: c.terms.version,
    now: () => gpuTime,
    allow_network: true,
  };
  const r = await collectResearchPage(production(), c, { kind: 'rebro_public' }, gpuTime, options);
  expect(r.state).toBe('complete');
  expect(http).toHaveBeenCalledTimes(3);
  expect((await readResearchRun(production(), c, r.run_id, options)).results).toHaveLength(2);
  expect(
    await local.env.PUBLIC_DB.prepare('SELECT COUNT(*) n FROM published_observations').first('n'),
  ).toBe(0);
});
