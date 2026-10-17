import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { localEnv } from '../scripts/local-env';
import { applyMigrations } from '../scripts/migrations';
import { hash, stable } from '../src/util';
import { assertResearchAllowed, type ResearchConfig } from '../src/research/schema';
import {
  collectResearchPage,
  purgeResearchEvidence,
  purgeResearchRun,
  readResearchRun,
  reconcileResearchRun,
} from '../src/research/pipeline';
import {
  adoptReviewedResearchConfig,
  plusDays,
  revokeResearchSource,
  runDeletionKey,
  sourceRevocationKey,
} from '../src/research/retention';
import { eiaQuery, opts, researchFixture, researchSource, researchTime } from './research-helpers';

const body = researchFixture('eia.synthetic.json');
const atDay = (day: number) => plusDays(researchTime, day);
function longSource(id: string, days = 1095) {
  const c = researchSource();
  c.source.source_id = 'synthetic_' + id;
  c.source.policy.version = id + '-v1';
  c.source.policy.valid_until = '2037-01-01T00:00:00.000Z';
  c.terms.review_after = '2037-01-01T00:00:00.000Z';
  c.retention.normalized_days = days;
  c.retention.storage_review_hold!.all_copies_delete_by = '2037-01-01T00:00:00.000Z';
  c.retention.target_days = days;
  c.source.policy.retention_limit_days = days + 30;
  return c;
}
function renewal(c: ResearchConfig, version: string, at: string, oldHash?: string) {
  const next = structuredClone(c);
  next.source.policy.version = version;
  next.source.policy.valid_from = at;
  next.source.policy.valid_until = '2037-01-01T00:00:00.000Z';
  next.terms.checked_at = at;
  next.terms.review_after = '2037-01-01T00:00:00.000Z';
  next.terms.version = version + '-terms';
  next.source.policy.evidence_version = next.terms.version;
  next.history_access = oldHash
    ? [{ config_hash: oldHash, approval_ref: 'synthetic-explicit-historical-use-review' }]
    : [];
  return next;
}
const options = (c: ResearchConfig, at: string, text = '') => ({
  ...opts(text, at),
  current_terms_version: c.terms.version,
});

describe('long research retention and restore (synthetic only)', () => {
  let local: Awaited<ReturnType<typeof localEnv>>;
  beforeAll(async () => {
    local = await localEnv();
  });
  afterAll(async () => {
    await local?.mf.dispose();
  });

  it('requires a reviewed duration and backup/lifecycle facts independently of a 5-year target', async () => {
    const c = longSource('unreviewed', 1825);
    c.retention.normalized_days = null;
    const fetcher = vi.fn();
    await expect(
      collectResearchPage(local.env, c, eiaQuery, researchTime, {
        ...options(c, researchTime),
        fetcher,
      }),
    ).rejects.toThrow('retention_review_required');
    expect(fetcher).not.toHaveBeenCalled();
    expect(
      await local.env.PRIVATE_DB.prepare('SELECT COUNT(*) n FROM research_sources').first(),
    ).toEqual({ n: 0 });
    c.retention.normalized_days = 1825;
    c.retention.time_travel_days = null;
    expect(() => assertResearchAllowed(c, researchTime, c.terms.version)).toThrow(
      'retention_review_required',
    );
    c.retention.time_travel_days = 30;
    c.retention.backup_days = 7;
    expect(() => assertResearchAllowed(c, researchTime, c.terms.version)).toThrow(
      'retention_review_required',
    );
    c.retention.backup_days = 30;
    c.source.policy.retention_limit_days = 1854;
    expect(() => assertResearchAllowed(c, researchTime, c.terms.version)).toThrow(
      'retention_review_required',
    );
    c.source.policy.retention_limit_days = 1855;
    expect(() => assertResearchAllowed(c, researchTime, c.terms.version)).not.toThrow();
    c.retention.lifecycle_review_ref = null;
    expect(() => assertResearchAllowed(c, researchTime, c.terms.version)).toThrow(
      'retention_review_required',
    );
  });

  it.each([1095, 1825])(
    'keeps %i-day history after evidence deletion and expires exactly at its captured boundary',
    async (days) => {
      const c = longSource('boundary_' + days, days);
      c.retention.storage_review_hold = null;
      const run = await collectResearchPage(
        local.env,
        c,
        eiaQuery,
        researchTime,
        options(c, researchTime, body),
      );
      await purgeResearchEvidence(local.env, atDay(7));
      expect(
        (await local.env.EVIDENCE.list({ prefix: 'research/' + c.source.source_id + '/' })).objects,
      ).toHaveLength(0);
      expect(
        (await readResearchRun(local.env, c, run.run_id, options(c, atDay(91)))).results,
      ).toHaveLength(2);
      await expect(
        purgeResearchRun(local.env, run.run_id, atDay(90), { time_travel_days: 7 }),
      ).rejects.toThrow('research_retention_not_due');
      expect(
        (
          await readResearchRun(
            local.env,
            c,
            run.run_id,
            options(c, plusDays(atDay(days), -1 / 86400000)),
          )
        ).results,
      ).toHaveLength(2);
      expect(
        (await readResearchRun(local.env, c, run.run_id, options(c, atDay(days)))).results,
      ).toHaveLength(0);
      await expect(
        local.env.PRIVATE_DB.prepare(
          'UPDATE research_runs SET normalized_expires_at=? WHERE run_id=?',
        )
          .bind(atDay(days + 100), run.run_id)
          .run(),
      ).rejects.toThrow('immutable_research_retention');
      const deleted = await reconcileResearchRun(
        local.env,
        c,
        run.run_id,
        atDay(days),
        c.terms.version,
      );
      expect(deleted).toMatchObject({
        remaining: 0,
        backup_residual_until: atDay(days + 7),
        backup_deadline_missed: false,
      });
      expect(
        await local.env.EVIDENCE.head(runDeletionKey(c.source.source_id, run.run_id)),
      ).not.toBeNull();
    },
  );

  it('preserves pre-revision values and normal reobservations over multiple years without calling old history stale', async () => {
    const c = longSource('lineage', 1825);
    const first = await collectResearchPage(
      local.env,
      c,
      eiaQuery,
      researchTime,
      options(c, researchTime, body),
    );
    const second = await collectResearchPage(
      local.env,
      c,
      eiaQuery,
      atDay(365),
      options(c, atDay(365), body),
    );
    const third = await collectResearchPage(
      local.env,
      c,
      eiaQuery,
      atDay(730),
      options(c, atDay(730), body.replace('12.3456', '123.456')),
    );
    const before = (await readResearchRun(local.env, c, first.run_id, options(c, atDay(1095))))
      .results;
    const again = (await readResearchRun(local.env, c, second.run_id, options(c, atDay(1095))))
      .results;
    const revised = (await readResearchRun(local.env, c, third.run_id, options(c, atDay(1095))))
      .results;
    expect(JSON.parse(String(before[0].domain_json)).amount_decimal).toBe('12.3456');
    expect(again[0]).toMatchObject({
      change_kind: 'reobserved',
      previous_observation_id: before[0].observation_id,
    });
    expect(revised[0]).toMatchObject({
      change_kind: 'revised',
      previous_observation_id: again[0].observation_id,
    });
  });

  it('requires explicit historical reauthorization on renewal and never extends the original 1095-day expiry', async () => {
    const c = longSource('renewal');
    c.terms.review_after = atDay(90);
    const originalHash = await hash(stable(c));
    const run = await collectResearchPage(
      local.env,
      c,
      eiaQuery,
      researchTime,
      options(c, researchTime, body),
    );
    await expect(readResearchRun(local.env, c, run.run_id, options(c, atDay(90)))).rejects.toThrow(
      'terms_review_required',
    );
    const next = renewal(c, 'renewal-v2', atDay(90));
    next.retention.normalized_days = 1825;
    next.source.policy.retention_limit_days = 1855;
    const nextHash = await adoptReviewedResearchConfig(
      local.env,
      next,
      originalHash,
      atDay(90),
      next.terms.version,
    );
    await expect(
      readResearchRun(local.env, next, run.run_id, options(next, atDay(91))),
    ).rejects.toThrow('research_history_scope_unreviewed');
    const reviewed = renewal(next, 'renewal-v3', atDay(91), originalHash);
    await adoptReviewedResearchConfig(
      local.env,
      reviewed,
      nextHash,
      atDay(91),
      reviewed.terms.version,
    );
    expect(
      (await readResearchRun(local.env, reviewed, run.run_id, options(reviewed, atDay(1094))))
        .results,
    ).toHaveLength(2);
    expect(
      (await readResearchRun(local.env, reviewed, run.run_id, options(reviewed, atDay(1095))))
        .results,
    ).toHaveLength(0);
    expect(
      await local.env.PRIVATE_DB.prepare(
        'SELECT normalized_expires_at FROM research_runs WHERE run_id=?',
      )
        .bind(run.run_id)
        .first(),
    ).toEqual({ normalized_expires_at: atDay(1095) });
    await expect(
      local.env.PRIVATE_DB.prepare(
        "UPDATE research_config_versions SET config_json='{}' WHERE config_hash=?",
      )
        .bind(originalHash)
        .run(),
    ).rejects.toThrow('immutable_research_config');
  });

  it('allows an explicitly paused source to retain reviewed history but rejects new collection', async () => {
    const c = longSource('paused');
    const oldHash = await hash(stable(c));
    const run = await collectResearchPage(
      local.env,
      c,
      eiaQuery,
      researchTime,
      options(c, researchTime, body),
    );
    const paused = renewal(c, 'paused-v2', atDay(1), oldHash);
    paused.source.enabled = false;
    paused.source.policy.rights.automated_collection = 'expired';
    await adoptReviewedResearchConfig(local.env, paused, oldHash, atDay(1), paused.terms.version);
    expect(
      (await readResearchRun(local.env, paused, run.run_id, options(paused, atDay(365)))).results,
    ).toHaveLength(2);
    await expect(
      collectResearchPage(
        local.env,
        paused,
        eiaQuery,
        atDay(365),
        options(paused, atDay(365), body),
      ),
    ).rejects.toThrow('policy_blocked');
    expect(
      (await reconcileResearchRun(local.env, paused, run.run_id, atDay(365), paused.terms.version))
        ?.decision,
    ).toMatchObject({
      state: 'collection_stopped',
      storage: 'allowed',
      read_allowed: true,
      collection_allowed: false,
    });
  });

  it('shortens retained use under new terms and replays deletion markers without retroactive grants', async () => {
    const c = longSource('shorter');
    const oldHash = await hash(stable(c));
    const run = await collectResearchPage(
      local.env,
      c,
      eiaQuery,
      researchTime,
      options(c, researchTime, body),
    );
    const next = renewal(c, 'shorter-v2', atDay(1), oldHash);
    next.retention.evidence_days = 2;
    next.source.policy.retention_days = 2;
    next.retention.normalized_days = 70;
    next.source.policy.retention_limit_days = 100;
    await adoptReviewedResearchConfig(local.env, next, oldHash, atDay(1), next.terms.version);
    await reconcileResearchRun(local.env, next, run.run_id, atDay(2), next.terms.version);
    expect(
      (await local.env.EVIDENCE.list({ prefix: 'research/' + c.source.source_id + '/' })).objects,
    ).toHaveLength(0);
    expect(
      (await readResearchRun(local.env, next, run.run_id, options(next, atDay(69)))).results,
    ).toHaveLength(2);
    expect(
      (await readResearchRun(local.env, next, run.run_id, options(next, atDay(70)))).results,
    ).toHaveLength(0);
    expect(
      (await reconcileResearchRun(local.env, next, run.run_id, atDay(70), next.terms.version))
        ?.remaining,
    ).toBe(0);
  });

  it('retains history when periodic review is due, blocks HTTP/read, and restores read after explicit re-review', async () => {
    const c = longSource('lapsed');
    c.retention.storage_review_hold = null;
    c.terms.review_after = atDay(20);
    const run = await collectResearchPage(
      local.env,
      c,
      eiaQuery,
      researchTime,
      options(c, researchTime, body),
    );
    await expect(readResearchRun(local.env, c, run.run_id, options(c, atDay(20)))).rejects.toThrow(
      'terms_review_required',
    );
    const fetcher = vi.fn();
    await expect(
      collectResearchPage(local.env, c, eiaQuery, atDay(20), {
        ...options(c, atDay(20)),
        fetcher,
        allow_network: true,
      }),
    ).rejects.toThrow('terms_review_required');
    expect(fetcher).not.toHaveBeenCalled();
    expect(
      await reconcileResearchRun(local.env, c, run.run_id, atDay(20), c.terms.version),
    ).toMatchObject({
      remaining: null,
      decision: {
        state: 'review_due',
        storage: 'allowed',
        next_action: 'review_terms',
        read_allowed: false,
        collection_allowed: false,
      },
    });
    expect(await local.env.EVIDENCE.get(runDeletionKey(c.source.source_id, run.run_id))).toBeNull();
    expect(
      await local.env.PRIVATE_DB.prepare(
        'SELECT COUNT(*) n FROM research_observations WHERE run_id=?',
      )
        .bind(run.run_id)
        .first(),
    ).toEqual({ n: 2 });
    const audit = await local.env.PRIVATE_DB.prepare(
      'SELECT decision_json FROM research_retention_assessments WHERE run_id=?',
    )
      .bind(run.run_id)
      .first<{ decision_json: string }>();
    expect(JSON.parse(audit!.decision_json)).toMatchObject({
      state: 'review_due',
      evidence_status: 'expired',
      revalidation: 'unavailable',
    });
    const oldHash = await hash(stable(c));
    const next = renewal(c, 'lapsed-v2', atDay(21), oldHash);
    await adoptReviewedResearchConfig(local.env, next, oldHash, atDay(21), next.terms.version);
    expect(
      (await readResearchRun(local.env, next, run.run_id, options(next, atDay(21)))).results,
    ).toHaveLength(2);
    expect(
      (await reconcileResearchRun(local.env, next, run.run_id, atDay(21), next.terms.version))
        ?.decision.state,
    ).toBe('active');
  });

  it('detects backup-window growth and late deletion instead of claiming backup erasure', async () => {
    const c = longSource('backups');
    c.retention.backup_days = 7;
    c.source.policy.retention_limit_days = 1102;
    const run = await collectResearchPage(
      local.env,
      c,
      eiaQuery,
      researchTime,
      options(c, researchTime, body),
    );
    const originalHash = await hash(stable(c));
    const next = renewal(c, 'backups-v2', atDay(1000), originalHash);
    next.retention.backup_days = 30;
    next.retention.time_travel_days = 30;
    next.source.policy.retention_limit_days = 1125;
    await adoptReviewedResearchConfig(
      local.env,
      next,
      originalHash,
      atDay(1000),
      next.terms.version,
    );
    await expect(
      readResearchRun(local.env, next, run.run_id, options(next, atDay(1094))),
    ).rejects.toThrow('historical_backup_review_required');
    const result = await reconcileResearchRun(
      local.env,
      next,
      run.run_id,
      atDay(1096),
      next.terms.version,
    );
    expect(result).toMatchObject({
      remaining: 0,
      backup_residual_until: atDay(1126),
      backup_deadline_missed: true,
    });
  });

  it('survives a D1 rollback with external revoke/deletion markers and re-deletes restored rows', async () => {
    const c = longSource('restore');
    const run = await collectResearchPage(
      local.env,
      c,
      eiaQuery,
      researchTime,
      options(c, researchTime, body),
    );
    const single = longSource('restore_deleted_run');
    const singleRun = await collectResearchPage(
      local.env,
      single,
      eiaQuery,
      researchTime,
      options(single, researchTime, body),
    );
    const tables = [
      'research_sources',
      'research_config_versions',
      'research_runs',
      'research_pages',
      'research_observations',
      'research_retention_assessments',
    ];
    const backup = [];
    for (const table of tables)
      backup.push({
        table,
        rows: (await local.env.PRIVATE_DB.prepare('SELECT * FROM ' + table).all()).results,
      });
    await local.env.PRIVATE_DB.prepare('UPDATE research_runs SET lease_until=? WHERE run_id=?')
      .bind(atDay(1), run.run_id)
      .run();
    await expect(
      purgeResearchRun(local.env, run.run_id, researchTime, { revoke: true, time_travel_days: 7 }),
    ).rejects.toThrow('research_retention_leased');
    expect(await local.env.EVIDENCE.head(sourceRevocationKey(c.source.source_id))).not.toBeNull();
    await expect(
      readResearchRun(local.env, c, run.run_id, options(c, researchTime)),
    ).rejects.toThrow();
    await purgeResearchRun(local.env, run.run_id, atDay(1), { time_travel_days: 7 });
    const shortened = renewal(single, 'restore-deleted-v2', atDay(1), await hash(stable(single)));
    shortened.retention.normalized_days = 1;
    shortened.source.policy.retention_limit_days = 31;
    await adoptReviewedResearchConfig(
      local.env,
      shortened,
      await hash(stable(single)),
      atDay(1),
      shortened.terms.version,
    );
    await reconcileResearchRun(
      local.env,
      shortened,
      singleRun.run_id,
      atDay(1),
      shortened.terms.version,
    );
    const restored = await localEnv();
    try {
      for (const { table, rows } of backup)
        for (const row of rows) {
          const columns = Object.keys(row);
          await restored.env.PRIVATE_DB.prepare(
            'INSERT INTO ' +
              table +
              '(' +
              columns.join(',') +
              ') VALUES (' +
              columns.map(() => '?').join(',') +
              ')',
          )
            .bind(...Object.values(row))
            .run();
        }
      const env = { ...restored.env, EVIDENCE: local.env.EVIDENCE };
      // This source itself was not revoked. The restored, older policy cannot resurrect one erased run.
      expect(await env.EVIDENCE.head(sourceRevocationKey(single.source.source_id))).toBeNull();
      await expect(
        readResearchRun(env, single, singleRun.run_id, options(single, atDay(2))),
      ).rejects.toThrow('research_run_deleted');
      expect(
        (await reconcileResearchRun(env, single, singleRun.run_id, atDay(2), single.terms.version))
          ?.remaining,
      ).toBe(0);
      await expect(readResearchRun(env, c, run.run_id, options(c, atDay(2)))).rejects.toThrow(
        'research_source_revoked',
      );
      await expect(
        collectResearchPage(env, c, eiaQuery, atDay(2), options(c, atDay(2), body)),
      ).rejects.toThrow('research_source_revoked');
      expect(
        (await reconcileResearchRun(env, c, run.run_id, atDay(2), c.terms.version))?.remaining,
      ).toBe(0);
      await purgeResearchEvidence(env, atDay(8));
      expect(
        await env.EVIDENCE.head(runDeletionKey(c.source.source_id, run.run_id)),
      ).not.toBeNull();
      expect((await env.PRIVATE_DB.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
    } finally {
      await restored.mf.dispose();
    }
  });

  it('suspends current reads but reports incomplete restore protection when the external revocation ledger fails', async () => {
    const c = longSource('ledger_failure');
    const run = await collectResearchPage(
      local.env,
      c,
      eiaQuery,
      researchTime,
      options(c, researchTime, body),
    );
    const failing = new Proxy(local.env.EVIDENCE, {
      get(target, key) {
        if (key === 'put')
          return async () => {
            throw new Error('synthetic_control_write_failure');
          };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await expect(
      revokeResearchSource({ ...local.env, EVIDENCE: failing }, c.source.source_id, researchTime),
    ).rejects.toThrow('synthetic_control_write_failure');
    expect(
      await local.env.PRIVATE_DB.prepare('SELECT suspended FROM research_sources WHERE source_id=?')
        .bind(c.source.source_id)
        .first(),
    ).toEqual({ suspended: 1 });
    await expect(
      readResearchRun(local.env, c, run.run_id, options(c, researchTime)),
    ).rejects.toThrow('research_policy_changed');
    expect(await local.env.EVIDENCE.head(sourceRevocationKey(c.source.source_id))).toBeNull();
    // Retrying persists restore protection and does not resume the suspended source.
    await revokeResearchSource(local.env, c.source.source_id, researchTime);
    expect(await local.env.EVIDENCE.head(sourceRevocationKey(c.source.source_id))).not.toBeNull();
    // Failure is visible and must hold the release/restore gate closed; it is not a successful revocation.
  });

  it('keeps legacy 0007 expiry unchanged and requires review instead of assigning a five-year grant during migration', async () => {
    const legacy = await localEnv('test', undefined, 7);
    try {
      const c = longSource('legacy'),
        digest = await hash(stable(c)),
        runId = await hash('synthetic-legacy-run');
      await legacy.env.PRIVATE_DB.prepare(
        'INSERT INTO research_sources(source_id,policy_version,config_hash) VALUES (?,?,?)',
      )
        .bind(c.source.source_id, c.source.policy.version, digest)
        .run();
      await legacy.env.PRIVATE_DB.prepare(
        "INSERT INTO research_runs(run_id,source_id,config_hash,query_hash,policy_version,terms_version,scheduled_for,recorded_at,synthetic,state,evidence_expires_at,normalized_expires_at) VALUES (?,?,?,?,?,?,?,?,1,'complete',?,?)",
      )
        .bind(
          runId,
          c.source.source_id,
          digest,
          'synthetic-query',
          c.source.policy.version,
          c.terms.version,
          researchTime,
          researchTime,
          atDay(7),
          atDay(90),
        )
        .run();
      await applyMigrations(legacy.env.PRIVATE_DB, 'private');
      expect(
        await legacy.env.PRIVATE_DB.prepare(
          'SELECT normalized_expires_at,retention_snapshot_json,all_copies_expires_at FROM research_runs WHERE run_id=?',
        )
          .bind(runId)
          .first(),
      ).toEqual({
        normalized_expires_at: atDay(90),
        retention_snapshot_json: null,
        all_copies_expires_at: null,
      });
      await expect(readResearchRun(legacy.env, c, runId, options(c, atDay(1)))).rejects.toThrow(
        'historical_retention_unreviewed',
      );
      await expect(
        revokeResearchSource(
          { ...legacy.env, ENVIRONMENT: 'production' },
          c.source.source_id,
          researchTime,
        ),
      ).rejects.toThrow('research_production_not_integrated');
    } finally {
      await legacy.mf.dispose();
    }
  });
});
