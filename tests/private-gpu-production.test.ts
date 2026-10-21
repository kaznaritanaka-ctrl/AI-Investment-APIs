import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { localEnv } from '../scripts/local-env';
import {
  collectResearchPage,
  purgeResearchRun,
  purgeResearchEvidence,
  readResearchRun,
} from '../src/research/pipeline';
import {
  adoptReviewedResearchConfig,
  requestResearchDeletion,
  revokeResearchSource,
  runDeletionKey,
} from '../src/research/retention';
import {
  maintainPrivateGpuResearch,
  runPrivateGpuResearch,
  privateGpuResearchTurn,
} from '../src/research/collector';
import highreso from '../config/proposals/research/highreso_public.json';
import rebro from '../config/proposals/research/rebro_public.json';
import { ResearchConfigSchema, assertResearchAllowed } from '../src/research/schema';
import { hash, stable } from '../src/util';
import { safeLogCode } from '../src/telemetry';
import { sourceRevocationKey } from '../src/research/retention';
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
  ).resolves.toBe(false);
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

// Bundled approval is deployable, but the shipped false flag must remain closed.
it('ships flag=false with zero HTTP/runs; Highreso is approved and Rebro remains deferred', async () => {
  const http = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected HTTP'));
  const at = '2026-10-22T18:20:00.000Z';
  const env = { ...production(), PRIVATE_GPU_RESEARCH_ENABLED: 'false' };
  for (let i = 0; i < 6; i++) {
    const scheduled = new Date(Date.parse(at) + i * 300000).toISOString();
    expect(privateGpuResearchTurn(env, scheduled)).toBeNull();
    await runPrivateGpuResearch(env, scheduled, scheduled);
  }
  expect(http).not.toHaveBeenCalled();
  expect(
    await local.env.PRIVATE_DB.prepare('SELECT COUNT(*) n FROM research_runs').first('n'),
  ).toBe(0);
  const approved = ResearchConfigSchema.parse(highreso);
  expect(() => assertResearchAllowed(approved, at, approved.terms.version)).not.toThrow();
  const deferred = ResearchConfigSchema.parse(rebro);
  expect(deferred.source.enabled).toBe(false);
  expect(() => assertResearchAllowed(deferred, at, deferred.terms.version)).toThrow(
    'policy_blocked',
  );
});

it.each([
  '0007_private_research.sql',
  '0008_research_retention.sql',
  '0009_research_retention_states.sql',
  '0014_research_assessments_append_only.sql',
  '0015_private_gpu_daily.sql',
])('skips safely and logs if migration %s is missing, before R2 or HTTP', async (missing) => {
  await local.env.PRIVATE_DB.prepare('DELETE FROM d1_migrations WHERE name=?').bind(missing).run();
  const http = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected HTTP'));
  const get = vi.spyOn(local.env.EVIDENCE, 'get');
  const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
  const start = Date.parse('2026-10-22T18:20:00.000Z');
  for (let i = 0; i < 3; i++) {
    const at = new Date(start + i * 300000).toISOString();
    await expect(runPrivateGpuResearch(production(), at, at)).resolves.toBeUndefined();
  }
  expect(get).not.toHaveBeenCalled();
  expect(http).not.toHaveBeenCalled();
  expect(
    await local.env.PRIVATE_DB.prepare('SELECT COUNT(*) n FROM research_runs').first('n'),
  ).toBe(0);
  expect(logs.mock.calls.map(([s]) => JSON.parse(s).error_code)).toEqual([
    'research_schema_unavailable',
  ]);
});

it('skips an actual pre-research database without querying missing research tables', async () => {
  const old = await localEnv('test', undefined, 6);
  try {
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    const get = vi.spyOn(old.env.EVIDENCE, 'get');
    const start = Date.parse('2026-10-22T18:20:00.000Z');
    for (let i = 0; i < 3; i++) {
      const at = new Date(start + i * 300000).toISOString();
      await runPrivateGpuResearch(
        { ...old.env, ENVIRONMENT: 'production', PRIVATE_GPU_RESEARCH_ENABLED: 'true' },
        at,
        at,
      );
    }
    expect(get).not.toHaveBeenCalled();
    expect(logs.mock.calls.map(([s]) => JSON.parse(s).error_code)).toEqual([
      'research_schema_unavailable',
    ]);
  } finally {
    await old.mf.dispose();
  }
});

it('keeps captured finite retention running after an unapproved config change and acquisition stop', async () => {
  const c = await publicGpuSource();
  c.retention.normalized_days = 1;
  const r = await collectResearchPage(local.env, c, query, gpuTime, gpuOptions(c));
  const stopped = ResearchConfigSchema.parse(structuredClone(highreso));
  stopped.source.enabled = false;
  stopped.retention.time_travel_days = null; // Explicit synthetic unapproved config change.
  expect(await hash(stable(stopped))).not.toBe(await hash(stable(c)));
  const at = '2026-10-20T01:00:00.000Z';
  expect(await maintainPrivateGpuResearch(production(), stopped, at)).toBe(true);
  expect(
    await local.env.PRIVATE_DB.prepare('SELECT state FROM research_runs WHERE run_id=?')
      .bind(r.run_id)
      .first('state'),
  ).toBe('purged');
  expect(
    await local.env.PRIVATE_DB.prepare('SELECT config_hash FROM research_sources WHERE source_id=?')
      .bind(c.source.source_id)
      .first('config_hash'),
  ).toBe(await hash(stable(c)));
  const http = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected HTTP'));
  await expect(
    collectResearchPage(production(), stopped, query, at, {
      current_terms_version: stopped.terms.version,
      now: () => at,
      allow_network: true,
    }),
  ).rejects.toThrow();
  expect(http).not.toHaveBeenCalled();
});

it.each(['stop', 'revoke', 'delete'] as const)(
  'applies the non-secret %s control while preserving external metadata and retention',
  async (kind) => {
    const c = await publicGpuSource();
    const r = await collectResearchPage(local.env, c, query, gpuTime, gpuOptions(c));
    const at = '2026-10-19T01:00:00.000Z';
    const changed = structuredClone(c);
    changed.maintenance = {
      collection_stopped: true,
      revoke_at: kind === 'revoke' ? at : null,
      delete_requests:
        kind === 'delete'
          ? [
              {
                run_id: r.run_id,
                requested_at: at,
                basis_ref: 'synthetic-owner-request',
                all_copies_delete_by: '2026-11-20T01:00:00.000Z',
              },
            ]
          : [],
    };
    expect(await maintainPrivateGpuResearch(production(), changed, at)).toBe(true);
    expect(
      await local.env.PRIVATE_DB.prepare('SELECT state FROM research_runs WHERE run_id=?')
        .bind(r.run_id)
        .first('state'),
    ).toBe(kind === 'stop' ? 'complete' : 'purged');
    await expect(
      collectResearchPage(production(), changed, query, at, {
        current_terms_version: c.terms.version,
        now: () => at,
      }),
    ).rejects.toThrow('research_collection_stopped');
    if (kind === 'stop') {
      await maintainPrivateGpuResearch(production(), changed, '2027-02-01T01:00:00.000Z');
      expect(
        await local.env.PRIVATE_DB.prepare('SELECT state FROM research_runs WHERE run_id=?')
          .bind(r.run_id)
          .first('state'),
      ).toBe('purged');
    } else {
      const key =
        kind === 'revoke'
          ? sourceRevocationKey(c.source.source_id)
          : runDeletionKey(c.source.source_id, r.run_id);
      const marker = await (await local.env.EVIDENCE.get(key))!.text();
      await maintainPrivateGpuResearch(production(), changed, '2026-10-20T01:00:00.000Z');
      expect(await (await local.env.EVIDENCE.get(key))!.text()).toBe(marker);
    }
  },
);

it('advances past a persistently failing urgent run, retries it, and logs only allowlisted codes', async () => {
  const c = await publicGpuSource();
  c.retention.normalized_days = 1;
  const a = await collectResearchPage(local.env, c, query, gpuTime, gpuOptions(c));
  const day2 = '2026-10-19T01:00:00.000Z';
  const b = await collectResearchPage(local.env, c, query, day2, gpuOptions(c, day2));
  const key = 'research/highreso_public/' + a.run_id + '/0.json';
  const evidence = new Proxy(local.env.EVIDENCE, {
    get(target, prop) {
      if (prop === 'delete')
        return async (name: string) => {
          if (name === key) throw new Error('SYNTHETIC_SECRET payload or arbitrary error');
          return target.delete(name);
        };
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
  const at = '2026-10-27T01:00:00.000Z';
  for (let i = 0; i < 4; i++)
    await maintainPrivateGpuResearch({ ...production(), EVIDENCE: evidence }, c, at);
  expect(
    await local.env.PRIVATE_DB.prepare('SELECT state FROM research_runs WHERE run_id=?')
      .bind(b.run_id)
      .first('state'),
  ).toBe('purged');
  expect(
    await local.env.PRIVATE_DB.prepare('SELECT state FROM research_runs WHERE run_id=?')
      .bind(a.run_id)
      .first('state'),
  ).toBe('purging');
  const output = logs.mock.calls.map(([s]) => JSON.parse(s));
  expect(output.some((r) => r.error_code === 'research_evidence_delete_failed')).toBe(true);
  expect(output.every((r) => safeLogCode(r.error_code) === r.error_code)).toBe(true);
  expect(JSON.stringify(output)).not.toContain('SYNTHETIC_SECRET');
  await maintainPrivateGpuResearch(production(), c, at);
  await maintainPrivateGpuResearch(production(), c, at);
  expect(
    await local.env.PRIVATE_DB.prepare('SELECT state FROM research_runs WHERE run_id=?')
      .bind(a.run_id)
      .first('state'),
  ).toBe('purged');
});

it('consumes bundled non-secret deletion requests through the actual production cron entry', async () => {
  const c = await publicGpuSource();
  const r = await collectResearchPage(local.env, c, query, gpuTime, gpuOptions(c));
  const original = structuredClone(highreso.maintenance);
  const at = '2026-10-22T18:20:00.000Z';
  try {
    Object.assign(highreso, {
      maintenance: {
        collection_stopped: true,
        revoke_at: null,
        delete_requests: [
          {
            run_id: r.run_id,
            requested_at: at,
            basis_ref: 'synthetic-owner-browser-request',
            all_copies_delete_by: '2026-11-22T00:00:00.000Z',
          },
        ],
      },
    });
    const http = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected HTTP'));
    const visited = new Set();
    for (let i = 0; i < 6; i++) {
      const t = new Date(Date.parse(at) + i * 300000).toISOString();
      const turn = privateGpuResearchTurn(production(), t);
      if (turn !== null) visited.add(turn);
      await runPrivateGpuResearch(production(), t, t);
    }
    expect(visited.size).toBe(2);
    expect(
      await local.env.PRIVATE_DB.prepare('SELECT state FROM research_runs WHERE run_id=?')
        .bind(r.run_id)
        .first('state'),
    ).toBe('purged');
    expect(
      await (await local.env.EVIDENCE.get(runDeletionKey(c.source.source_id, r.run_id)))!.json(),
    ).toMatchObject({
      basis_refs: ['synthetic-owner-browser-request'],
      deleted_from: at,
      all_copies_delete_by: '2026-11-22T00:00:00.000Z',
    });
    expect(http).not.toHaveBeenCalled();
  } finally {
    highreso.maintenance = original;
  }
});

it('maintains an older run after a newer disabled policy has been explicitly registered', async () => {
  const c = await publicGpuSource();
  c.retention.normalized_days = 1;
  const r = await collectResearchPage(local.env, c, query, gpuTime, gpuOptions(c));
  const changed = structuredClone(c);
  changed.source.enabled = false;
  changed.source.policy.version += '-paused';
  changed.retention.time_travel_days = null;
  const at = '2026-10-20T01:00:00.000Z';
  const current = await adoptReviewedResearchConfig(
    production(),
    changed,
    await hash(stable(c)),
    at,
    changed.terms.version,
  );
  expect(current).not.toBe(await hash(stable(c)));
  expect(await maintainPrivateGpuResearch(production(), changed, at)).toBe(true);
  expect(
    await local.env.PRIVATE_DB.prepare('SELECT state FROM research_runs WHERE run_id=?')
      .bind(r.run_id)
      .first('state'),
  ).toBe('purged');
});

it('rejects a deletion for another source without blocking the next valid request or scan', async () => {
  const c = await publicGpuSource(),
    other = await publicGpuSource('rebro_public');
  const r = await collectResearchPage(local.env, c, query, gpuTime, gpuOptions(c));
  const o = await collectResearchPage(
    local.env,
    other,
    { kind: 'rebro_public' },
    gpuTime,
    gpuOptions(other),
  );
  const at = '2026-10-19T01:00:00.000Z';
  c.maintenance = {
    collection_stopped: true,
    revoke_at: null,
    delete_requests: [o.run_id, r.run_id].map((run_id) => ({
      run_id,
      requested_at: at,
      basis_ref: 'synthetic-delete',
      all_copies_delete_by: '2026-11-20T00:00:00.000Z',
    })),
  };
  const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await maintainPrivateGpuResearch(production(), c, at)).toBe(false);
  expect(
    await local.env.PRIVATE_DB.prepare('SELECT state FROM research_runs WHERE run_id=?')
      .bind(r.run_id)
      .first('state'),
  ).toBe('purged');
  expect(
    await local.env.PRIVATE_DB.prepare('SELECT state FROM research_runs WHERE run_id=?')
      .bind(o.run_id)
      .first('state'),
  ).toBe('complete');
  expect(
    await local.env.EVIDENCE.head(runDeletionKey(other.source.source_id, o.run_id)),
  ).toBeNull();
  expect(logs.mock.calls.map(([s]) => JSON.parse(s).error_code)).toContain(
    'research_deletion_scope_invalid',
  );
});
