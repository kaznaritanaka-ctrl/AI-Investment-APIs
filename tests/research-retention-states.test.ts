import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { localEnv } from '../scripts/local-env';
import { applyMigrations } from '../scripts/migrations';
import { hash, stable } from '../src/util';
import { assertResearchAllowed, type ResearchConfig } from '../src/research/schema';
import {
  collectResearchPage,
  purgeResearchRun,
  readResearchRun,
  reconcileResearchRun,
} from '../src/research/pipeline';
import {
  adoptReviewedResearchConfig,
  plusDays,
  requestResearchDeletion,
  retentionSnapshot,
  runDeletionKey,
} from '../src/research/retention';
import { eiaQuery, researchFixture, researchSource, researchTime } from './research-helpers';

const at = (days: number) => plusDays(researchTime, days);
const body = researchFixture('eia.synthetic.json');
const options = (c: ResearchConfig, day: number) => ({
  now: () => at(day),
  current_terms_version: c.terms.version,
  synthetic_text: body,
});
function ongoing(id: string) {
  const c = researchSource();
  c.source.source_id = 'synthetic_state_' + id;
  c.source.policy.version = id + '-v1';
  c.source.policy.valid_until = null;
  c.source.policy.retention_limit_days = null;
  c.terms.review_after = '2039-01-01T00:00:00.000Z';
  c.retention.normalized_mode = 'until_revoked';
  c.retention.normalized_days = null;
  c.retention.ongoing_storage = {
    basis_ref: 'synthetic-explicit-continuing-storage-grant',
    owner_approval_ref: 'synthetic-owner-ongoing-review',
  };
  c.retention.storage_review_hold!.all_copies_delete_by = '2039-01-01T00:00:00.000Z';
  return c;
}
async function nextPolicy(c: ResearchConfig) {
  const next = structuredClone(c);
  next.source.policy.version += '-reviewed';
  next.history_access = [
    { config_hash: await hash(stable(c)), approval_ref: 'synthetic-history-review' },
  ];
  return next;
}
async function copyRows(db: D1Database, table: string, rows: Record<string, unknown>[]) {
  for (const row of rows) {
    const columns = Object.keys(row);
    await db
      .prepare(
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
}

describe('research retention states and explicit continuing storage (synthetic only)', () => {
  let local: Awaited<ReturnType<typeof localEnv>>;
  beforeAll(async () => {
    local = await localEnv();
  });
  afterAll(async () => {
    await local?.mf.dispose();
  });

  it('rejects ambiguous null, missing continuing-storage approval and unbounded uncertainty before HTTP/storage', async () => {
    const valid = ongoing('gates');
    const cases = [
      { ...valid.retention, normalized_mode: 'unapproved' as const },
      { ...valid.retention, normalized_mode: 'fixed_days' as const },
      { ...valid.retention, ongoing_storage: null },
      { ...valid.retention, ongoing_storage: { basis_ref: ' ', owner_approval_ref: 'synthetic' } },
      { ...valid.retention, storage_review_hold: null },
      {
        ...valid.retention,
        storage_review_hold: {
          ...valid.retention.storage_review_hold!,
          all_copies_delete_by: at(30),
        },
      },
    ];
    const fetcher = vi.fn();
    for (const retention of cases)
      await expect(
        collectResearchPage(local.env, { ...valid, retention }, eiaQuery, researchTime, {
          ...options(valid, 0),
          fetcher,
          allow_network: true,
        }),
      ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    expect(
      await local.env.PRIVATE_DB.prepare('SELECT COUNT(*) n FROM research_runs').first(),
    ).toEqual({ n: 0 });
    expect((await local.env.EVIDENCE.list()).objects).toHaveLength(0);
    expect(() => assertResearchAllowed(valid, researchTime, valid.terms.version)).not.toThrow();
    valid.source.policy.valid_until = at(100);
    expect(() => assertResearchAllowed(valid, researchTime, valid.terms.version)).toThrow(
      'retention_review_required',
    );
  });

  it('retains explicitly approved history beyond five/ten years, independently deletes evidence and preserves lineage', async () => {
    const c = ongoing('long');
    const run = await collectResearchPage(local.env, c, eiaQuery, at(0), options(c, 0));
    const saved = await local.env.PRIVATE_DB.prepare(
      'SELECT normalized_mode,normalized_expires_at,all_copies_expires_at FROM research_runs WHERE run_id=?',
    )
      .bind(run.run_id)
      .first();
    expect(saved).toEqual({
      normalized_mode: 'until_revoked',
      normalized_expires_at: null,
      all_copies_expires_at: null,
    });
    for (const day of [1826, 3651]) {
      expect(
        (await readResearchRun(local.env, c, run.run_id, options(c, day))).results,
      ).toHaveLength(2);
      expect(
        (await reconcileResearchRun(local.env, c, run.run_id, at(day), c.terms.version))?.decision,
      ).toMatchObject({ state: 'active', normalized_deadline: null, storage: 'allowed' });
    }
    expect(
      await local.env.EVIDENCE.get('research/' + c.source.source_id + '/' + run.run_id + '/0.json'),
    ).toBeNull();
    expect(await local.env.EVIDENCE.get(runDeletionKey(c.source.source_id, run.run_id))).toBeNull();
    const audit = await local.env.PRIVATE_DB.prepare(
      'SELECT decision_json FROM research_retention_assessments WHERE run_id=? ORDER BY assessed_at DESC LIMIT 1',
    )
      .bind(run.run_id)
      .first<{ decision_json: string }>();
    expect(JSON.parse(audit!.decision_json)).toMatchObject({
      evidence_status: 'deleted',
      revalidation: 'unavailable',
    });
    const next = await collectResearchPage(local.env, c, eiaQuery, at(3651), options(c, 3651));
    expect(
      (await readResearchRun(local.env, c, next.run_id, options(c, 3651))).results[0],
    ).toMatchObject({ change_kind: 'reobserved' });
    await expect(
      purgeResearchRun(local.env, run.run_id, at(3651), { time_travel_days: 7 }),
    ).rejects.toThrow('research_retention_not_due');
  });

  it.each(['denied', 'expired'] as const)(
    'deletes when storage right is explicitly %s, with a durable deadline',
    async (right) => {
      const c = ongoing('storage_' + right);
      const run = await collectResearchPage(local.env, c, eiaQuery, at(0), options(c, 0));
      const next = await nextPolicy(c);
      next.source.enabled = false;
      next.source.policy.rights.private_storage = right;
      await adoptReviewedResearchConfig(
        local.env,
        next,
        await hash(stable(c)),
        at(1),
        next.terms.version,
      );
      await expect(readResearchRun(local.env, next, run.run_id, options(next, 1))).rejects.toThrow(
        'policy_blocked',
      );
      expect(
        await reconcileResearchRun(local.env, next, run.run_id, at(1), next.terms.version),
      ).toMatchObject({
        remaining: 0,
        backup_deadline_missed: false,
        decision: {
          state: 'delete_required',
          storage: 'prohibited',
          reasons: ['storage_right_ended'],
        },
      });
      const marker = await local.env.EVIDENCE.get(runDeletionKey(c.source.source_id, run.run_id));
      expect(await marker!.json()).toMatchObject({
        reason: 'storage_right_ended',
        all_copies_delete_by: at(31),
      });
    },
  );

  it('keeps analysis uncertainty separate from authorized storage and stopped collection', async () => {
    const c = ongoing('analysis');
    const run = await collectResearchPage(local.env, c, eiaQuery, at(0), options(c, 0));
    const next = await nextPolicy(c);
    next.source.enabled = false;
    next.source.policy.rights.internal_analysis = 'review_required';
    await adoptReviewedResearchConfig(
      local.env,
      next,
      await hash(stable(c)),
      at(1),
      next.terms.version,
    );
    expect(
      (await reconcileResearchRun(local.env, next, run.run_id, at(1), next.terms.version))
        ?.decision,
    ).toMatchObject({
      state: 'rights_unknown',
      storage: 'allowed',
      read_allowed: false,
      collection_allowed: false,
      next_action: 'review_rights',
    });
    await expect(readResearchRun(local.env, next, run.run_id, options(next, 1))).rejects.toThrow(
      'policy_blocked',
    );
    expect(await local.env.EVIDENCE.get(runDeletionKey(c.source.source_id, run.run_id))).toBeNull();
    expect(
      await local.env.PRIVATE_DB.prepare(
        'SELECT COUNT(*) n FROM research_observations WHERE run_id=?',
      )
        .bind(run.run_id)
        .first(),
    ).toEqual({ n: 2 });
  });

  it('uses only the preapproved finite storage-only hold when terms change, then honors its all-copy deadline', async () => {
    const c = ongoing('unknown');
    c.retention.storage_review_hold!.all_copies_delete_by = at(60);
    const run = await collectResearchPage(local.env, c, eiaQuery, at(0), options(c, 0));
    const changedTerms = 'synthetic-unreviewed-new-terms';
    const fetcher = vi.fn();
    await expect(
      collectResearchPage(local.env, c, eiaQuery, at(1), {
        ...options(c, 1),
        current_terms_version: changedTerms,
        fetcher,
      }),
    ).rejects.toThrow('terms_review_required');
    expect(fetcher).not.toHaveBeenCalled();
    await expect(
      readResearchRun(local.env, c, run.run_id, {
        ...options(c, 1),
        current_terms_version: changedTerms,
      }),
    ).rejects.toThrow('terms_review_required');
    expect(
      (await reconcileResearchRun(local.env, c, run.run_id, at(1), changedTerms))?.decision,
    ).toMatchObject({
      state: 'rights_unknown',
      storage: 'review_hold',
      review_deadline: at(30),
      all_copies_deadline: at(60),
      next_action: 'review_rights',
    });
    expect(await local.env.EVIDENCE.get(runDeletionKey(c.source.source_id, run.run_id))).toBeNull();
    const result = await reconcileResearchRun(local.env, c, run.run_id, at(30), changedTerms);
    expect(result).toMatchObject({
      remaining: 0,
      backup_residual_until: at(37),
      backup_deadline_missed: false,
      decision: {
        state: 'delete_required',
        reasons: expect.arrayContaining(['approved_storage_review_hold_ended']),
      },
    });
    expect(
      await (await local.env.EVIDENCE.get(runDeletionKey(c.source.source_id, run.run_id)))!.json(),
    ).toMatchObject({ reason: 'storage_review_hold_ended', all_copies_delete_by: at(60) });
  });

  it('does not turn an expired uncertainty hold into deletion when continuing storage remains authorized and only review is due', async () => {
    const c = ongoing('review_only');
    c.retention.storage_review_hold!.all_copies_delete_by = at(60);
    c.terms.review_after = at(20);
    const run = await collectResearchPage(local.env, c, eiaQuery, at(0), options(c, 0));
    expect(
      (await reconcileResearchRun(local.env, c, run.run_id, at(100), c.terms.version))?.decision,
    ).toMatchObject({
      state: 'review_due',
      storage: 'allowed',
      normalized_deadline: null,
      next_action: 'review_terms',
    });
    expect(await local.env.EVIDENCE.get(runDeletionKey(c.source.source_id, run.run_id))).toBeNull();
  });

  it('preserves a captured fixed storage-right end even if a later policy approves until_revoked', async () => {
    const c = ongoing('fixed');
    c.retention.normalized_mode = 'fixed_days';
    c.retention.normalized_days = 90;
    c.source.policy.valid_until = at(40);
    const run = await collectResearchPage(local.env, c, eiaQuery, at(0), options(c, 0));
    const next = await nextPolicy(c);
    next.retention.normalized_mode = 'until_revoked';
    next.retention.normalized_days = null;
    next.source.policy.valid_until = null;
    await adoptReviewedResearchConfig(
      local.env,
      next,
      await hash(stable(c)),
      at(1),
      next.terms.version,
    );
    expect(
      (await readResearchRun(local.env, next, run.run_id, options(next, 39))).results,
    ).toHaveLength(2);
    expect(
      (await readResearchRun(local.env, next, run.run_id, options(next, 40))).results,
    ).toHaveLength(0);
    expect(
      await local.env.PRIVATE_DB.prepare(
        'SELECT normalized_mode,normalized_expires_at FROM research_runs WHERE run_id=?',
      )
        .bind(run.run_id)
        .first(),
    ).toEqual({ normalized_mode: 'fixed_days', normalized_expires_at: at(90) });
    expect(
      (await reconcileResearchRun(local.env, next, run.run_id, at(40), next.terms.version))
        ?.decision,
    ).toMatchObject({
      state: 'delete_required',
      reasons: ['captured_storage_grant_ended'],
      all_copies_deadline: at(70),
    });
  });

  it('enforces an explicit delete request after D1 restore and reports an impossible backup deadline', async () => {
    const c = ongoing('delete_request');
    const run = await collectResearchPage(local.env, c, eiaQuery, at(0), options(c, 0));
    const restored = await localEnv();
    try {
      for (const table of [
        'research_sources',
        'research_config_versions',
        'research_runs',
        'research_pages',
        'research_observations',
      ]) {
        const key =
          table === 'research_sources' || table === 'research_config_versions'
            ? 'source_id'
            : 'run_id';
        const rows = (
          await local.env.PRIVATE_DB.prepare('SELECT * FROM ' + table + ' WHERE ' + key + '=?')
            .bind(key === 'source_id' ? c.source.source_id : run.run_id)
            .all()
        ).results;
        await copyRows(restored.env.PRIVATE_DB, table, rows);
      }
      await requestResearchDeletion(local.env, run.run_id, at(1), {
        basis_ref: 'synthetic-applicable-owner-deletion-request',
        all_copies_delete_by: at(4),
      });
      await requestResearchDeletion(local.env, run.run_id, at(1), {
        basis_ref: 'synthetic-shorter-obligation',
        all_copies_delete_by: at(3),
      });
      await requestResearchDeletion(local.env, run.run_id, at(1), {
        basis_ref: 'synthetic-cannot-extend',
        all_copies_delete_by: at(5),
      });
      expect(
        await (await local.env.EVIDENCE.get(
          runDeletionKey(c.source.source_id, run.run_id),
        ))!.json(),
      ).toMatchObject({
        deleted_from: at(1),
        all_copies_delete_by: at(3),
        basis_refs: expect.arrayContaining(['synthetic-shorter-obligation']),
      });
      await expect(readResearchRun(local.env, c, run.run_id, options(c, 1))).rejects.toThrow(
        'research_run_deleted',
      );
      expect(
        await reconcileResearchRun(local.env, c, run.run_id, at(1), c.terms.version),
      ).toMatchObject({ remaining: 0, backup_residual_until: at(8), backup_deadline_missed: true });
      const env = { ...restored.env, EVIDENCE: local.env.EVIDENCE };
      await expect(readResearchRun(env, c, run.run_id, options(c, 2))).rejects.toThrow(
        'research_run_deleted',
      );
      expect(await reconcileResearchRun(env, c, run.run_id, at(2), c.terms.version)).toMatchObject({
        remaining: 0,
        backup_residual_until: at(9),
        backup_deadline_missed: true,
        decision: { state: 'delete_required' },
      });
    } finally {
      await restored.mf.dispose();
    }
  });

  it('migrates populated 0008 without changing any stored deadlines, observations or foreign keys', async () => {
    const c = ongoing('migration');
    c.retention.normalized_mode = 'fixed_days';
    c.retention.normalized_days = 90;
    const run = await collectResearchPage(local.env, c, eiaQuery, at(0), options(c, 0));
    const old = await localEnv('test', undefined, 8);
    try {
      let originalRun: Record<string, unknown> = {};
      for (const table of [
        'research_sources',
        'research_config_versions',
        'research_runs',
        'research_pages',
        'research_observations',
      ]) {
        const key =
          table === 'research_sources' || table === 'research_config_versions'
            ? 'source_id'
            : 'run_id';
        const rows = (
          await local.env.PRIVATE_DB.prepare('SELECT * FROM ' + table + ' WHERE ' + key + '=?')
            .bind(key === 'source_id' ? c.source.source_id : run.run_id)
            .all()
        ).results;
        if (table === 'research_runs') {
          const snapshot = retentionSnapshot(c);
          const {
            normalized_mode: _mode,
            ongoing_storage: _storage,
            storage_review_hold: _hold,
            storage_valid_until: _valid,
            ...legacy
          } = snapshot;
          delete rows[0].normalized_mode;
          rows[0].retention_snapshot_json = stable({ ...legacy, version: 'research-retention-v1' });
          originalRun = structuredClone(rows[0]);
        }
        await copyRows(old.env.PRIVATE_DB, table, rows);
      }
      await applyMigrations(old.env.PRIVATE_DB, 'private');
      await applyMigrations(old.env.PRIVATE_DB, 'private');
      expect(
        await old.env.PRIVATE_DB.prepare('SELECT * FROM research_runs WHERE run_id=?')
          .bind(run.run_id)
          .first(),
      ).toEqual({ ...originalRun, normalized_mode: 'fixed_days' });
      expect((await readResearchRun(old.env, c, run.run_id, options(c, 1))).results).toHaveLength(
        2,
      );
      expect((await old.env.PRIVATE_DB.prepare('PRAGMA foreign_key_check').all()).results).toEqual(
        [],
      );
      const invalid = {
        ...originalRun,
        run_id: await hash('synthetic-invalid-null-deadline'),
        scheduled_for: at(2),
        normalized_mode: 'until_revoked',
        normalized_expires_at: null,
        all_copies_expires_at: null,
        retention_snapshot_json: '{}',
      };
      await expect(copyRows(old.env.PRIVATE_DB, 'research_runs', [invalid])).rejects.toThrow(
        'CHECK constraint failed',
      );
      await expect(
        old.env.PRIVATE_DB.prepare('UPDATE research_runs SET normalized_mode=? WHERE run_id=?')
          .bind('until_revoked', run.run_id)
          .run(),
      ).rejects.toThrow('immutable_research_retention');
      await expect(
        old.env.PRIVATE_DB.prepare("UPDATE research_observations SET record_key='changed'").run(),
      ).rejects.toThrow('immutable_research_observation');
      await expect(
        old.env.PRIVATE_DB.prepare('DELETE FROM research_observations').run(),
      ).rejects.toThrow('research_retention_required');
    } finally {
      await old.mf.dispose();
    }
  });
});
