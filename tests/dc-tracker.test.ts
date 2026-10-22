import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { localEnv } from '../scripts/local-env';
import { applyMigrations } from '../scripts/migrations';
import {
  collectResearchPage,
  purgeResearchRun,
  reconcileResearchRun,
} from '../src/research/pipeline';
import { requestResearchDeletion, runDeletionKey, plusDays } from '../src/research/retention';
import { DCTrackerRecordSchema, parseDCTracker } from '../src/research/dc-tracker-schema';
import {
  createDCReviewBatch,
  recordDCReview,
  readDCTracker,
  dcMorningBrief,
  dcReviewWeek,
  dcWeeklyReviewDue,
  dcAICandidates,
} from '../src/research/dc-tracker';
import { assertResearchAllowed, ResearchConfigSchema } from '../src/research/schema';
import { handle } from '../src/api';
import { dcConfig, dcOpt, dcPage, dcRecord, dcTime } from './dc-tracker-helpers';
import proposal from '../config/proposals/research/meti_dc_tracker.json';
const query = { kind: 'dc_tracker' } as const;

describe('private DC tracker, synthetic evidence only', () => {
  let local: Awaited<ReturnType<typeof localEnv>>;
  beforeAll(async () => {
    local = await localEnv('test', undefined, 15);
    await local.env.PRIVATE_DB.prepare(
      "INSERT INTO collection_runs(run_id,source_id,scheduled_for,state) VALUES ('dc-legacy','ecb','2026-10-21T01:00:00.000Z','complete')",
    ).run();
    await local.env.PRIVATE_DB.prepare(
      "INSERT INTO observations(observation_id,source_id,policy_version,run_id,dataset,entity_key,observed_at,recorded_at,fingerprint,parser_version,quality_status,metadata_json) VALUES ('dc-legacy-observation','ecb','legacy','dc-legacy','fx','synthetic-fx','2026-10-21T01:00:00.000Z','2026-10-21T01:00:00.000Z','synthetic-hash','synthetic-parser','accepted','{}')",
    ).run();
    await applyMigrations(local.env.PRIVATE_DB, 'private');
  });
  afterAll(async () => {
    await local?.mf.dispose();
  });
  const collect = async (
    at = dcTime,
    records?: Awaited<ReturnType<typeof dcRecord>>[],
    c = dcConfig(),
  ) =>
    collectResearchPage(local.env, c, query, at, {
      ...dcOpt(at, c),
      synthetic_text: dcPage(records ?? [await dcRecord(at)]),
    });
  it('uses only free migration 0016, preserves populated DB and immutable legacy rows; no public tables', async () => {
    expect(readdirSync('migrations/private').filter((f) => f.startsWith('0016'))).toEqual([
      '0016_dc_tracker.sql',
    ]);
    expect(
      await local.env.PRIVATE_DB.prepare(
        "SELECT state FROM collection_runs WHERE run_id='dc-legacy'",
      ).first(),
    ).toEqual({ state: 'complete' });
    expect(
      await local.env.PRIVATE_DB.prepare(
        "SELECT fingerprint FROM observations WHERE observation_id='dc-legacy-observation'",
      ).first(),
    ).toEqual({ fingerprint: 'synthetic-hash' });
    await expect(
      local.env.PRIVATE_DB.prepare(
        "UPDATE observations SET fingerprint='changed' WHERE observation_id='dc-legacy-observation'",
      ).run(),
    ).rejects.toThrow();
    expect((await local.env.PRIVATE_DB.prepare('PRAGMA foreign_key_check').all()).results).toEqual(
      [],
    );
    expect(
      (
        await local.env.PUBLIC_DB.prepare(
          "SELECT name FROM sqlite_master WHERE name LIKE 'dc_%'",
        ).all()
      ).results,
    ).toEqual([]);
    await applyMigrations(local.env.PRIVATE_DB, 'private');
  });
  it('keeps proposal disabled, every right under review and blocks before registration/storage/network', async () => {
    const p = ResearchConfigSchema.parse(proposal);
    expect(p.source.enabled).toBe(false);
    expect(new Set(Object.values(p.source.policy.rights))).toEqual(new Set(['review_required']));
    expect(p.retention.normalized_mode).toBe('unapproved');
    const fetcher = vi.fn();
    await expect(
      collectResearchPage(local.env, p, query, dcTime, {
        ...dcOpt(),
        fetcher,
        synthetic_text: dcPage([await dcRecord()]),
      }),
    ).rejects.toThrow('policy_blocked');
    for (const k of ['automated_collection', 'private_storage', 'internal_analysis'] as const) {
      const c = dcConfig();
      c.source.policy.rights[k] = 'review_required';
      expect(() => assertResearchAllowed(c, dcTime, c.terms.version)).toThrow('policy_blocked');
    }
    const c = dcConfig();
    c.owner_approval_ref = null;
    expect(() => assertResearchAllowed(c, dcTime, c.terms.version)).toThrow(
      'research_review_required',
    );
    c.owner_approval_ref = 'synthetic';
    c.retention.normalized_mode = 'unapproved';
    expect(() => assertResearchAllowed(c, dcTime, c.terms.version)).toThrow(
      'retention_review_required',
    );
    await expect(
      collectResearchPage(local.env, dcConfig(), query, dcTime, {
        ...dcOpt(),
        allow_network: true,
        fetcher,
      }),
    ).rejects.toThrow('dc_tracker_live_transport_not_integrated');
    expect(fetcher).not.toHaveBeenCalled();
    expect(
      await local.env.PRIVATE_DB.prepare('SELECT COUNT(*) n FROM research_sources').first(),
    ).toEqual({ n: 0 });
    expect((await local.env.EVIDENCE.list()).objects).toHaveLength(0);
  });
  it('appends scheduled-date revisions with stable keys and preserves original draft rows', async () => {
    const first = await collect();
    const same = await collect();
    expect(same).toEqual(first);
    const at = '2026-10-23T01:00:00.000Z',
      r = await dcRecord(at);
    r.value_text = '2029-01-01';
    r.phase!.planned_service_date = r.value_text;
    r.change = {
      kind: 'delay',
      reason_code: 'unknown',
      reason_quote: null,
      operator_stated: false,
    };
    const next = await collect(at, [r]);
    const a = await readDCTracker(local.env, dcConfig(), first.run_id, dcOpt(at)),
      b = await readDCTracker(local.env, dcConfig(), next.run_id, dcOpt(at));
    expect(a[0].record.value_text).toBe('2028-01-01');
    expect(b[0].record.value_text).toBe('2029-01-01');
    expect(a[0].record.record_key).toBe(b[0].record.record_key);
    expect(a[0].obs_id).not.toBe(b[0].obs_id);
    expect(
      await local.env.PRIVATE_DB.prepare(
        'SELECT previous_observation_id,change_kind FROM research_observations WHERE observation_id=?',
      )
        .bind(b[0].obs_id)
        .first(),
    ).toEqual({ previous_observation_id: a[0].obs_id, change_kind: 'revised' });
    expect(
      await local.env.PRIVATE_DB.prepare('SELECT reason_code FROM dc_change_events').first(),
    ).toEqual({ reason_code: 'unknown' });
    for (const table of [
      'dc_observations',
      'dc_projects',
      'dc_sites',
      'dc_phases',
      'dc_entities',
      'dc_change_events',
    ]) {
      const column =
        table === 'dc_observations'
          ? 'status'
          : table === 'dc_projects'
            ? 'name_ja'
            : table === 'dc_entities'
              ? 'name_ja'
              : table === 'dc_sites'
                ? 'name'
                : table === 'dc_phases'
                  ? 'phase_label'
                  : 'reason_code';
      await expect(
        local.env.PRIVATE_DB.prepare(`UPDATE ${table} SET ${column}=${column}`).run(),
      ).rejects.toThrow('immutable_dc_record');
      await expect(local.env.PRIVATE_DB.prepare(`DELETE FROM ${table}`).run()).rejects.toThrow(
        'research_retention_required',
      );
    }
    const brief = await dcMorningBrief(local.env, dcConfig(), [next.run_id], dcOpt(at));
    expect(brief.unapproved_count).toBe(1);
    expect(brief.lines[0]).toContain('未承認');
    expect(
      (await dcAICandidates(local.env, dcConfig(), next.run_id, dcOpt(at)))[0],
    ).not.toHaveProperty('source_quote');
    await expect(
      collectResearchPage(
        { ...local.env, ENVIRONMENT: 'production', PRIVATE_GPU_RESEARCH_ENABLED: 'true' },
        dcConfig(),
        query,
        at,
        { ...dcOpt(at), synthetic_text: dcPage([r]) },
      ),
    ).rejects.toThrow('research_production_not_integrated');
  });
  it('keeps partial/empty snapshots hidden, rejects fabricated completeness, cross-page duplicates and repeated daily runs', async () => {
    const originalLocal = local;
    local = await localEnv();
    try {
      const c = dcConfig();
      c.limits.page_size = 1;
      const at = '2026-10-24T01:00:00.000Z',
        r = await dcRecord(at),
        r2 = await dcRecord(at, 'planned_mw');
      const opt = { ...dcOpt(at, c), synthetic_text: dcPage([r], 0, 2, 1, 'partial') };
      const first = await collectResearchPage(local.env, c, query, at, opt);
      expect(first.state).toBe('partial');
      expect(await readDCTracker(local.env, c, first.run_id, dcOpt(at, c))).toEqual([]);
      await expect(
        collectResearchPage(local.env, c, query, at, { ...opt, synthetic_text: dcPage([r], 1, 2) }),
      ).rejects.toThrow('research_duplicate_record');
      // Failed page evidence is fixed: a replay cannot silently swap it for another payload.
      await expect(
        collectResearchPage(local.env, c, query, at, {
          ...opt,
          synthetic_text: dcPage([r2], 1, 2),
        }),
      ).rejects.toThrow('research_duplicate_record');
      const next = '2026-10-25T01:00:00.000Z';
      const fresh = await collectResearchPage(local.env, c, query, next, {
        ...dcOpt(next, c),
        synthetic_text: dcPage([r], 0, 2, 1, 'partial'),
      });
      await collectResearchPage(local.env, c, query, next, {
        ...dcOpt(next, c),
        synthetic_text: dcPage([r2], 1, 2),
      });
      expect(await readDCTracker(local.env, c, fresh.run_id, dcOpt(next, c))).toHaveLength(2);
      await expect(
        collectResearchPage(local.env, c, query, '2026-10-25T02:00:00.000Z', {
          ...dcOpt('2026-10-25T02:00:00.000Z', c),
          synthetic_text: dcPage([r]),
        }),
      ).rejects.toThrow('research_scope_changed_or_daily_limit');
      await expect(parseDCTracker(c, dcPage([r], 0, 2, null, 'complete'), 0)).rejects.toThrow(
        'dc_tracker_coverage_mismatch',
      );
      const empty = '2026-10-26T01:00:00.000Z';
      const e = await collectResearchPage(local.env, c, query, empty, {
        ...dcOpt(empty, c),
        synthetic_text: dcPage([], 0, 0, null, 'partial'),
      });
      expect(e.state).toBe('partial');
    } finally {
      await local.mf.dispose();
      local = originalLocal;
    }
  });
  it('expands batch-scoped all OK, requires individual cancellation/downsize decisions, keeps hold and absent replies draft', async () => {
    const at = '2026-10-27T01:00:00.000Z',
      r = await dcRecord(at),
      cancel = await dcRecord(at, 'status'),
      finance = await dcRecord(at, 'financing');
    cancel.change = {
      kind: 'cancel',
      reason_code: 'power',
      reason_quote: '合成：電力接続の都合で中止します。',
      operator_stated: true,
    };
    finance.financing = {
      project_id: null,
      entity_id: 'synthetic-operator',
      instrument: 'bond',
      amount_decimal: '100.00',
      currency: 'JPY',
      maturity: null,
      collateral_text: null,
      admin_event_id: null,
      disclosed_vs_inferred: 'disclosed',
    };
    const run = await collect(at, [r, cancel, finance]);
    const opt = dcOpt(at),
      c = dcConfig();
    const batch = await createDCReviewBatch(local.env, c, [run.run_id], opt);
    expect(batch.items).toHaveLength(3);
    expect(await dcMorningBrief(local.env, c, [run.run_id], opt)).toMatchObject({
      unapproved_count: 3,
    });
    const decision = await recordDCReview(local.env, c, batch.batch_id, { kind: 'all_ok' }, opt);
    expect(decision).toMatchObject({ recorded: 2, individual_pending: 1 });
    expect(
      await recordDCReview(local.env, c, batch.batch_id, { kind: 'all_ok' }, opt),
    ).toMatchObject({ recorded: 0 });
    const individual = batch.items.find((i) => i.individual_required)!;
    await recordDCReview(
      local.env,
      c,
      batch.batch_id,
      { kind: 'items', decisions: [{ item_number: individual.item_number, decision: 'hold' }] },
      opt,
    );
    const brief = await dcMorningBrief(local.env, c, [run.run_id], opt);
    expect(brief).toMatchObject({ unapproved_count: 1, approved_count: 2 });
    expect(brief.lines[0]).toContain('保留');
    const held = await createDCReviewBatch(local.env, c, [run.run_id], opt);
    await recordDCReview(
      local.env,
      c,
      held.batch_id,
      { kind: 'items', decisions: [{ item_number: 1, decision: 'rejected' }] },
      opt,
    );
    expect(await readDCTracker(local.env, c, run.run_id, opt)).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: 'rejected' })]),
    );
    expect(
      await local.env.PRIVATE_DB.prepare(
        "SELECT COUNT(*) n FROM dc_observations WHERE status='draft' AND run_id=?",
      )
        .bind(run.run_id)
        .first(),
    ).toEqual({ n: 3 });
    await expect(
      local.env.PRIVATE_DB.prepare('UPDATE dc_observation_reviews SET decision=decision').run(),
    ).rejects.toThrow('immutable_dc_review');
    await expect(
      local.env.PRIVATE_DB.prepare('DELETE FROM dc_observation_reviews').run(),
    ).rejects.toThrow('research_retention_required');
    await expect(
      local.env.PRIVATE_DB.prepare(
        'UPDATE dc_financing_events SET amount_decimal=amount_decimal',
      ).run(),
    ).rejects.toThrow('immutable_dc_record');
  });
  it('uses UTC week boundaries without scheduling or public routes', async () => {
    expect(dcReviewWeek('2026-10-25T15:00:00.000Z')).toBe('2026-10-19'); // Monday JST is still Sunday UTC.
    expect(dcWeeklyReviewDue('2026-10-26T00:00:00.000Z', '2026-10-25T23:59:59.000Z')).toBe(true);
    expect(dcWeeklyReviewDue('2026-10-26T10:00:00.000Z', '2026-10-26T00:00:00.000Z')).toBe(false);
    expect(() => dcWeeklyReviewDue('invalid', null)).toThrow();
    for (const path of ['/v1/dc-tracker', '/v1/dc-projects', '/v1/latest?dataset=dc_tracker'])
      expect(
        (
          await handle(
            new Request('https://local.test' + path),
            { PUBLIC_DB: local.env.PUBLIC_DB },
            dcTime,
          )
        ).status,
      ).not.toBe(200);
    expect(readFileSync('wrangler.api.jsonc', 'utf8')).not.toMatch(/PRIVATE_DB|EVIDENCE/);
  });
  it('reuses current rights, review_due stops reads without deletion, and purges scopes/events/reviews with preserved control markers', async () => {
    const c = dcConfig(),
      at = '2026-10-28T01:00:00.000Z';
    const r = await dcRecord(at, 'status');
    r.change = {
      kind: 'downsize',
      reason_code: 'unknown',
      reason_quote: null,
      operator_stated: false,
    };
    const f = await dcRecord(at, 'financing');
    f.financing = {
      project_id: f.project.project_id,
      entity_id: null,
      instrument: 'lease',
      amount_decimal: null,
      currency: null,
      maturity: null,
      collateral_text: null,
      admin_event_id: null,
      disclosed_vs_inferred: 'disclosed',
    };
    const run = await collect(at, [r, f]),
      opt = dcOpt(at, c);
    const batch = await createDCReviewBatch(local.env, c, [run.run_id], opt);
    await recordDCReview(local.env, c, batch.batch_id, { kind: 'all_ok' }, opt);
    const due = '2026-11-23T01:00:00.000Z';
    await expect(readDCTracker(local.env, c, run.run_id, dcOpt(due, c))).rejects.toThrow(
      'terms_review_required',
    );
    const assessed = await reconcileResearchRun(local.env, c, run.run_id, due, c.terms.version);
    expect(assessed?.decision.state).toBe('review_due');
    expect(
      await local.env.PRIVATE_DB.prepare('SELECT COUNT(*) n FROM dc_observations WHERE run_id=?')
        .bind(run.run_id)
        .first(),
    ).toEqual({ n: 2 });
    await requestResearchDeletion(local.env, run.run_id, at, {
      basis_ref: 'synthetic-deletion',
      all_copies_delete_by: plusDays(at, 30),
    });
    await expect(readDCTracker(local.env, c, run.run_id, opt)).rejects.toThrow();
    await purgeResearchRun(local.env, run.run_id, at, { time_travel_days: 7 });
    for (const table of [
      'dc_entities',
      'dc_projects',
      'dc_sites',
      'dc_phases',
      'dc_observations',
      'dc_change_events',
      'dc_financing_events',
      'dc_review_batch_items',
      'dc_observation_reviews',
    ])
      expect(
        await local.env.PRIVATE_DB.prepare(`SELECT COUNT(*) n FROM ${table} WHERE run_id=?`)
          .bind(run.run_id)
          .first(),
      ).toEqual({ n: 0 });
    expect(
      await local.env.EVIDENCE.head(runDeletionKey(c.source.source_id, run.run_id)),
    ).not.toBeNull();
    await expect(
      recordDCReview(local.env, c, batch.batch_id, { kind: 'all_ok' }, opt),
    ).rejects.toThrow('dc_review_batch_incomplete');
    const deleted = await local.env.PRIVATE_DB.prepare(
      'SELECT deleted_at,backup_residual_until FROM research_runs WHERE run_id=?',
    )
      .bind(run.run_id)
      .first();
    await local.env.EVIDENCE.put(
      `research/${c.source.source_id}/${run.run_id}/0.json`,
      'synthetic-restored',
    );
    await purgeResearchRun(local.env, run.run_id, plusDays(at, 1), { time_travel_days: 7 });
    expect(
      await local.env.PRIVATE_DB.prepare(
        'SELECT deleted_at,backup_residual_until FROM research_runs WHERE run_id=?',
      )
        .bind(run.run_id)
        .first(),
    ).toEqual(deleted);
    expect(
      await local.env.EVIDENCE.head(`research/${c.source.source_id}/${run.run_id}/0.json`),
    ).toBeNull();
    expect((await local.env.PRIVATE_DB.prepare('PRAGMA foreign_key_check').all()).results).toEqual(
      [],
    );
  });
});

// More than one purge chunk, including a failed R2 DELETE: no false success or orphan payloads.
it('purges at most 20 DC observations per call and resumes after evidence deletion failure', async () => {
  const { env, mf } = await localEnv();
  try {
    const c = dcConfig(),
      at = '2026-10-29T01:00:00.000Z',
      opt = dcOpt(at, c);
    const records = await Promise.all(
      Array.from({ length: 21 }, (_, i) =>
        dcRecord(at, 'planned_service_date', 'synthetic-release-' + i),
      ),
    );
    const first = await collectResearchPage(env, c, query, at, {
      ...opt,
      synthetic_text: dcPage(records.slice(0, 20), 0, 21, 1, 'partial'),
    });
    const second = await collectResearchPage(env, c, query, at, {
      ...opt,
      synthetic_text: dcPage(records.slice(20), 1, 21),
    });
    expect(second.state).toBe('complete');
    expect(second.run_id).toBe(first.run_id);
    const batch = await createDCReviewBatch(env, c, [first.run_id], opt);
    expect(batch.items).toHaveLength(20);
    expect(batch.remaining_count).toBe(1);
    await recordDCReview(env, c, batch.batch_id, { kind: 'all_ok' }, opt);
    const remainder = await createDCReviewBatch(env, c, [first.run_id], opt);
    expect(remainder.items).toHaveLength(1);
    expect(remainder.remaining_count).toBe(0);
    await recordDCReview(env, c, remainder.batch_id, { kind: 'all_ok' }, opt);
    await requestResearchDeletion(env, first.run_id, at, {
      basis_ref: 'synthetic-explicit-deletion',
      all_copies_delete_by: plusDays(at, 30),
    });
    const failedBucket = new Proxy(env.EVIDENCE, {
      get(target, key) {
        if (key === 'delete')
          return async () => {
            throw new Error('synthetic_r2_delete_failed');
          };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await expect(
      purgeResearchRun({ ...env, EVIDENCE: failedBucket }, first.run_id, at, {
        time_travel_days: 7,
      }),
    ).rejects.toThrow('synthetic_r2_delete_failed');
    expect(
      await env.PRIVATE_DB.prepare('SELECT COUNT(*) n FROM dc_observations WHERE run_id=?')
        .bind(first.run_id)
        .first(),
    ).toEqual({ n: 21 });
    expect(
      (await purgeResearchRun(env, first.run_id, at, { time_travel_days: 7 }))?.remaining,
    ).toBe(1);
    expect(
      (await purgeResearchRun(env, first.run_id, at, { time_travel_days: 7 }))?.remaining,
    ).toBe(0);
    expect(
      await env.PRIVATE_DB.prepare('SELECT COUNT(*) n FROM dc_projects WHERE run_id=?')
        .bind(first.run_id)
        .first(),
    ).toEqual({ n: 0 });
    expect(
      await env.EVIDENCE.head(runDeletionKey(c.source.source_id, first.run_id)),
    ).not.toBeNull();
  } finally {
    await mf.dispose();
  }
});
