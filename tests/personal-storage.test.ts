import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { personalLocalEnv } from '../scripts/personal-local-env';
import { localEnv } from '../scripts/local-env';
import { applyMigrations } from '../scripts/migrations';
import {
  collectPersonalGpu,
  readPersonalGpu,
  maintainPersonalGpu,
  stopPersonalCollection,
  revokePersonalUse,
  personalAttemptKey,
  collectPersonalGpuSources,
} from '../src/research/personal';
import {
  collectResearchPage,
  readResearchRun,
  purgeResearchRun,
  purgeResearchEvidence,
} from '../src/research/pipeline';
import { researchSource, researchTime, eiaQuery, eiaPage, opts } from './research-helpers';
import { personalFixture, gpuTime } from './personal-fixture';
import { gpuFetcher, gpuHtml } from './public-gpu-helpers';
import { stable } from '../src/util';
import { renewPersonalReview } from '../src/research/personal-review';

describe('local personal exception persistence (no live HTTP)', () => {
  let local: Awaited<ReturnType<typeof personalLocalEnv>>;
  beforeEach(async () => {
    local = await personalLocalEnv('synthetic-store');
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await local?.mf.dispose();
  });
  const options = (fetcher = vi.fn(gpuFetcher('highreso_public')), at = gpuTime) => ({
    allow_network: true,
    fetcher,
    now: () => at,
  });
  it('rejects unapproved and wrong-scope execution before any persistent writes or HTTP', async () => {
    const c = await personalFixture(),
      fetcher = vi.fn(gpuFetcher('highreso_public'));
    await expect(
      collectPersonalGpu(local.env, { ...c, status: 'draft' }, options(fetcher)),
    ).rejects.toThrow('personal_contract_invalid');
    await expect(
      collectPersonalGpu({ ...local.env, ENVIRONMENT: 'production' }, c, options(fetcher)),
    ).rejects.toThrow('personal_production_forbidden');
    await expect(
      collectPersonalGpu({ ...local.env, PERSONAL_STORE_ID: 'wrong' }, c, options(fetcher)),
    ).rejects.toThrow('personal_store_mismatch');
    await expect(
      collectPersonalGpu(local.env, c, { now: () => gpuTime, allow_network: true }),
    ).rejects.toThrow('personal_fixture_fetcher_required');
    expect(fetcher).not.toHaveBeenCalled();
    expect((await local.env.EVIDENCE.list()).objects).toHaveLength(0);
    expect(
      await local.env.PRIVATE_DB.prepare('SELECT COUNT(*) n FROM research_sources').first(),
    ).toEqual({ n: 0 });
    expect('PUBLIC_DB' in local.env).toBe(false);
  });
  it('collects both sources with unmodified grants, immutable provenance and bounded projections', async () => {
    for (const adapter of ['highreso_public', 'rebro_public'] as const) {
      const c = await personalFixture(adapter),
        before = stable(c.config),
        fetcher = vi.fn(gpuFetcher(adapter));
      const run = await collectPersonalGpu(local.env, c, options(fetcher));
      expect(run.state).toBe('complete');
      expect(fetcher).toHaveBeenCalledTimes(3);
      expect(stable(c.config)).toBe(before);
      const read = await readPersonalGpu(local.env, c, options(fetcher));
      expect(read.provider_permission).toBe('unconfirmed');
      expect(read.results).toHaveLength(adapter === 'highreso_public' ? 4 : 2);
      const saved = await local.env.PRIVATE_DB.prepare(
        'SELECT contract_json FROM research_personal_contracts WHERE source_id=?',
      )
        .bind(adapter)
        .first<{ contract_json: string }>();
      expect(JSON.parse(saved!.contract_json).config.source.policy.rights.private_storage).toBe(
        'review_required',
      );
      const key = (await local.env.EVIDENCE.list({ prefix: 'research/personal/' + adapter }))
        .objects[0].key;
      const evidence = await (await local.env.EVIDENCE.get(key))!.text();
      expect(evidence).not.toContain('SYNTHETIC_DO_NOT_PERSIST');
      expect(JSON.parse(evidence)).toMatchObject({
        authority_kind: 'owner_personal_research_exception',
        provider_permission: 'unconfirmed',
        synthetic: true,
      });
      await expect(
        local.env.PRIVATE_DB.prepare(
          "UPDATE research_personal_contracts SET contract_json='{}'",
        ).run(),
      ).rejects.toThrow();
      await expect(
        local.env.PRIVATE_DB.prepare("UPDATE research_gpu_observations SET domain_json='{}'").run(),
      ).rejects.toThrow();
      await expect(
        readResearchRun(local.env, c.config, run.run_id, {
          current_terms_version: c.config.terms.version,
          now: () => gpuTime,
        }),
      ).rejects.toThrow('policy_blocked');
      await expect(
        purgeResearchRun(local.env, run.run_id, '2026-11-02T00:00:00.000Z', {
          time_travel_days: 7,
        }),
      ).rejects.toThrow();
    }
    expect(
      await local.env.PRIVATE_DB.prepare('SELECT COUNT(*) n FROM observations').first(),
    ).toEqual({ n: 0 });
    expect(
      await local.env.PRIVATE_DB.prepare('SELECT COUNT(*) n FROM research_observations').first(),
    ).toEqual({ n: 0 });
  });
  it('reuses a complete run across dates and does not reset its one-time budget through new metadata', async () => {
    const c = await personalFixture(),
      fetcher = vi.fn(gpuFetcher('highreso_public'));
    const first = await collectPersonalGpu(local.env, c, options(fetcher));
    const again = await collectPersonalGpu(
      local.env,
      c,
      options(fetcher, '2026-10-19T01:00:00.000Z'),
    );
    expect(again).toMatchObject({ run_id: first.run_id, reused: true });
    expect(fetcher).toHaveBeenCalledTimes(3);
    c.decision.exception_id = 'synthetic-second';
    await expect(collectPersonalGpu(local.env, c, options(fetcher))).rejects.toThrow(
      'personal_current_contract_changed',
    );
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('isolates schema/terms errors and rate limits without saving zero stock or retrying', async () => {
    const c = await personalFixture(),
      bad = vi.fn(gpuFetcher('highreso_public', '<html>broken</html>'));
    await expect(collectPersonalGpu(local.env, c, options(bad))).rejects.toThrow(
      'public_gpu_table_missing',
    );
    expect(bad).toHaveBeenCalledTimes(3);
    await expect(
      collectPersonalGpu(local.env, c, options(bad, '2026-10-19T01:00:00.000Z')),
    ).rejects.toThrow('personal_collection_stopped');
    const b = await personalFixture('rebro_public'),
      limited = vi.fn(
        async () => new Response('', { status: 429, headers: { 'retry-after': '86400' } }),
      );
    await expect(collectPersonalGpu(local.env, b, options(limited))).rejects.toThrow(
      'rate_limited',
    );
    expect(limited).toHaveBeenCalledTimes(1);
    expect(
      await local.env.PRIVATE_DB.prepare(
        'SELECT COUNT(*) n FROM research_gpu_observations',
      ).first(),
    ).toEqual({ n: 0 });
    expect(
      (
        await local.env.PRIVATE_DB.prepare(
          'SELECT state,observation_count FROM research_runs',
        ).all()
      ).results,
    ).toEqual([
      { state: 'partial', observation_count: 0 },
      { state: 'partial', observation_count: 0 },
    ]);
  });
  it('resumes a DB interruption from evidence only and honors an active lease', async () => {
    const c = await personalFixture(),
      fetcher = vi.fn(gpuFetcher('highreso_public'));
    let batches = 0;
    const broken = new Proxy(local.env.PRIVATE_DB, {
      get(target, key) {
        if (key === 'batch')
          return async (stmts: D1PreparedStatement[]) => {
            if (++batches === 3) throw new Error('synthetic_db_failure');
            return target.batch(stmts);
          };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await expect(
      collectPersonalGpu({ ...local.env, PRIVATE_DB: broken }, c, options(fetcher)),
    ).rejects.toThrow('synthetic_db_failure');
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect((await readPersonalGpu(local.env, c, options(fetcher))).results).toHaveLength(0);
    await local.env.PRIVATE_DB.prepare(
      "UPDATE research_runs SET lease_token='other',lease_until='2026-10-18T01:02:00.000Z'",
    ).run();
    expect((await collectPersonalGpu(local.env, c, options(fetcher))).state).toBe('leased');
    await local.env.PRIVATE_DB.prepare('UPDATE research_runs SET lease_until=NULL').run();
    expect((await collectPersonalGpu(local.env, c, options(fetcher))).state).toBe('complete');
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('isolates a terms mismatch so another approved synthetic source can complete', async () => {
    const a = await personalFixture(),
      b = await personalFixture('rebro_public');
    const first = vi.fn(async (url: Parameters<typeof fetch>[0], init?: RequestInit) =>
      String(url).endsWith('/terms')
        ? new Response('<html>changed synthetic terms</html>', {
            headers: { 'content-type': 'text/html' },
          })
        : gpuFetcher('highreso_public')(url, init),
    );
    const second = vi.fn(gpuFetcher('rebro_public'));
    const result = await collectPersonalGpuSources(local.env, [a, b], (input) =>
      options(input === a ? first : second),
    );
    expect(result).toMatchObject([
      { state: 'blocked', reason: 'public_gpu_terms_review_required' },
      { state: 'complete', observation_count: 2 },
    ]);
    expect(first).toHaveBeenCalledTimes(2);
    expect(second).toHaveBeenCalledTimes(3);
  });
  it('checks revocation after data HTTP and before capture persistence', async () => {
    const c = await personalFixture();
    const fetcher = vi.fn(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const response = await gpuFetcher('highreso_public')(url, init);
      if (String(url).endsWith('/compute/instances'))
        await revokePersonalUse(local.env, c, 'synthetic mid-fetch revoke', { now: () => gpuTime });
      return response;
    });
    await expect(collectPersonalGpu(local.env, c, options(fetcher))).rejects.toThrow(
      'research_run_deleted',
    );
    expect((await local.env.EVIDENCE.list({ prefix: 'research/personal/' })).objects).toHaveLength(
      0,
    );
    expect(
      await local.env.PRIVATE_DB.prepare(
        'SELECT COUNT(*) n FROM research_gpu_observations',
      ).first(),
    ).toEqual({ n: 0 });
  });
  it('stores 48 observations in bounded batches and purges all of them without extending deadlines', async () => {
    const c = await personalFixture();
    const html = gpuHtml('highreso_public').replace(/<tr><td>synthetic-a100[\s\S]*?<\/tr>/, (row) =>
      Array.from({ length: 23 }, (_, i) =>
        row.replace('synthetic-a100', 'synthetic-a100-' + i),
      ).join(''),
    );
    const sizes: number[] = [];
    const db = new Proxy(local.env.PRIVATE_DB, {
      get(target, key) {
        if (key === 'batch')
          return async (stmts: D1PreparedStatement[]) => {
            sizes.push(stmts.length);
            return target.batch(stmts);
          };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const run = await collectPersonalGpu(
      { ...local.env, PRIVATE_DB: db },
      c,
      options(vi.fn(gpuFetcher('highreso_public', html))),
    );
    expect(run.observation_count).toBe(48);
    expect(Math.max(...sizes)).toBe(20);
    expect(
      await maintainPersonalGpu(local.env, c, { now: () => '2026-10-28T01:00:00.000Z' }),
    ).toMatchObject({ state: 'purged', remaining: 0 });
  });
  it('keeps the consumed attempt outside D1 and rejects re-fetch after an empty DB restore', async () => {
    const c = await personalFixture(),
      fetcher = vi.fn(gpuFetcher('highreso_public'));
    await collectPersonalGpu(local.env, c, options(fetcher));
    const restored = await personalLocalEnv('synthetic-store');
    try {
      const key = personalAttemptKey(c),
        body = await (await local.env.EVIDENCE.get(key))!.text();
      await restored.env.EVIDENCE.put(key, body);
      await expect(collectPersonalGpu(restored.env, c, options(fetcher))).rejects.toThrow(
        'personal_attempt_consumed',
      );
      expect(fetcher).toHaveBeenCalledTimes(3);
    } finally {
      await restored.mf.dispose();
    }
  });
  it('leases simultaneous invocations so only one bounded HTTP attempt runs', async () => {
    const c = await personalFixture(),
      fetcher = vi.fn(gpuFetcher('highreso_public'));
    const runs = await Promise.all([
      collectPersonalGpu(local.env, c, options(fetcher)),
      collectPersonalGpu(local.env, c, options(fetcher)),
    ]);
    expect(runs.some((run) => run.state === 'complete')).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(
      await local.env.PRIVATE_DB.prepare(
        'SELECT COUNT(*) n FROM research_gpu_observations',
      ).first(),
    ).toEqual({ n: 4 });
  });
  it('reconciles a populated DB restore against surviving deletion controls before read', async () => {
    const c = await personalFixture(),
      fetcher = vi.fn(gpuFetcher('highreso_public'));
    await collectPersonalGpu(local.env, c, options(fetcher));
    const tables = [
      'research_sources',
      'research_personal_contracts',
      'research_runs',
      'research_personal_runs',
      'research_pages',
      'research_gpu_observations',
    ];
    const snapshot = await Promise.all(
      tables.map((table) => local.env.PRIVATE_DB.prepare('SELECT * FROM ' + table).all()),
    );
    await revokePersonalUse(local.env, c, 'synthetic revocation', options(fetcher));
    const restored = await personalLocalEnv('synthetic-store');
    try {
      for (let i = 0; i < tables.length; i++)
        for (const row of snapshot[i].results)
          await restored.env.PRIVATE_DB.prepare(
            'INSERT INTO ' +
              tables[i] +
              ' (' +
              Object.keys(row).join(',') +
              ') VALUES (' +
              Object.keys(row)
                .map(() => '?')
                .join(',') +
              ')',
          )
            .bind(...Object.values(row))
            .run();
      for (const object of (await local.env.EVIDENCE.list({ prefix: 'research-control/' })).objects)
        await restored.env.EVIDENCE.put(
          object.key,
          await (await local.env.EVIDENCE.get(object.key))!.text(),
        );
      await expect(readPersonalGpu(restored.env, c, options(fetcher))).rejects.toThrow(
        'research_run_deleted',
      );
      expect(
        await restored.env.PRIVATE_DB.prepare(
          'SELECT COUNT(*) n FROM research_gpu_observations',
        ).first(),
      ).toEqual({ n: 0 });
      await expect(collectPersonalGpu(restored.env, c, options(fetcher))).rejects.toThrow(
        'research_run_deleted',
      );
      expect(fetcher).toHaveBeenCalledTimes(3);
    } finally {
      await restored.mf.dispose();
    }
  });
  it('separates collection stop and review_due from storage expiry; blocks restored revoked evidence', async () => {
    const c = await personalFixture(),
      fetcher = vi.fn(gpuFetcher('highreso_public'));
    const run = await collectPersonalGpu(local.env, c, options(fetcher));
    const evidence = (await local.env.EVIDENCE.list({ prefix: 'research/personal/' })).objects[0]
      .key;
    const saved = await (await local.env.EVIDENCE.get(evidence))!.text();
    await purgeResearchEvidence(local.env, '2026-10-19T01:00:00.000Z');
    expect(await local.env.EVIDENCE.head(evidence)).not.toBeNull();
    await stopPersonalCollection(local.env, c, 'synthetic owner stop', options(fetcher));
    expect((await readPersonalGpu(local.env, c, options(fetcher))).results).toHaveLength(4);
    expect(
      await maintainPersonalGpu(local.env, c, options(fetcher, c.decision.terms.review_after)),
    ).toMatchObject({ state: 'review_due', storage: 'owner_exception', remaining: 4 });
    expect(await local.env.EVIDENCE.head(evidence)).toBeNull();
    expect(
      (await local.env.EVIDENCE.list({ prefix: 'research-control/deletions/' })).objects,
    ).toHaveLength(0);
    await expect(
      readPersonalGpu(local.env, c, options(fetcher, c.decision.terms.review_after)),
    ).rejects.toThrow('personal_terms_review_required');
    expect(
      await revokePersonalUse(
        local.env,
        c,
        'synthetic revocation',
        options(fetcher, c.decision.terms.review_after),
      ),
    ).toMatchObject({ state: 'purged', remaining: 0 });
    await local.env.EVIDENCE.put(evidence, saved);
    await maintainPersonalGpu(local.env, c, options(fetcher, c.decision.terms.review_after));
    expect(await local.env.EVIDENCE.head(evidence)).toBeNull();
    expect(
      await local.env.PRIVATE_DB.prepare('SELECT state FROM research_runs WHERE run_id=?')
        .bind(run.run_id)
        .first(),
    ).toEqual({ state: 'purged' });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('automatically purges at the captured deadline even when the acquisition window has ended', async () => {
    const c = await personalFixture(),
      fetcher = vi.fn(gpuFetcher('highreso_public'));
    await collectPersonalGpu(local.env, c, options(fetcher));
    const at = '2026-10-28T01:00:00.000Z';
    expect(await maintainPersonalGpu(local.env, c, options(fetcher, at))).toMatchObject({
      state: 'purged',
      remaining: 0,
      deadline_missed: false,
    });
    expect((await local.env.EVIDENCE.list({ prefix: 'research/personal/' })).objects).toHaveLength(
      0,
    );
    expect(
      (await local.env.EVIDENCE.list({ prefix: 'research-control/personal-attempts/' })).objects,
    ).toHaveLength(1);
    await expect(readPersonalGpu(local.env, c, options(fetcher, at))).rejects.toThrow();
  });
  it('preserves populated personal v1 history and its finite deadlines through 0012', async () => {
    const old = await localEnv('test', undefined, 11);
    const env = {
      PRIVATE_DB: old.env.PRIVATE_DB,
      EVIDENCE: old.env.EVIDENCE,
      ENVIRONMENT: 'test' as const,
      PERSONAL_STORE_ID: 'synthetic-store',
    };
    try {
      const c = await personalFixture(),
        run = await collectPersonalGpu(env, c, options());
      const tables = [
        'research_runs',
        'research_pages',
        'research_gpu_observations',
        'research_personal_contracts',
        'research_personal_runs',
      ];
      const before = await Promise.all(
        tables.map((t) => env.PRIVATE_DB.prepare('SELECT * FROM ' + t).all()),
      );
      await applyMigrations(env.PRIVATE_DB, 'private');
      expect(
        await Promise.all(
          tables.map((t) =>
            env.PRIVATE_DB.prepare('SELECT * FROM ' + t)
              .all()
              .then((r) => r.results),
          ),
        ),
      ).toEqual(before.map((r) => r.results));
      expect((await env.PRIVATE_DB.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
      await expect(
        env.PRIVATE_DB.prepare('UPDATE research_gpu_observations SET observed_at=? WHERE run_id=?')
          .bind(gpuTime, run.run_id)
          .run(),
      ).rejects.toThrow();
      await expect(renewPersonalReview(env, c, {}, options())).rejects.toThrow(
        'personal_review_scope_invalid',
      );
      expect(
        await maintainPersonalGpu(env, c, { now: () => '2026-10-28T01:00:00.000Z' }),
      ).toMatchObject({ state: 'purged', remaining: 0 });
      expect(c.config.source.policy.rights.private_storage).toBe('review_required');
    } finally {
      await old.mf.dispose();
    }
  }, 120000);
  it('preserves populated 0010 history and deadlines through forward migration', async () => {
    const old = await localEnv('test', undefined, 10);
    try {
      const config = researchSource(),
        run = await collectResearchPage(
          old.env,
          config,
          eiaQuery,
          researchTime,
          opts(eiaPage(0, 1)),
        );
      const before = await old.env.PRIVATE_DB.prepare('SELECT * FROM research_runs WHERE run_id=?')
        .bind(run.run_id)
        .first();
      await applyMigrations(old.env.PRIVATE_DB, 'private');
      expect(
        await old.env.PRIVATE_DB.prepare('SELECT * FROM research_runs WHERE run_id=?')
          .bind(run.run_id)
          .first(),
      ).toEqual(before);
      expect((await old.env.PRIVATE_DB.prepare('PRAGMA foreign_key_check').all()).results).toEqual(
        [],
      );
    } finally {
      await old.mf.dispose();
    }
  });
});
