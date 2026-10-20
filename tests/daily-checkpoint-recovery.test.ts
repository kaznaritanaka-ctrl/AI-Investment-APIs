import { it, expect, vi } from 'vitest';
import { personalLocalEnv } from '../scripts/personal-local-env';
import { expandedDaily, rentalHtml, day } from './daily-series-helpers';
import { gpuFetcher, gpuTime } from './public-gpu-helpers';
import { heartbeat, receiptSecret } from './daily-helpers';
import {
  collectDaily,
  exportDailyHistory,
  dailyJSON,
  type DailyEnv,
} from '../src/research/personal-daily';
import { dailyRoot, DailyManifest, validateDailySnapshot } from '../src/research/daily-protocol';
import { syncNasExport } from '../src/research/nas-export';
import { exportFixture } from './nas-export-fixture';
import { guardedNasReader } from '../scripts/personal-nas-transport';
import { dailyNasCycle, restoreDailyNas, type DailyNasOptions } from '../scripts/daily-nas';
import { mkdir, mkdtemp, readdir, readFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { hash, stable } from '../src/util';
it.each(['DB', 'R2'])(
  'resumes 128 records after a %s checkpoint failure without source re-GET or early completeness',
  async (failure) => {
    const local = await personalLocalEnv('synthetic-store');
    try {
      const f = await expandedDaily(),
        base: DailyEnv = {
          ...local.env,
          NAS_HEALTH: local.env.EVIDENCE,
          NAS_RECEIPT_SECRET: receiptSecret,
        };
      await heartbeat(base, 'highreso_public', gpuTime);
      let batches = 0,
        fault = false,
        maxBatch = 0;
      const db = new Proxy(base.PRIVATE_DB, {
        get(target, key) {
          const v = Reflect.get(target, key);
          return key === 'batch'
            ? async (s: D1PreparedStatement[]) => {
                batches++;
                maxBatch = Math.max(maxBatch, s.length);
                if (failure === 'DB' && batches === 2) {
                  fault = true;
                  throw new Error('synthetic DB checkpoint interruption');
                }
                return target.batch(s);
              }
            : typeof v === 'function'
              ? v.bind(target)
              : v;
        },
      });
      const r2 = new Proxy(base.EVIDENCE, {
        get(target, key) {
          const v = Reflect.get(target, key);
          return key === 'put'
            ? async (key: string, ...args: any[]) => {
                if (
                  failure === 'R2' &&
                  !fault &&
                  key.endsWith('/part-1.json') &&
                  key.includes('/evidence/')
                ) {
                  fault = true;
                  throw new Error('synthetic R2 chunk interruption');
                }
                return Reflect.apply(v, target, [key, ...args]);
              }
            : typeof v === 'function'
              ? v.bind(target)
              : v;
        },
      });
      const env = { ...base, PRIVATE_DB: db, EVIDENCE: r2 },
        get = vi.fn(gpuFetcher('highreso_public', rentalHtml(64)));
      let complete = false,
        partials = 0;
      for (let i = 0; i < 18; i++) {
        try {
          const r = await collectDaily(
            env,
            f.c,
            f.pin,
            { now: () => gpuTime, fetcher: get, allow_network: true },
            i ? '2026-10-18' : undefined,
          );
          if (r.state === 'complete') {
            complete = true;
            break;
          }
          expect(r.state).toBe('partial');
          partials++;
        } catch (e) {
          expect(String(e)).toContain('daily_capture_failed');
          expect(fault).toBe(true);
        }
        expect(
          await base.PRIVATE_DB.prepare(
            "SELECT COUNT(*) n FROM personal_daily_runs WHERE state='complete'",
          ).first('n'),
        ).toBe(0);
        expect(
          await base.PRIVATE_DB.prepare(
            "SELECT COUNT(*) n FROM personal_daily_observations o JOIN personal_daily_runs r ON r.run_id=o.run_id WHERE r.state='complete' AND o.change_kind='not_seen'",
          ).first('n'),
        ).toBe(0);
      }
      expect(fault).toBe(true);
      expect(complete).toBe(true);
      expect(partials).toBeGreaterThan(0);
      expect(maxBatch).toBeLessThanOrEqual(20);
      expect(get).toHaveBeenCalledTimes(3);
      expect(
        await base.PRIVATE_DB.prepare('SELECT COUNT(*) n FROM personal_daily_observations').first(
          'n',
        ),
      ).toBe(128);
      expect(
        await base.PRIVATE_DB.prepare('SELECT next_index FROM personal_daily_checkpoints').first(
          'next_index',
        ),
      ).toBe(128);
    } finally {
      await local.mf.dispose();
    }
  },
  180000,
);

it('rolls back absence events when the final complete transaction fails; saved capture resumes without HTTP', async () => {
  const local = await personalLocalEnv('synthetic-store');
  try {
    const f = await expandedDaily(),
      env: DailyEnv = {
        ...local.env,
        NAS_HEALTH: local.env.EVIDENCE,
        NAS_RECEIPT_SECRET: receiptSecret,
      };
    await day(env, f, gpuTime, rentalHtml(1));
    const at = '2026-10-19T01:00:00.000Z';
    await heartbeat(env, 'highreso_public', at);
    let fault = false;
    const db = new Proxy(env.PRIVATE_DB, {
      get(target, key) {
        const v = Reflect.get(target, key);
        return key === 'batch'
          ? async (statements: D1PreparedStatement[]) => {
              if (statements.length === 2 && !fault) {
                fault = true;
                return target.batch([
                  statements[0],
                  target.prepare("SELECT json('synthetic invalid JSON')"),
                ]);
              }
              return target.batch(statements);
            }
          : typeof v === 'function'
            ? v.bind(target)
            : v;
      },
    });
    const get = vi.fn(gpuFetcher('highreso_public', rentalHtml(0)));
    await expect(
      collectDaily({ ...env, PRIVATE_DB: db }, f.c, f.pin, {
        now: () => at,
        allow_network: true,
        fetcher: get,
      }),
    ).rejects.toThrow('daily_capture_failed');
    expect(fault).toBe(true);
    expect(
      await env.PRIVATE_DB.prepare(
        "SELECT COUNT(*) n FROM personal_daily_observations WHERE change_kind='not_seen'",
      ).first('n'),
    ).toBe(0);
    expect(
      await env.PRIVATE_DB.prepare(
        "SELECT state FROM personal_daily_runs WHERE day='2026-10-19'",
      ).first('state'),
    ).toBe('partial');
    await heartbeat(env, 'highreso_public', '2026-10-20T01:00:00.000Z');
    expect(
      (
        await collectDaily(env, f.c, f.pin, {
          now: () => '2026-10-20T01:00:00.000Z',
          allow_network: true,
          fetcher: get,
        })
      ).state,
    ).toBe('prior_partial_hold');
    expect(
      (
        await collectDaily(
          env,
          f.c,
          f.pin,
          { now: () => at, allow_network: true, fetcher: get },
          '2026-10-19',
        )
      ).state,
    ).toBe('complete');
    expect(get).toHaveBeenCalledTimes(3);
    expect(
      await env.PRIVATE_DB.prepare(
        "SELECT COUNT(*) n FROM personal_daily_observations WHERE change_kind='not_seen'",
      ).first('n'),
    ).toBe(2);
  } finally {
    await local.mf.dispose();
  }
}, 120000);

it('exports and restores the full 128 seen + 128 disappearance cohort with identical immutable hashes', async () => {
  const local = await personalLocalEnv('synthetic-store');
  try {
    const f = await expandedDaily(),
      env: DailyEnv = {
        ...local.env,
        NAS_HEALTH: local.env.EVIDENCE,
        NAS_RECEIPT_SECRET: receiptSecret,
      };
    for (const [at, prefix] of [
      [gpuTime, 'alpha'],
      ['2026-10-19T01:00:00.000Z', 'beta'],
    ]) {
      env.NAS_HEALTH = (await local.mf.getR2Bucket('NAS_HEALTH')) as unknown as R2Bucket;
      if (prefix === 'beta') {
        await heartbeat(env, 'highreso_public', at);
        const get = vi.fn(gpuFetcher('highreso_public', rentalHtml(64, prefix)));
        expect(
          (
            await collectDaily(env, f.c, f.pin, {
              now: () => at,
              allow_network: true,
              fetcher: get,
            })
          ).state,
        ).toBe('partial');
        expect(
          await env.PRIVATE_DB.prepare(
            "SELECT COUNT(*) n FROM personal_daily_observations WHERE change_kind='not_seen'",
          ).first('n'),
        ).toBe(0);
      }
      expect((await day(env, f, at, rentalHtml(64, prefix))).result.state).toBe('complete');
    }
    const at = '2026-10-19T02:00:00.000Z';
    for (let i = 0; i < 2; i++) await exportDailyHistory(env, 'highreso_public', at);
    const original = (
      await env.PRIVATE_DB.prepare(
        'SELECT * FROM personal_daily_observations ORDER BY observation_id',
      ).all()
    ).results;
    expect(original).toHaveLength(384);
    const head = await dailyJSON(env.EVIDENCE, dailyRoot('highreso_public') + 'catalog.json'),
      manifest = DailyManifest.parse(
        await dailyJSON(
          env.EVIDENCE,
          dailyRoot('highreso_public') + 'runs/' + head.latest_run_id + '.json',
        ),
      );
    const parts = await Promise.all(
        manifest.chunks.map(
          async (p) => new Uint8Array(await (await env.EVIDENCE.get(p.key))!.arrayBuffer()),
        ),
      ),
      snapshot = await validateDailySnapshot(JSON.parse(Buffer.concat(parts).toString()));
    expect(snapshot).toMatchObject({
      version: 'daily-history-v2',
      coverage: { seen_count: 128, not_seen_count: 128, event_count: 256 },
    });
    expect(manifest.chunks.every((p) => p.bytes <= 131072)).toBe(true);
    expect(Buffer.concat(parts).length).toBeLessThanOrEqual(524288);
    const output = (await local.mf.getR2Bucket('NAS_EXPORT')) as unknown as R2Bucket,
      pin = exportFixture('synthetic-health-only'),
      base = {
        EVIDENCE: env.EVIDENCE,
        NAS_EXPORT: output,
        NAS_HEALTH: env.NAS_HEALTH,
        PERSONAL_EXPORT_PINS: JSON.stringify(pin),
      };
    for (let i = 0; i < 4; i++) await syncNasExport(base, pin, 'highreso_public', 'daily', at);
    const reader = guardedNasReader(
      {
        get: async (key) => {
          const o = await output.get(key);
          return o ? new Uint8Array(await o.arrayBuffer()) : null;
        },
      },
      pin,
      'highreso_public',
      'daily',
      () => at,
    );
    await mkdir('work/nas-synthetic', { recursive: true });
    const root = await mkdtemp(resolve('work/nas-synthetic/series-max-')),
      age = resolve(
        process.env.AGE_BINARY ??
          'work/tools/age-v1.3.2/age/age' + (process.platform === 'win32' ? '.exe' : ''),
      ),
      identity = join(root, 'synthetic.key');
    const generated = spawnSync(
      join(dirname(age), 'age-keygen' + (process.platform === 'win32' ? '.exe' : '')),
      ['-o', identity],
      { windowsHide: true, stdio: 'pipe' },
    );
    expect(generated.status).toBe(0);
    const opt: DailyNasOptions = {
      root: join(root, 'sealed'),
      ageBinary: age,
      identityFile: identity,
      recipient: generated.stderr.toString().match(/age1[a-z0-9]{58}/)![0],
      account_id: f.c.cloud.account_id,
      bucket: f.c.cloud.bucket,
      store_id: 'synthetic-store',
      data_origin: 'synthetic',
      now: () => at,
      receiptSecret,
      sendReceipt: async () => {},
    };
    expect((await dailyNasCycle(reader, 'highreso_public', opt)).state).toBe('ok');
    expect(
      (await readdir(join(opt.root, 'highreso_public'))).filter((n) => n.endsWith('.age')),
    ).toHaveLength(2);
    const destination = join(root, 'staging');
    let restored;
    for (let i = 0; i < 6; i++) {
      restored = await restoreDailyNas(
        reader,
        'highreso_public',
        opt,
        destination,
        'SYNTHETIC restore acceptance',
      );
      if (restored.state === 'complete') break;
    }
    expect(restored).toMatchObject({ state: 'complete', runs: 2 });
    const reopened = await personalLocalEnv('synthetic-store', 'test', destination);
    try {
      expect(
        (
          await reopened.env.PRIVATE_DB.prepare(
            'SELECT * FROM personal_daily_observations ORDER BY observation_id',
          ).all()
        ).results,
      ).toEqual(original);
      expect(
        await hash(
          stable(
            (
              await reopened.env.PRIVATE_DB.prepare(
                'SELECT * FROM personal_daily_coverage ORDER BY run_id',
              ).all()
            ).results,
          ),
        ),
      ).toBe(
        await hash(
          stable(
            (
              await env.PRIVATE_DB.prepare(
                'SELECT * FROM personal_daily_coverage ORDER BY run_id',
              ).all()
            ).results,
          ),
        ),
      );
      await expect(
        reopened.env.PRIVATE_DB.prepare('DELETE FROM personal_daily_observations').run(),
      ).rejects.toThrow('daily_retention_required');
    } finally {
      await reopened.mf.dispose();
    }
  } finally {
    await local.mf.dispose();
  }
}, 180000);
