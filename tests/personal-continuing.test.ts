import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { personalLocalEnv } from '../scripts/personal-local-env';
import {
  collectPersonalGpu,
  readPersonalGpu,
  maintainPersonalGpu,
  revokePersonalUse,
  stopPersonalCollection,
} from '../src/research/personal';
import {
  renewPersonalReview,
  personalHeadKey,
  personalReviewHead,
} from '../src/research/personal-review';
import { createPersonalSnapshot, restorePersonalSnapshot } from '../src/research/personal-snapshot';
import { continuingFixture, reviewFixture } from './personal-continuing-fixture';
import { gpuFetcher } from './public-gpu-helpers';
import { gpuTime } from './personal-fixture';
import { stable } from '../src/util';

describe('continuing personal authority; synthetic only', () => {
  let local: Awaited<ReturnType<typeof personalLocalEnv>>;
  beforeEach(async () => {
    local = await personalLocalEnv('synthetic-store');
  });
  afterEach(async () => {
    await local?.mf.dispose();
    vi.restoreAllMocks();
  });
  const initial = (source: 'highreso_public' | 'rebro_public' = 'highreso_public') => ({
    allow_network: true,
    fetcher: vi.fn(gpuFetcher(source)),
    now: () => gpuTime,
  });
  it.each(['highreso_public', 'rebro_public'] as const)(
    'keeps %s past ten years and renews read without changing capture or collection budget',
    async (source) => {
      const c = await continuingFixture(source),
        opt = initial(source),
        before = stable(c.config);
      const run = await collectPersonalGpu(local.env, c, opt);
      const original = await readPersonalGpu(local.env, c, opt);
      const future = '2037-10-18T01:00:00.000Z',
        futureOpt = { now: () => future };
      expect(await maintainPersonalGpu(local.env, c, futureOpt)).toMatchObject({
        state: 'review_due',
        remaining: original.results.length,
      });
      await expect(readPersonalGpu(local.env, c, futureOpt)).rejects.toThrow();
      const update = await reviewFixture(local.env, c, future);
      await renewPersonalReview(local.env, c, update, futureOpt);
      expect((await readPersonalGpu(local.env, c, futureOpt)).results).toEqual(original.results);
      expect(
        (await local.env.EVIDENCE.list({ prefix: 'research/personal/' })).objects,
      ).toHaveLength(0);
      expect(
        await local.env.PRIVATE_DB.prepare(
          'SELECT normalized_mode,normalized_expires_at,all_copies_expires_at FROM research_runs WHERE run_id=?',
        )
          .bind(run.run_id)
          .first(),
      ).toEqual({
        normalized_mode: 'owner_continuing',
        normalized_expires_at: null,
        all_copies_expires_at: null,
      });
      await expect(collectPersonalGpu(local.env, c, { ...opt, now: () => future })).rejects.toThrow(
        'personal_acquisition_window_closed',
      );
      expect(opt.fetcher).toHaveBeenCalledTimes(3);
      expect(stable(c.config)).toBe(before);
      expect(
        await local.env.PRIVATE_DB.prepare(
          'SELECT COUNT(*) n FROM research_personal_reviews',
        ).first(),
      ).toEqual({ n: 1 });
    },
    120000,
  );
  it('preserves explicit ends, never promotes v1, and does not let a review resurrect revocation', async () => {
    const c = await continuingFixture();
    await collectPersonalGpu(local.env, c, initial());
    const at = '2026-10-19T01:00:00.000Z',
      opt = { now: () => at };
    const r = await reviewFixture(local.env, c, at);
    r.storage_ends_at = '2026-10-21T01:00:00.000Z';
    await renewPersonalReview(local.env, c, r, opt);
    const next = await reviewFixture(local.env, c, at);
    next.storage_ends_at = null;
    await expect(renewPersonalReview(local.env, c, next, opt)).rejects.toThrow(
      'personal_storage_extension_forbidden',
    );
    expect(
      await maintainPersonalGpu(local.env, c, { now: () => r.storage_ends_at! }),
    ).toMatchObject({ state: 'purged' });
    await expect(
      renewPersonalReview(local.env, c, await reviewFixture(local.env, c, r.storage_ends_at!), {
        now: () => r.storage_ends_at!,
      }),
    ).rejects.toThrow('personal_storage_expired');
  }, 120000);
  it('isolates unknown storage and collection stop from deletion and serializes competing renewals', async () => {
    const c = await continuingFixture();
    await collectPersonalGpu(local.env, c, initial());
    await stopPersonalCollection(local.env, c, 'SYNTHETIC stop', initial());
    const r = await reviewFixture(local.env, c, gpuTime);
    r.storage_state = 'unknown';
    const results = await Promise.allSettled([
      renewPersonalReview(local.env, c, r, initial()),
      renewPersonalReview(local.env, c, r, initial()),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await maintainPersonalGpu(local.env, c, initial())).toMatchObject({
      state: 'storage_unknown',
      remaining: 4,
    });
    await expect(readPersonalGpu(local.env, c, initial())).rejects.toThrow(
      'personal_storage_review_required',
    );
    await expect(createPersonalSnapshot(local.env, c, initial())).rejects.toThrow(
      'personal_storage_review_required',
    );
    await renewPersonalReview(local.env, c, await reviewFixture(local.env, c, gpuTime), initial());
    expect((await readPersonalGpu(local.env, c, initial())).results).toHaveLength(4);
    await expect(collectPersonalGpu(local.env, c, initial())).rejects.toThrow(
      'personal_collection_stopped',
    );
  }, 120000);
  it('restores only normalized data into an empty DB using the latest external review; blocks old backups after revocation', async () => {
    const c = await continuingFixture();
    await collectPersonalGpu(local.env, c, initial());
    const snapshot = await createPersonalSnapshot(local.env, c, initial());
    const at = '2026-10-20T01:00:00.000Z',
      opt = { now: () => at };
    await renewPersonalReview(local.env, c, await reviewFixture(local.env, c, at), opt);
    const fresh = await personalLocalEnv('synthetic-store');
    try {
      const target = { ...fresh.env, EVIDENCE: local.env.EVIDENCE };
      expect(await restorePersonalSnapshot(target, c, snapshot.snapshot, opt)).toMatchObject({
        state: 'restored',
        observation_count: 4,
        short_evidence_restored: false,
      });
      expect((await readPersonalGpu(target, c, opt)).results).toHaveLength(4);
      expect(
        await fresh.env.PRIVATE_DB.prepare(
          'SELECT sequence FROM research_personal_reviews',
        ).first(),
      ).toEqual({ sequence: 1 });
      await expect(restorePersonalSnapshot(target, c, snapshot.snapshot, opt)).rejects.toThrow(
        'personal_restore_destination_not_empty',
      );
      await revokePersonalUse(local.env, c, 'SYNTHETIC revoked', opt);
      await expect(readPersonalGpu(target, c, opt)).rejects.toThrow();
      const newer = await reviewFixture(local.env, c, at);
      await expect(renewPersonalReview(local.env, c, newer, opt)).rejects.toThrow(
        'research_run_deleted',
      );
      await expect(restorePersonalSnapshot(target, c, snapshot.snapshot, opt)).rejects.toThrow(
        'research_run_deleted',
      );
    } finally {
      await fresh.mf.dispose();
    }
  }, 120000);
  it('fails closed on missing external control and rejects mutated snapshot values before writes', async () => {
    const c = await continuingFixture();
    await collectPersonalGpu(local.env, c, initial());
    const { snapshot } = await createPersonalSnapshot(local.env, c, initial());
    const fresh = await personalLocalEnv('synthetic-store');
    try {
      const target = { ...fresh.env, EVIDENCE: local.env.EVIDENCE };
      snapshot.tables.research_gpu_observations[0].domain_json = '{}';
      await expect(restorePersonalSnapshot(target, c, snapshot, initial())).rejects.toThrow();
      expect(
        await fresh.env.PRIVATE_DB.prepare('SELECT COUNT(*) n FROM research_runs').first(),
      ).toEqual({ n: 0 });
      await local.env.EVIDENCE.delete(personalHeadKey(c));
      await expect(maintainPersonalGpu(local.env, c, initial())).rejects.toThrow(
        'personal_current_review_missing',
      );
      await expect(collectPersonalGpu(local.env, c, initial())).rejects.toThrow(
        'personal_current_review_missing',
      );
    } finally {
      await fresh.mf.dispose();
    }
  }, 120000);
  it('keeps an interrupted restore unreadable and detects a control rollback against its audit', async () => {
    const c = await continuingFixture();
    await collectPersonalGpu(local.env, c, initial());
    const { snapshot } = await createPersonalSnapshot(local.env, c, initial());
    const fresh = await personalLocalEnv('synthetic-store');
    try {
      let batches = 0;
      const db = new Proxy(fresh.env.PRIVATE_DB, {
        get(target, key) {
          if (key === 'batch')
            return async (statements: D1PreparedStatement[]) => {
              if (++batches === 5) throw new Error('synthetic_restore_interrupted');
              return target.batch(statements);
            };
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const target = { ...fresh.env, PRIVATE_DB: db, EVIDENCE: local.env.EVIDENCE };
      await expect(restorePersonalSnapshot(target, c, snapshot, initial())).rejects.toThrow(
        'synthetic_restore_interrupted',
      );
      expect((await readPersonalGpu(target, c, initial())).results).toEqual([]);
      expect(await fresh.env.PRIVATE_DB.prepare('SELECT state FROM research_runs').first()).toEqual(
        { state: 'partial' },
      );
      await expect(restorePersonalSnapshot(target, c, snapshot, initial())).rejects.toThrow(
        'personal_restore_destination_not_empty',
      );
      const original = await (await local.env.EVIDENCE.get(personalHeadKey(c)))!.text();
      await renewPersonalReview(
        local.env,
        c,
        await reviewFixture(local.env, c, gpuTime),
        initial(),
      );
      await local.env.EVIDENCE.put(personalHeadKey(c), original);
      await expect(readPersonalGpu(local.env, c, initial())).rejects.toThrow(
        'personal_current_review_rollback',
      );
    } finally {
      await fresh.mf.dispose();
    }
  }, 120000);
});
