import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { localEnv } from '../scripts/local-env';
import { applyMigrations } from '../scripts/migrations';
import {
  collectResearchPage,
  purgeResearchEvidence,
  purgeResearchRun,
  readResearchRun,
} from '../src/research/pipeline';
import {
  eiaPage,
  eiaQuery,
  jepxQuery,
  opts,
  researchFixture,
  researchSource,
  researchTime,
} from './research-helpers';

describe('private research D1/R2 local integration', () => {
  let local: Awaited<ReturnType<typeof localEnv>>;
  beforeAll(async () => {
    local = await localEnv('test', undefined, 6);
    await local.env.PRIVATE_DB.prepare(
      "INSERT INTO collection_runs(run_id,source_id,scheduled_for,state) VALUES ('legacy-retained','ecb','2026-10-14T01:00:00.000Z','complete')",
    ).run();
    await applyMigrations(local.env.PRIVATE_DB, 'private');
  });
  afterAll(async () => {
    await local?.mf.dispose();
  });
  it('adds 0007 to a populated old DB without a public migration or altered old rows', async () => {
    expect(
      await local.env.PRIVATE_DB.prepare(
        "SELECT state FROM collection_runs WHERE run_id='legacy-retained'",
      ).first(),
    ).toEqual({ state: 'complete' });
    expect((await local.env.PRIVATE_DB.prepare('PRAGMA foreign_key_check').all()).results).toEqual(
      [],
    );
    expect(
      (
        await local.env.PUBLIC_DB.prepare(
          "SELECT name FROM sqlite_master WHERE name LIKE 'research_%'",
        ).all()
      ).results,
    ).toEqual([]);
    await applyMigrations(local.env.PRIVATE_DB, 'private'); // repeat is harmless
  });
  it('blocks unknown rights before HTTP, R2 or source registration; rejects production and synthetic leakage', async () => {
    const c = researchSource(),
      fetcher = vi.fn();
    c.source.policy.rights.automated_collection = 'review_required';
    await expect(
      collectResearchPage(local.env, c, eiaQuery, researchTime, {
        ...opts(''),
        fetcher,
        allow_network: true,
      }),
    ).rejects.toThrow('policy_blocked');
    expect(fetcher).not.toHaveBeenCalled();
    expect((await local.env.EVIDENCE.list()).objects).toHaveLength(0);
    expect(
      await local.env.PRIVATE_DB.prepare('SELECT COUNT(*) n FROM research_sources').first(),
    ).toEqual({ n: 0 });
    await expect(
      collectResearchPage(
        { ...local.env, ENVIRONMENT: 'production' },
        researchSource(),
        eiaQuery,
        researchTime,
        opts(''),
      ),
    ).rejects.toThrow('research_production_not_integrated');
    await expect(
      collectResearchPage(
        { ...local.env, ENVIRONMENT: 'development' },
        researchSource(),
        eiaQuery,
        researchTime,
        opts(''),
      ),
    ).rejects.toThrow('research_synthetic_boundary');
  });
  it('checkpoints two pages, keeps partial rows hidden, resumes without duplicates, and stores only the minimum projection', async () => {
    const c = researchSource();
    c.limits.page_size = 1;
    const first = await collectResearchPage(local.env, c, eiaQuery, researchTime, opts(eiaPage(0)));
    expect(first.state).toBe('partial');
    expect((await readResearchRun(local.env, c, first.run_id, opts(''))).results).toHaveLength(0);
    const second = await collectResearchPage(
      local.env,
      c,
      eiaQuery,
      researchTime,
      opts(eiaPage(1)),
    );
    expect(second.state).toBe('complete');
    expect(second.run_id).toBe(first.run_id);
    const again = await collectResearchPage(local.env, c, eiaQuery, researchTime, opts('broken'));
    expect(again.state).toBe('complete');
    expect((await readResearchRun(local.env, c, first.run_id, opts(''))).results).toHaveLength(2);
    const pages = (await local.env.EVIDENCE.list()).objects;
    for (const p of pages) {
      const text = await (await local.env.EVIDENCE.get(p.key))!.text();
      expect(text).not.toContain('SYNTHETIC_DO_NOT_PERSIST');
      expect(text).not.toContain('"request"');
      expect(JSON.parse(text)).toMatchObject({ synthetic: true, source_id: c.source.source_id });
    }
    expect(
      await local.env.PUBLIC_DB.prepare('SELECT COUNT(*) n FROM published_observations').first(),
    ).toEqual({ n: 0 });
    await expect(
      local.env.PRIVATE_DB.prepare("UPDATE research_observations SET record_key='changed'").run(),
    ).rejects.toThrow();
    await expect(
      local.env.PRIVATE_DB.prepare('DELETE FROM research_observations').run(),
    ).rejects.toThrow();
  });
  it('records normal reobservation and large revisions separately without overwriting history', async () => {
    const c = researchSource();
    c.limits.page_size = 1;
    const later = '2026-10-16T01:00:00.000Z';
    const next = await collectResearchPage(local.env, c, eiaQuery, later, opts(eiaPage(0), later));
    await collectResearchPage(local.env, c, eiaQuery, later, opts(eiaPage(1), later));
    const rows = (await readResearchRun(local.env, c, next.run_id, opts('', later))).results;
    expect(rows[0]).toMatchObject({ change_kind: 'reobserved' });
    const thirdTime = '2026-10-17T01:00:00.000Z';
    const revised = eiaPage(0).replace('12.3456', '123.456');
    const third = await collectResearchPage(
      local.env,
      c,
      eiaQuery,
      thirdTime,
      opts(revised, thirdTime),
    );
    await collectResearchPage(local.env, c, eiaQuery, thirdTime, opts(eiaPage(1), thirdTime));
    const changes = (await readResearchRun(local.env, c, third.run_id, opts('', thirdTime)))
      .results;
    expect(changes[0]).toMatchObject({ change_kind: 'revised' });
    expect(changes[0].previous_observation_id).toBe(rows[0].observation_id);
    expect(
      await local.env.PRIVATE_DB.prepare('SELECT COUNT(*) n FROM research_observations').first(),
    ).toEqual({ n: 6 });
  });
  it('rejects cross-page scope/total changes while another source continues', async () => {
    const c = researchSource();
    c.limits.page_size = 1;
    const when = '2026-10-18T01:00:00.000Z';
    const first = await collectResearchPage(local.env, c, eiaQuery, when, opts(eiaPage(0), when));
    await expect(
      collectResearchPage(local.env, c, eiaQuery, when, opts(eiaPage(1, 3), when)),
    ).rejects.toThrow('research_coverage_changed');
    expect(
      (await readResearchRun(local.env, c, first.run_id, opts('', when))).results,
    ).toHaveLength(0);
    const j = researchSource('jepx_spot');
    const result = await collectResearchPage(
      local.env,
      j,
      jepxQuery,
      when,
      opts(researchFixture('jepx.synthetic.csv'), when, 'jepx_spot'),
    );
    expect(result.state).toBe('complete');
    expect(
      (await readResearchRun(local.env, j, result.run_id, opts('', when, 'jepx_spot'))).results,
    ).toHaveLength(48);
  });
  it('recovers captured evidence after a DB failure, fences concurrent attempts and does not refetch', async () => {
    const c = researchSource('jepx_spot'),
      when = '2026-10-19T01:00:00.000Z';
    let batches = 0;
    const brokenDb = new Proxy(local.env.PRIVATE_DB, {
      get(target, key) {
        if (key === 'batch')
          return async (statements: D1PreparedStatement[]) => {
            expect(statements.length).toBeLessThanOrEqual(20);
            if (++batches === 2) throw new Error('synthetic_db_failure');
            return target.batch(statements);
          };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await expect(
      collectResearchPage(
        { ...local.env, PRIVATE_DB: brokenDb },
        c,
        jepxQuery,
        when,
        opts(researchFixture('jepx.synthetic.csv'), when, 'jepx_spot'),
      ),
    ).rejects.toThrow('synthetic_db_failure');
    const row = await local.env.PRIVATE_DB.prepare(
      'SELECT run_id FROM research_runs WHERE scheduled_for=? AND source_id=?',
    )
      .bind(when, c.source.source_id)
      .first<{ run_id: string }>();
    await local.env.PRIVATE_DB.prepare(
      'UPDATE research_runs SET lease_token=?,lease_until=? WHERE run_id=?',
    )
      .bind('other-owner', '2026-10-19T01:01:00.000Z', row!.run_id)
      .run();
    expect(
      (await collectResearchPage(local.env, c, jepxQuery, when, opts('broken', when, 'jepx_spot')))
        .state,
    ).toBe('leased');
    await local.env.PRIVATE_DB.prepare('UPDATE research_runs SET lease_until=NULL WHERE run_id=?')
      .bind(row!.run_id)
      .run();
    const recovered = await collectResearchPage(
      local.env,
      c,
      jepxQuery,
      when,
      opts('broken', when, 'jepx_spot'),
    );
    expect(recovered.state).toBe('complete');
    expect(
      (await readResearchRun(local.env, c, recovered.run_id, opts('', when, 'jepx_spot'))).results,
    ).toHaveLength(48);
  });
  it('keeps failed HTTP unknown, respects retry-at on rerun, and refuses credentials before a request', async () => {
    const c = researchSource('jepx_spot'),
      when = '2026-10-20T01:00:00.000Z';
    const fetcher = vi
      .fn()
      .mockImplementation(
        async () => new Response(null, { status: 429, headers: { 'retry-after': '120' } }),
      );
    const net = {
      now: () => when,
      current_terms_version: c.terms.version,
      allow_network: true,
      fetcher,
    };
    await expect(collectResearchPage(local.env, c, jepxQuery, when, net)).rejects.toThrow(
      'rate_limited',
    );
    expect((await collectResearchPage(local.env, c, jepxQuery, when, net)).state).toBe('deferred');
    expect(fetcher).toHaveBeenCalledTimes(1);
    const failed = await local.env.PRIVATE_DB.prepare(
      'SELECT state,observation_count,last_error FROM research_runs WHERE source_id=? AND scheduled_for=?',
    )
      .bind(c.source.source_id, when)
      .first();
    expect(failed).toEqual({ state: 'partial', observation_count: 0, last_error: 'rate_limited' });
    const resumeTime = '2026-10-20T01:03:00.000Z';
    const failing = vi.fn().mockImplementation(async () => new Response(null, { status: 503 }));
    const later = {
      ...net,
      fetcher: failing,
      now: () => resumeTime,
      sleep: async () => {},
      random: () => 0,
    };
    await expect(collectResearchPage(local.env, c, jepxQuery, when, later)).rejects.toThrow(
      'research_request_budget_exhausted',
    );
    await expect(collectResearchPage(local.env, c, jepxQuery, when, later)).rejects.toThrow(
      'research_request_budget_exhausted',
    );
    expect(failing).toHaveBeenCalledTimes(2);
    await expect(
      collectResearchPage(local.env, c, { ...jepxQuery, delivery_date: '2026-10-16' }, when, later),
    ).rejects.toThrow('research_scope_changed_or_daily_limit');
    const e = researchSource();
    e.limits.page_size = 1;
    await expect(
      collectResearchPage(local.env, e, eiaQuery, when, {
        ...net,
        current_terms_version: e.terms.version,
      }),
    ).rejects.toThrow('credential_url_disallowed');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('labels mocked HTTP synthetic and hides expired normalized history before bounded cleanup', async () => {
    const c = researchSource('jepx_spot');
    c.source.source_id = 'synthetic_jepx_network';
    c.source.policy.retention_days = 1;
    c.retention.evidence_days = 1;
    c.retention.normalized_days = 2;
    const fetcher = vi.fn().mockImplementation(
      async () =>
        new Response(researchFixture('jepx.synthetic.csv'), {
          headers: { 'content-type': 'text/csv; charset=utf-8' },
        }),
    );
    const opt = {
      now: () => researchTime,
      current_terms_version: c.terms.version,
      allow_network: true,
      fetcher,
    };
    const result = await collectResearchPage(local.env, c, jepxQuery, researchTime, opt);
    expect(result.state).toBe('complete');
    const capture = await local.env.EVIDENCE.get(
      'research/' + c.source.source_id + '/' + result.run_id + '/0.json',
    );
    expect(JSON.parse(await capture!.text()).synthetic).toBe(true);
    expect((await readResearchRun(local.env, c, result.run_id, opt)).results).toHaveLength(48);
    const later = { ...opt, now: () => '2026-10-18T01:00:00.000Z' };
    expect((await readResearchRun(local.env, c, result.run_id, later)).results).toHaveLength(0);
    for (let i = 0; i < 3; i++) await purgeResearchRun(local.env, result.run_id, later.now());
    expect(
      await local.env.PRIVATE_DB.prepare('SELECT state FROM research_runs WHERE run_id=?')
        .bind(result.run_id)
        .first(),
    ).toEqual({ state: 'purged' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('enforces retention for checkpointed and orphan evidence, hides revoked/restored rows, deletes in bounded chunks', async () => {
    await purgeResearchEvidence(local.env, '2026-10-28T01:00:00.000Z');
    await purgeResearchEvidence(local.env, '2026-10-28T01:00:00.000Z');
    expect((await local.env.EVIDENCE.list()).objects).toHaveLength(0);
    const c = researchSource('jepx_spot');
    const run = await local.env.PRIVATE_DB.prepare(
      "SELECT run_id FROM research_runs WHERE source_id='jepx_tokyo' AND state='complete' ORDER BY scheduled_for DESC LIMIT 1",
    ).first<{ run_id: string }>();
    await expect(purgeResearchRun(local.env, run!.run_id, researchTime)).rejects.toThrow(
      'research_retention_not_due',
    );
    await purgeResearchRun(local.env, run!.run_id, '2026-10-28T01:00:00.000Z', true);
    await expect(
      readResearchRun(local.env, c, run!.run_id, opts('', '2026-10-28T01:00:00.000Z', 'jepx_spot')),
    ).rejects.toThrow('research_policy_changed');
    const remaining = await local.env.PRIVATE_DB.prepare(
      'SELECT COUNT(*) n FROM research_observations WHERE run_id=?',
    )
      .bind(run!.run_id)
      .first();
    expect(remaining).toEqual({ n: 28 });
    await purgeResearchRun(local.env, run!.run_id, '2026-10-28T01:00:00.000Z', true);
    await purgeResearchRun(local.env, run!.run_id, '2026-10-28T01:00:00.000Z', true);
    expect(
      await local.env.PRIVATE_DB.prepare('SELECT state FROM research_runs WHERE run_id=?')
        .bind(run!.run_id)
        .first(),
    ).toEqual({ state: 'purged' });
    const stale = researchSource();
    stale.limits.page_size = 1;
    stale.terms.version = 'new-terms';
    await expect(readResearchRun(local.env, stale, run!.run_id, opts(''))).rejects.toThrow();
    expect((await local.env.PRIVATE_DB.prepare('PRAGMA foreign_key_check').all()).results).toEqual(
      [],
    );
  });
});
