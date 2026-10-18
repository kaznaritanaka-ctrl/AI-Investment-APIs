import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { personalLocalEnv } from '../scripts/personal-local-env';
import { dailyFixture, heartbeat, receiptSecret } from './daily-helpers';
import { gpuFetcher, gpuTime } from './public-gpu-helpers';
import {
  registerDaily,
  collectDaily,
  dailyMonitor,
  exportDailyHistory,
  maintainDaily,
  dailyJSON,
  type DailyEnv,
} from '../src/research/personal-daily';
import {
  dailyRoot,
  dailyRunId,
  DailyManifest,
  DailySnapshot,
} from '../src/research/daily-protocol';
import { dailyScheduled } from '../src/research/daily-scheduled';
import { stable } from '../src/util';
import { Miniflare, Log, LogLevel } from 'miniflare';
import { applyMigrations } from '../scripts/migrations';
import { cloudFixture } from './personal-cloud-fixture';
import { cloudPersonalEnv } from '../src/research/personal-cloud';
import { collectPersonalGpu } from '../src/research/personal';
describe('daily private history and NAS health, synthetic only', { timeout: 120000 }, () => {
  let local: Awaited<ReturnType<typeof personalLocalEnv>>, env: DailyEnv;
  beforeEach(async () => {
    local = await personalLocalEnv('synthetic-store');
    env = { ...local.env, NAS_HEALTH: local.env.EVIDENCE, NAS_RECEIPT_SECRET: receiptSecret };
  });
  afterEach(async () => {
    await local?.mf.dispose();
  });
  it('forward 0013 preserves populated 0012 history and immutable protections', async () => {
    const mf = new Miniflare({
      cf: false,
      modules: true,
      script: 'export default {fetch(){return new Response(null)}}',
      compatibilityDate: '2026-07-30',
      log: new Log(LogLevel.ERROR),
      d1Databases: ['PRIVATE_DB'],
      r2Buckets: ['EVIDENCE'],
    });
    try {
      const db = (await mf.getD1Database('PRIVATE_DB')) as unknown as D1Database,
        bucket = (await mf.getR2Bucket('EVIDENCE')) as unknown as R2Bucket;
      await applyMigrations(db, 'private', 12);
      const { contract, binding } = await cloudFixture();
      const old = cloudPersonalEnv(
        { PRIVATE_DB: db, EVIDENCE: bucket, ENVIRONMENT: 'test' },
        contract,
        binding,
      );
      await collectPersonalGpu(old, contract, {
        now: () => gpuTime,
        fetcher: gpuFetcher('highreso_public'),
        allow_network: true,
      });
      const before = await db
        .prepare('SELECT * FROM research_gpu_observations ORDER BY observation_id')
        .all();
      await applyMigrations(db, 'private');
      expect(
        (await db.prepare('SELECT * FROM research_gpu_observations ORDER BY observation_id').all())
          .results,
      ).toEqual(before.results);
      expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
      await expect(
        db.prepare("UPDATE research_gpu_observations SET domain_json='{}'").run(),
      ).rejects.toThrow('immutable');
      expect(await db.prepare('SELECT COUNT(*) n FROM personal_daily_runs').first('n')).toBe(0);
    } finally {
      await mf.dispose();
    }
  });
  it('concurrent attempts consume three GETs once and a contract change cannot reset the source day', async () => {
    const { c, pin } = await dailyFixture();
    await heartbeat(env, 'rebro_public', gpuTime);
    const get = vi.fn(gpuFetcher('rebro_public'));
    const results = await Promise.all([
      collectDaily(env, c, pin, { now: () => gpuTime, fetcher: get, allow_network: true }),
      collectDaily(env, c, pin, { now: () => gpuTime, fetcher: get, allow_network: true }),
    ]);
    expect(results.some((r) => r.state === 'complete')).toBe(true);
    expect(get).toHaveBeenCalledTimes(3);
    const changed = structuredClone(c);
    changed.decision.exception_id = 'different-owner-id';
    const { hash } = await import('../src/util');
    await expect(
      collectDaily(
        env,
        changed,
        { ...pin, contract_hash: await hash(stable(changed)) },
        { now: () => gpuTime, fetcher: get, allow_network: true },
      ),
    ).rejects.toThrow('slot_consumed');
    expect(get).toHaveBeenCalledTimes(3);
  });
  it('keeps both new flags off and rejects wrong pins, local/production crossover and public capability', async () => {
    const { c, pin } = await dailyFixture();
    expect(await dailyScheduled({} as any)).toEqual([]);
    await expect(
      registerDaily({ ...env, ENVIRONMENT: 'production' }, c, pin, gpuTime),
    ).rejects.toThrow('boundary');
    await expect(
      registerDaily({ ...env, PUBLIC_DB: env.PRIVATE_DB } as any, c, pin, gpuTime),
    ).rejects.toThrow('boundary');
    await expect(
      registerDaily(env, c, { ...pin, account_id: 'b'.repeat(32) }, gpuTime),
    ).rejects.toThrow('scope');
    expect((await env.EVIDENCE.list()).objects).toHaveLength(0);
  });
  it('scheduled daily capture isolates bad source config and maintenance never requests source HTTP', async () => {
    const { c, pin } = await dailyFixture();
    await env.EVIDENCE.put('personal-daily/contracts/rebro_public.json', stable(c));
    await heartbeat(env, 'rebro_public', gpuTime);
    const fetcher = vi.fn(gpuFetcher('rebro_public'));
    const base = {
      ...env,
      PERSONAL_DAILY_MAINTENANCE_ENABLED: 'true',
      PERSONAL_DAILY_COLLECTION_ENABLED: 'true',
      PERSONAL_DAILY_PINS: stable({
        account_id: pin.account_id,
        private_database_id: pin.private_database_id,
        bucket: pin.bucket,
        contracts: [
          { source_id: 'highreso_public', contract_hash: '0'.repeat(64) },
          { source_id: 'rebro_public', contract_hash: pin.contract_hash },
        ],
      }),
    } as any;
    const results = await dailyScheduled(base, { now: () => gpuTime, fetcher });
    expect(results[0]).toMatchObject({ state: 'configuration_or_maintenance_failed' });
    expect(results[1]).toMatchObject({ collection: 'complete', history: 'exported' });
    expect(fetcher).toHaveBeenCalledTimes(3);
    await dailyScheduled(
      { ...base, PERSONAL_DAILY_COLLECTION_ENABLED: 'false' },
      { now: () => '2026-10-19T01:00:00.000Z', fetcher },
    );
    expect(fetcher).toHaveBeenCalledTimes(3);
    // An old latest source observation is not a stale NAS backup. After an outage,
    // fresh verified custody of the latest available run allows automatic recovery.
    const healthyAt = '2026-10-23T01:00:00.000Z';
    const oldObservationReceipt = await heartbeat(env, 'rebro_public', healthyAt);
    oldObservationReceipt.latest_observed_at = gpuTime;
    const { receiptSignature } = await import('../src/research/daily-protocol');
    await env.NAS_HEALTH!.put(
      'daily/receipts/rebro_public.json',
      stable({
        receipt: oldObservationReceipt,
        signature: await receiptSignature(oldObservationReceipt, receiptSecret),
      }),
    );
    expect((await dailyMonitor(env, c, healthyAt)).collection_allowed).toBe(true);
    const restored = await personalLocalEnv('synthetic-store');
    try {
      await expect(
        collectDaily({ ...env, PRIVATE_DB: restored.env.PRIVATE_DB }, c, pin, {
          now: () => '2026-10-19T01:00:00.000Z',
          fetcher,
          allow_network: true,
        }),
      ).rejects.toThrow('rollback');
      expect(fetcher).toHaveBeenCalledTimes(3);
    } finally {
      await restored.mf.dispose();
    }
  });
  it('collects once per source/day, records same-price reobservation and never manufactures missed days', async () => {
    const { c, pin } = await dailyFixture(),
      get = vi.fn(gpuFetcher('rebro_public'));
    for (const at of [gpuTime, '2026-10-19T01:00:00.000Z', '2026-10-21T01:00:00.000Z']) {
      await heartbeat(env, 'rebro_public', at);
      expect(
        await collectDaily(env, c, pin, { now: () => at, allow_network: true, fetcher: get }),
      ).toMatchObject({ state: 'complete' });
      expect(
        await collectDaily(env, c, pin, { now: () => at, allow_network: true, fetcher: get }),
      ).toMatchObject({ state: 'complete', reused: true });
    }
    expect(get).toHaveBeenCalledTimes(9);
    const rows = await env.PRIVATE_DB.prepare(
      'SELECT change_kind,previous_observation_id FROM personal_daily_observations',
    ).all();
    expect(rows.results).toHaveLength(6);
    expect(rows.results.filter((r) => r.change_kind === 'reobserved')).toHaveLength(4);
    expect(
      await env.PRIVATE_DB.prepare(
        "SELECT COUNT(*) n FROM personal_daily_runs WHERE day='2026-10-20'",
      ).first('n'),
    ).toBe(0);
    await expect(
      env.PRIVATE_DB.prepare("UPDATE personal_daily_observations SET domain_json='{}'").run(),
    ).rejects.toThrow('immutable');
    await expect(
      collectDaily(
        env,
        c,
        pin,
        { now: () => gpuTime, allow_network: true, fetcher: get },
        '2026-10-17',
      ),
    ).rejects.toThrow('saved_projection');
    expect(c.config.source.enabled).toBe(false);
    expect(c.decision.provider_permission).toBe('unconfirmed');
  });
  it('fails closed for missing, stale, malformed, replayed and invalid signed health without consuming a slot', async () => {
    const { c, pin } = await dailyFixture(),
      get = vi.fn(gpuFetcher('rebro_public'));
    expect(
      await collectDaily(env, c, pin, { now: () => gpuTime, allow_network: true, fetcher: get }),
    ).toMatchObject({ state: 'nas_hold' });
    await heartbeat(env, 'rebro_public', gpuTime, 'empty');
    expect((await dailyMonitor(env, c, gpuTime)).state).toBe('bootstrap');
    expect((await dailyMonitor(env, c, '2026-10-19T01:00:00.000Z')).collection_allowed).toBe(false);
    const key = 'daily/receipts/rebro_public.json',
      r = await dailyJSON(env.NAS_HEALTH!, key);
    await env.NAS_HEALTH!.put(key, stable({ ...r, signature: '0'.repeat(64) }));
    expect((await dailyMonitor(env, c, gpuTime)).state).toBe('unknown');
    await heartbeat(env, 'rebro_public', '2026-10-19T02:00:00.000Z');
    expect((await dailyMonitor(env, c, '2026-10-19T02:00:00.000Z')).state).toBe('healthy');
    await heartbeat(env, 'rebro_public', gpuTime);
    expect((await dailyMonitor(env, c, '2026-10-19T02:00:00.000Z')).state).toBe('unknown');
    expect(get).not.toHaveBeenCalled();
    expect(
      await env.PRIVATE_DB.prepare('SELECT COUNT(*) n FROM personal_daily_runs').first('n'),
    ).toBe(0);
  });
  it('honors Retry-After across days and resumes saved projection after DB failure without another HTTP request', async () => {
    const { c, pin } = await dailyFixture();
    await heartbeat(env, 'rebro_public', gpuTime);
    const limited = vi.fn(
      async () => new Response(null, { status: 429, headers: { 'retry-after': '172800' } }),
    );
    await expect(
      collectDaily(env, c, pin, { now: () => gpuTime, allow_network: true, fetcher: limited }),
    ).rejects.toThrow('capture_failed');
    const next = '2026-10-19T01:00:00.000Z';
    await heartbeat(env, 'rebro_public', next);
    await expect(
      collectDaily(env, c, pin, { now: () => next, allow_network: true, fetcher: limited }),
    ).rejects.toThrow('source_stopped');
    expect(limited).toHaveBeenCalledTimes(1);
    const later = '2026-10-20T01:00:00.000Z';
    await heartbeat(env, 'rebro_public', later);
    let failed = false;
    const db = new Proxy(env.PRIVATE_DB, {
      get(target, key) {
        const value = Reflect.get(target, key);
        return key === 'batch'
          ? async (...args: any[]) => {
              if (!failed) {
                failed = true;
                throw new Error('synthetic DB interruption');
              }
              return Reflect.apply(value, target, args);
            }
          : typeof value === 'function'
            ? value.bind(target)
            : value;
      },
    });
    const get = vi.fn(gpuFetcher('rebro_public'));
    await expect(
      collectDaily({ ...env, PRIVATE_DB: db }, c, pin, {
        now: () => later,
        allow_network: true,
        fetcher: get,
      }),
    ).rejects.toThrow('capture_failed');
    const resume = '2026-10-21T00:30:00.000Z';
    expect(
      await collectDaily(
        env,
        c,
        pin,
        { now: () => resume, allow_network: true, fetcher: get },
        '2026-10-20',
      ),
    ).toMatchObject({ state: 'complete' });
    expect(get).toHaveBeenCalledTimes(3);
  });
  it('exports multiple runs with replay, keeps 11-year-old observations and expires only backup generations', async () => {
    const { c, pin } = await dailyFixture();
    for (const at of [gpuTime, '2026-10-19T01:00:00.000Z']) {
      await heartbeat(env, 'rebro_public', at);
      await collectDaily(env, c, pin, {
        now: () => at,
        allow_network: true,
        fetcher: gpuFetcher('rebro_public'),
      });
    }
    const at = '2037-10-18T01:00:00.000Z';
    for (let i = 0; i < 2; i++)
      expect((await exportDailyHistory(env, 'rebro_public', at)).state).toBe('exported');
    expect((await exportDailyHistory(env, 'rebro_public', at)).state).toBe('current');
    const head = await dailyJSON(env.EVIDENCE, dailyRoot('rebro_public') + 'catalog.json');
    expect(head.max_ordinal).toBe(2);
    const m = DailyManifest.parse(
      await dailyJSON(
        env.EVIDENCE,
        dailyRoot('rebro_public') + 'runs/' + head.latest_run_id + '.json',
      ),
    );
    const bytes = await Promise.all(
      m.chunks.map(
        async (p) => new Uint8Array(await (await env.EVIDENCE.get(p.key))!.arrayBuffer()),
      ),
    );
    const s = DailySnapshot.parse(JSON.parse(Buffer.concat(bytes).toString()));
    expect(s.day).toBe('2026-10-19');
    expect(s.records).toHaveLength(2);
    for (let i = 0; i < 8; i++)
      await maintainDaily(env, 'rebro_public', '2037-10-27T01:00:00.000Z');
    expect(
      await env.PRIVATE_DB.prepare('SELECT COUNT(*) n FROM personal_daily_observations').first('n'),
    ).toBe(4);
    await env.EVIDENCE.put(dailyRoot('rebro_public') + 'revoked.json', stable({ at }));
    await maintainDaily(env, 'rebro_public', '2037-10-28T01:00:00.000Z');
    expect(
      await env.PRIVATE_DB.prepare('SELECT COUNT(*) n FROM personal_daily_observations').first('n'),
    ).toBe(0);
    expect(
      (await env.EVIDENCE.list({ prefix: dailyRoot('rebro_public') + 'slots/' })).objects,
    ).toHaveLength(2);
  });
  it('maintenance closes interrupted slots and expired partials without new HTTP or zero observations', async () => {
    const { c, pin } = await dailyFixture();
    await registerDaily(env, c, pin, gpuTime);
    const run = await dailyRunId('rebro_public', '2026-10-18', 'synthetic');
    await env.EVIDENCE.put(
      dailyRoot('rebro_public') + 'slots/2026-10-18.json',
      stable({ contract_hash: pin.contract_hash, run_id: run, started_at: gpuTime }),
    );
    for (let i = 0; i < 3; i++)
      await maintainDaily(env, 'rebro_public', '2026-10-20T01:00:00.000Z');
    expect(
      await env.PRIVATE_DB.prepare(
        'SELECT state,record_count,reason FROM personal_daily_runs WHERE run_id=?',
      )
        .bind(run)
        .first(),
    ).toEqual({ state: 'failed', record_count: null, reason: 'interrupted_before_checkpoint' });
    await env.PRIVATE_DB.prepare(
      "UPDATE personal_daily_runs SET state='partial',reason=NULL WHERE run_id=?",
    )
      .bind(run)
      .run();
    await maintainDaily(env, 'rebro_public', '2026-10-21T01:00:00.000Z');
    expect(
      await env.PRIVATE_DB.prepare('SELECT state,reason FROM personal_daily_runs WHERE run_id=?')
        .bind(run)
        .first(),
    ).toEqual({ state: 'failed', reason: 'saved_projection_expired' });
  });
});
