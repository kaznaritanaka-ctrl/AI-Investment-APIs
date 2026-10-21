import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { personalLocalEnv } from '../scripts/personal-local-env';
import { dailyFixture, heartbeat, receiptSecret } from './daily-helpers';
import { day, rentalHtml } from './daily-series-helpers';
import { gpuTime, gpuFetcher } from './public-gpu-helpers';
import { hash, stable } from '../src/util';
import {
  collectDaily,
  registerDaily,
  exportDailyHistory,
  dailyJSON,
  type DailyEnv,
} from '../src/research/personal-daily';
import {
  dailyRoot,
  dailyRunId,
  DailyManifest,
  validateDailySnapshot,
} from '../src/research/daily-protocol';
import { parsePublicGpu, gpuRecordFingerprint } from '../src/research/public-gpu-html';

type Fixture = Awaited<ReturnType<typeof dailyFixture>>;
async function seedLegacy(env: DailyEnv, f: Fixture, at: string, html: string, stageRow = false) {
  await registerDaily(env, f.c, f.pin, at);
  const source = f.c.config.source.source_id,
    root = dailyRoot(source);
  const run = await dailyRunId(source, at.slice(0, 10), 'synthetic');
  const page = await parsePublicGpu(f.c.config, html, at, true);
  const capture = {
    contract_hash: f.pin.contract_hash,
    run_id: run,
    observed_at: at,
    payload_hash: await hash(html),
    page,
  };
  const text = stable(capture),
    key = root + 'evidence/' + run + '.json';
  const expires = new Date(
    Date.parse(at) + f.c.decision.retention.evidence_days * 86400000,
  ).toISOString();
  await env.EVIDENCE.put(
    root + 'slots/' + at.slice(0, 10) + '.json',
    stable({ contract_hash: f.pin.contract_hash, run_id: run, started_at: at }),
  );
  await env.EVIDENCE.put(key, text, { customMetadata: { expires_at: expires } });
  await env.PRIVATE_DB.prepare(
    "INSERT INTO personal_daily_runs(run_id,source_id,day,synthetic,contract_hash,started_at,state,evidence_expires_at) VALUES (?,?,?,1,?,?,'partial',?)",
  )
    .bind(run, source, at.slice(0, 10), f.pin.contract_hash, at, expires)
    .run();
  if (stageRow) {
    const r = page.records[0],
      fingerprint = await gpuRecordFingerprint(r);
    // Exactly the old pre-series lookup, to reproduce populated old checkpoints.
    const previous = await env.PRIVATE_DB.prepare(
      "SELECT o.observation_id,o.record_hash FROM personal_daily_observations o JOIN personal_daily_runs r ON r.run_id=o.run_id WHERE r.source_id=? AND r.state='complete' AND r.started_at<? AND o.record_key=? ORDER BY r.started_at DESC LIMIT 1",
    )
      .bind(source, at, r.record_key)
      .first<{ observation_id: string; record_hash: string }>();
    await env.PRIVATE_DB.prepare(
      'INSERT INTO personal_daily_observations VALUES (?,?,?,?,?,?,?,?,?)',
    )
      .bind(
        await hash(stable([run, r.record_key, fingerprint])),
        run,
        r.record_key,
        fingerprint,
        at,
        at,
        previous?.observation_id ?? null,
        previous ? (previous.record_hash === fingerprint ? 'reobserved' : 'revised') : 'first_seen',
        stable(r),
      )
      .run();
  }
  return { run, key, text };
}

describe('PR18 reviewed recovery boundaries, synthetic only', { timeout: 180000 }, () => {
  let local: Awaited<ReturnType<typeof personalLocalEnv>>, env: DailyEnv;
  beforeEach(async () => {
    local = await personalLocalEnv('synthetic-store');
    env = { ...local.env, NAS_HEALTH: local.env.EVIDENCE, NAS_RECEIPT_SECRET: receiptSecret };
  });
  afterEach(async () => {
    await local?.mf.dispose();
  });
  const rows = async (run: string) =>
    (
      await env.PRIVATE_DB.prepare(
        'SELECT * FROM personal_daily_observations WHERE run_id=? ORDER BY record_key',
      )
        .bind(run)
        .all()
    ).results;
  const noHttp = () =>
    vi.fn<typeof fetch>(async () => {
      throw new Error('source HTTP forbidden during saved-response recovery');
    });
  it.each([
    'valid',
    'changed_stage',
    'missing_stage',
    'corrupt_part',
    'foreign_part',
    'forged_part_hash',
  ] as const)(
    'recovers missing capture parts only from an identical immutable projection (%s)',
    async (mode) => {
      const f = await dailyFixture('highreso_public');
      await heartbeat(env, 'highreso_public', gpuTime);
      const get = vi.fn(gpuFetcher('highreso_public', rentalHtml(10)));
      expect(
        (
          await collectDaily(env, f.c, f.pin, {
            now: () => gpuTime,
            allow_network: true,
            fetcher: get,
          })
        ).state,
      ).toBe('partial');
      const run = await dailyRunId('highreso_public', gpuTime.slice(0, 10), 'synthetic'),
        root = dailyRoot('highreso_public') + 'evidence/' + run,
        pointer = root + '.json',
        stage = root + '/projection.json',
        pointerText = await (await env.EVIDENCE.get(pointer))!.text(),
        stageText = await (await env.EVIDENCE.get(stage))!.text(),
        manifest = JSON.parse(pointerText) as { parts: { key: string; sha256: string }[] },
        part = manifest.parts[0].key,
        original = (await env.EVIDENCE.get(part))!,
        partText = await original.text(),
        before = await rows(run);
      expect(before).toHaveLength(19);
      await env.EVIDENCE.delete(part);
      if (mode === 'changed_stage') {
        const changed = JSON.parse(stageText);
        changed.payload_hash = 'b'.repeat(64);
        await env.EVIDENCE.put(stage, stable(changed));
      } else if (mode === 'missing_stage') await env.EVIDENCE.delete(stage);
      else if (mode === 'corrupt_part') await env.EVIDENCE.put(part, 'synthetic corrupt part');
      else if (mode === 'foreign_part') {
        manifest.parts[0].key = dailyRoot('rebro_public') + 'foreign.json';
        await env.EVIDENCE.put(pointer, stable(manifest));
      } else if (mode === 'forged_part_hash') {
        manifest.parts[0].sha256 = 'c'.repeat(64);
        await env.EVIDENCE.put(pointer, stable(manifest));
      }
      const forbidden = noHttp();
      const resumed = collectDaily(
        env,
        f.c,
        f.pin,
        { now: () => gpuTime, allow_network: true, fetcher: forbidden },
        gpuTime.slice(0, 10),
      );
      if (mode === 'valid') {
        expect((await resumed).state).toBe('complete');
        const restored = (await env.EVIDENCE.get(part))!;
        expect(await restored.text()).toBe(partText);
        expect(restored.customMetadata).toEqual(original.customMetadata);
        expect(await (await env.EVIDENCE.get(pointer))!.text()).toBe(pointerText);
        expect(await (await env.EVIDENCE.get(stage))!.text()).toBe(stageText);
        const after = await rows(run);
        expect(after).toHaveLength(20);
        for (const old of before)
          expect(after.find((r) => r.observation_id === old.observation_id)).toEqual(old);
      } else {
        await expect(resumed).rejects.toThrow('daily_capture_failed');
        expect(await rows(run)).toEqual(before);
        expect(
          await env.PRIVATE_DB.prepare('SELECT state FROM personal_daily_runs WHERE run_id=?')
            .bind(run)
            .first('state'),
        ).toBe('partial');
        if (mode !== 'corrupt_part') expect(await env.EVIDENCE.get(part)).toBeNull();
      }
      expect(get).toHaveBeenCalledTimes(3);
      expect(forbidden).not.toHaveBeenCalled();
    },
  );
  async function resume(f: Fixture, at: string) {
    const get = noHttp();
    const r = await collectDaily(
      env,
      f.c,
      f.pin,
      { now: () => at.slice(0, 10) + 'T01:05:00.000Z', allow_network: true, fetcher: get },
      at.slice(0, 10),
    );
    expect(r.state).toBe('complete');
    expect(get).not.toHaveBeenCalled();
  }

  it('upgrades a populated legacy checkpoint with not_seen and preserves original evidence, rows and timestamps', async () => {
    const f = await dailyFixture('highreso_public');
    await day(env, f, gpuTime, rentalHtml(2));
    const at = '2026-10-19T01:00:00.000Z';
    const old = await seedLegacy(env, f, at, rentalHtml(1), true),
      before = await rows(old.run);
    await resume(f, at);
    expect(await (await env.EVIDENCE.get(old.key))!.text()).toBe(old.text);
    const result = await rows(old.run);
    expect(result).toHaveLength(4);
    expect(result.find((r) => r.observation_id === before[0].observation_id)).toEqual(before[0]);
    expect(result.filter((r) => r.change_kind === 'not_seen')).toHaveLength(2);
    expect(
      result
        .filter((r) => r.change_kind === 'not_seen')
        .every((r) => r.domain_json === null && r.record_hash === null),
    ).toBe(true);
    await resume(f, at);
    expect(await rows(old.run)).toEqual(result);
    // Existing v1 artifacts remain immutable; this previously partial run gets
    // the v2 export including the original row's earlier recorded_at.
    await exportDailyHistory(env, 'highreso_public', '2026-10-19T02:00:00.000Z');
    await exportDailyHistory(env, 'highreso_public', '2026-10-19T02:00:00.000Z');
    const m = DailyManifest.parse(
      await dailyJSON(env.EVIDENCE, dailyRoot('highreso_public') + 'runs/' + old.run + '.json'),
    );
    const chunks = await Promise.all(
      m.chunks.map(
        async (p) => new Uint8Array(await (await env.EVIDENCE.get(p.key))!.arrayBuffer()),
      ),
    );
    expect(await validateDailySnapshot(JSON.parse(Buffer.concat(chunks).toString()))).toMatchObject(
      {
        version: 'daily-history-v2',
        coverage: { seen_count: 2, not_seen_count: 2, event_count: 4 },
      },
    );
  });

  it('never links a resumed legacy capture across GPU-count cohorts or infers their disappearance', async () => {
    const f = await dailyFixture('highreso_public');
    await day(env, f, gpuTime, rentalHtml(1));
    const c = structuredClone(f.c);
    if (c.config.scope.kind === 'highreso_public') c.config.scope.gpu_counts = [2];
    c.config_sha256 = await hash(stable(c.config));
    const next = { c, pin: { ...f.pin, contract_hash: await hash(stable(c)) } };
    const at = '2026-10-19T01:00:00.000Z',
      old = await seedLegacy(env, next, at, rentalHtml(1, 'instance', 2));
    await resume(next, at);
    expect((await rows(old.run)).map((r) => [r.change_kind, r.previous_observation_id])).toEqual([
      ['first_seen', null],
      ['first_seen', null],
    ]);
  });

  it('resumes legacy reappearance through the v2 event union, pointing to the last not_seen', async () => {
    const f = await dailyFixture('highreso_public');
    await day(env, f, gpuTime, rentalHtml(1));
    await day(env, f, '2026-10-19T01:00:00.000Z', rentalHtml(0));
    const at = '2026-10-20T01:00:00.000Z',
      old = await seedLegacy(env, f, at, rentalHtml(1));
    await resume(f, at);
    for (const r of await rows(old.run)) {
      expect(r.change_kind).toBe('reappeared');
      expect(
        await env.PRIVATE_DB.prepare(
          'SELECT change_kind FROM personal_daily_observations WHERE observation_id=?',
        )
          .bind(r.previous_observation_id)
          .first('change_kind'),
      ).toBe('not_seen');
    }
  });

  it('holds incompatible prewritten legacy lineage instead of rewriting it or certifying a false complete run', async () => {
    const f = await dailyFixture('highreso_public');
    await day(env, f, gpuTime, rentalHtml(1));
    const c = structuredClone(f.c);
    if (c.config.scope.kind === 'highreso_public') c.config.scope.gpu_counts = [2];
    c.config_sha256 = await hash(stable(c.config));
    const next = { c, pin: { ...f.pin, contract_hash: await hash(stable(c)) } };
    const at = '2026-10-19T01:00:00.000Z',
      old = await seedLegacy(env, next, at, rentalHtml(1, 'instance', 2), true);
    const before = await rows(old.run),
      get = noHttp();
    await expect(
      collectDaily(
        env,
        next.c,
        next.pin,
        { now: () => at, allow_network: true, fetcher: get },
        at.slice(0, 10),
      ),
    ).rejects.toThrow('daily_capture_failed');
    expect(await rows(old.run)).toEqual(before);
    expect(
      await env.PRIVATE_DB.prepare('SELECT state,reason FROM personal_daily_runs WHERE run_id=?')
        .bind(old.run)
        .first(),
    ).toEqual({ state: 'partial', reason: 'daily_legacy_observation_conflict' });
    expect(get).not.toHaveBeenCalled();
  });

  it.each(['transient', 'ambiguous', 'persistent', 'revoked', 'after_stage_read'] as const)(
    'handles %s first evidence writes without increasing source GETs or overwriting evidence',
    async (mode) => {
      const f = await dailyFixture('highreso_public');
      await heartbeat(env, 'highreso_public', gpuTime);
      let puts = 0,
        interruptedRead = false;
      const bucket = new Proxy(env.EVIDENCE, {
        get(target, key) {
          const v = Reflect.get(target, key);
          if (key === 'get' && mode === 'after_stage_read')
            return async (objectKey: string, ...args: any[]) => {
              if (
                puts > 0 &&
                !interruptedRead &&
                /^personal-daily\/highreso_public\/evidence\/[a-f0-9]{64}\.json$/.test(objectKey)
              ) {
                interruptedRead = true;
                throw new Error('synthetic pointer read interruption');
              }
              return Reflect.apply(v, target, [objectKey, ...args]);
            };
          return key === 'put'
            ? async (key: string, ...args: any[]) => {
                if (key.endsWith('/projection.json')) {
                  puts++;
                  if (mode === 'persistent' || (mode === 'transient' && puts < 3))
                    throw new Error('synthetic transient R2');
                  if (mode === 'ambiguous' && puts === 1) {
                    await Reflect.apply(v, target, [key, ...args]);
                    throw new Error('synthetic lost ACK');
                  }
                  if (mode === 'revoked' && puts === 1) {
                    await target.put(
                      dailyRoot('highreso_public') + 'revoked.json',
                      stable({ at: gpuTime }),
                    );
                    throw new Error('synthetic interruption');
                  }
                }
                return Reflect.apply(v, target, [key, ...args]);
              }
            : typeof v === 'function'
              ? v.bind(target)
              : v;
        },
      });
      const get = vi.fn(gpuFetcher('highreso_public', rentalHtml(1)));
      const run = collectDaily({ ...env, EVIDENCE: bucket }, f.c, f.pin, {
        now: () => gpuTime,
        allow_network: true,
        fetcher: get,
      });
      if (mode === 'persistent' || mode === 'revoked') {
        await expect(run).rejects.toThrow('daily_capture_failed');
        expect(
          await env.PRIVATE_DB.prepare(
            'SELECT state,record_count FROM personal_daily_runs',
          ).first(),
        ).toEqual({ state: 'failed', record_count: null });
        expect(
          await env.PRIVATE_DB.prepare('SELECT COUNT(*) n FROM personal_daily_observations').first(
            'n',
          ),
        ).toBe(0);
      } else if (mode === 'after_stage_read') {
        await expect(run).rejects.toThrow('daily_capture_failed');
        expect(
          await env.PRIVATE_DB.prepare('SELECT state FROM personal_daily_runs').first('state'),
        ).toBe('partial');
        expect(
          (
            await collectDaily({ ...env, EVIDENCE: bucket }, f.c, f.pin, {
              now: () => gpuTime,
              allow_network: true,
              fetcher: get,
            })
          ).state,
        ).toBe('complete');
        expect(interruptedRead).toBe(true);
      } else expect((await run).state).toBe('complete');
      expect(puts).toBe(
        mode === 'ambiguous' || mode === 'revoked' ? 1 : mode === 'after_stage_read' ? 2 : 3,
      );
      expect(get).toHaveBeenCalledTimes(3);
      if (mode === 'persistent') {
        await collectDaily(env, f.c, f.pin, {
          now: () => gpuTime,
          allow_network: true,
          fetcher: get,
        });
        expect(get).toHaveBeenCalledTimes(3);
      }
    },
  );
});
