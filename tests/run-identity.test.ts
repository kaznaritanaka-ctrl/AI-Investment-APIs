import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { localEnv } from '../scripts/local-env';
import { collectSource } from '../src/pipeline';
import { watchdog } from '../src/operations';
import { syncSource } from '../src/publication';
import { hash } from '../src/util';
import { collectionIdentity, dailyCollectionSlot, minuteSlot } from '../src/run-identity';
import { source, fxFetch, time } from './helpers';

let local: Awaited<ReturnType<typeof localEnv>>;
// The reliability fix must work on production's 0001/0002 schema, without P0.
beforeEach(async () => {
  local = await localEnv('test', undefined, 2);
});
afterEach(async () => {
  await local?.mf.dispose();
});
const seconds = '2026-10-03T18:17:35.000Z';
const later = '2026-10-03T18:47:35.000Z';
const count = (table: string) =>
  local.env.PRIVATE_DB.prepare('SELECT COUNT(*) AS n FROM ' + table).first<number>('n');
async function legacy(state = 'pending') {
  await syncSource(local.env, source('ecb'), seconds);
  const id = await hash('ecb|' + seconds);
  await local.env.PRIVATE_DB.prepare(
    'INSERT INTO collection_runs(run_id,source_id,scheduled_for,state) VALUES (?,?,?,?)',
  )
    .bind(id, 'ecb', seconds, state)
    .run();
  return id;
}

it('matches the 18:17:35 collector to the watchdog logical 18:17:00 slot', async () => {
  const fetcher = vi.fn(fxFetch());
  const result = await collectSource(local.env, source('ecb'), seconds, {
    synthetic: true,
    now: () => seconds,
    network: { fetcher },
  });
  expect(result.state).toBe('complete');
  const checked = await watchdog(local.env, [source('ecb')], time, later);
  expect(checked[0].state).toBe('complete');
  expect(checked[0].run_id).toBe(result.run_id);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(result.run_id).toBe(await hash('ecb|' + time));
  const observed = await local.env.PRIVATE_DB.prepare(
    'SELECT observed_at,recorded_at FROM observations LIMIT 1',
  ).first();
  expect(observed).toEqual({ observed_at: seconds, recorded_at: seconds });
});

it('keeps an exact-minute collection id stable', async () => {
  const result = await collectSource(local.env, source('ecb'), time, {
    synthetic: true,
    now: () => seconds,
    network: { fetcher: fxFetch() },
  });
  expect(result.run_id).toBe(await hash('ecb|' + time));
  expect((await watchdog(local.env, [source('ecb')], time, later))[0].state).toBe('complete');
});

it('uses event scheduledTime across minute/day delays, independently of execution wall time', async () => {
  const slot = dailyCollectionSlot('17 18 * * *', Date.parse(seconds));
  expect(slot).toBe(time);
  expect(dailyCollectionSlot('17 18 * * *', Date.parse(later))).toBe(slot);
  expect(dailyCollectionSlot('17 18 * * *', Date.parse('2026-10-04T00:05:35.000Z'))).toBe(slot);
  const delayed = '2026-10-04T00:06:00.000Z';
  const result = await collectSource(local.env, source('ecb'), slot, {
    synthetic: true,
    now: () => delayed,
    network: { fetcher: fxFetch() },
  });
  expect(result.logical_slot).toBe(time);
  expect((await watchdog(local.env, [source('ecb')], slot, delayed))[0].run_id).toBe(result.run_id);
  expect(
    await local.env.PRIVATE_DB.prepare('SELECT observed_at FROM observations LIMIT 1').first(
      'observed_at',
    ),
  ).toBe(delayed);
});

it('is idempotent for concurrent seconds within the same collection slot', async () => {
  const fetcher = vi.fn(fxFetch());
  const opt = { synthetic: true, now: () => later, network: { fetcher } };
  const runs = await Promise.all([
    collectSource(local.env, source('ecb'), seconds, opt),
    collectSource(local.env, source('ecb'), time, opt),
  ]);
  expect(new Set(runs.map((r) => r.run_id)).size).toBe(1);
  expect(runs.every((r) => ['complete', 'in_progress'].includes(r.state))).toBe(true);
  await collectSource(local.env, source('ecb'), seconds, opt);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(await count('collection_runs')).toBe(1);
  expect(await count('observations')).toBe(2);
});

it('recognizes a legacy success ahead of an erroneous missing row without rewriting history', async () => {
  const id = await legacy();
  const fetcher = vi.fn(fxFetch());
  const opt = { synthetic: true, now: () => seconds, network: { fetcher } };
  expect((await collectSource(local.env, source('ecb'), seconds, opt)).run_id).toBe(id);
  await local.env.PRIVATE_DB.prepare(
    "INSERT INTO collection_runs(run_id,source_id,scheduled_for,state,error_code) VALUES (?,?,?,'missing','scheduled_run_missing')",
  )
    .bind(await hash('ecb|' + time), 'ecb', time)
    .run();
  const before = await local.env.PRIVATE_DB.prepare(
    'SELECT * FROM observations ORDER BY observation_id',
  ).all();
  const retry = await collectSource(local.env, source('ecb'), time, { ...opt, now: () => later });
  expect(retry.reason).toBe('already_processed');
  expect(retry.run_id).toBe(id);
  expect((await watchdog(local.env, [source('ecb')], time, later))[0]).toMatchObject({
    run_id: id,
    state: 'complete',
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(await count('collection_runs')).toBe(2);
  expect(
    (await local.env.PRIVATE_DB.prepare('SELECT * FROM observations ORDER BY observation_id').all())
      .results,
  ).toEqual(before.results);
  expect(await local.env.EVIDENCE.head('evidence/ecb/' + id + '.json')).not.toBeNull();
  expect((await local.env.PRIVATE_DB.prepare('PRAGMA foreign_key_check').all()).results).toEqual(
    [],
  );
  await expect(
    local.env.PRIVATE_DB.prepare(
      "UPDATE observations SET observed_at='2026-01-01T00:00:00.000Z'",
    ).run(),
  ).rejects.toThrow();
});

it('preserves a legacy lease and resumes its saved evidence after midnight without HTTP', async () => {
  const id = await legacy();
  const fetcher = vi.fn(fxFetch());
  const initial = await collectSource(local.env, source('ecb'), seconds, {
    synthetic: true,
    now: () => seconds,
    network: { fetcher },
    afterEvidenceSaved: async () => {
      throw new Error('synthetic_interruption');
    },
  });
  expect(initial.state).toBe('failed');
  await local.env.PRIVATE_DB.prepare(
    'UPDATE collection_runs SET lease_until=?,lease_token=? WHERE run_id=?',
  )
    .bind('2026-10-04T00:00:00.000Z', 'synthetic-lease', id)
    .run();
  const held = await collectSource(local.env, source('ecb'), time, {
    synthetic: true,
    now: () => later,
    network: { fetcher },
  });
  expect(held.state).toBe('in_progress');
  expect((await watchdog(local.env, [source('ecb')], time, later))[0].reason).toBe(
    'incomplete_run',
  );
  const recovered = await watchdog(local.env, [source('ecb')], time, '2026-10-04T00:01:00.000Z');
  expect(recovered[0]).toMatchObject({ run_id: id, state: 'complete' });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(await count('fetch_attempts')).toBe(1);
  expect(
    await local.env.PRIVATE_DB.prepare('SELECT scheduled_for FROM collection_runs WHERE run_id=?')
      .bind(id)
      .first('scheduled_for'),
  ).toBe(seconds);
  expect(
    await local.env.PRIVATE_DB.prepare('SELECT observed_at FROM observations LIMIT 1').first(
      'observed_at',
    ),
  ).toBe(seconds);
});

it('reports genuine missing and never accepts another source or day as success', async () => {
  await collectSource(local.env, source('ecb'), seconds, {
    synthetic: true,
    now: () => seconds,
    network: { fetcher: fxFetch() },
  });
  const results = await watchdog(
    local.env,
    [source('ecb'), source('models_dev')],
    '2026-10-04T18:17:00.000Z',
    '2026-10-04T18:47:00.000Z',
  );
  expect(results.map((r) => r.state)).toEqual(['missing', 'missing']);
  expect((await watchdog(local.env, [source('models_dev')], time, later))[0].state).toBe('missing');
  expect(await count('observations')).toBe(2);
});

it('refuses a non-collection namespace instead of treating its success as collection success', async () => {
  await local.env.PRIVATE_DB.prepare(
    "INSERT INTO collection_runs(run_id,source_id,scheduled_for,state) VALUES ('synthetic-other-operation','ecb',?,'complete')",
  )
    .bind(time)
    .run();
  await expect(collectionIdentity(local.env.PRIVATE_DB, 'ecb', time)).rejects.toThrow(
    'collection_run_identity_mismatch',
  );
  expect((await watchdog(local.env, [source('ecb')], time, later))[0].state).toBe('failed');
});

it('validates supported daily UTC schedules and refuses unsafe recovery refetch', async () => {
  for (const cron of ['60 18 * * *', '17 24 * * *', '17 18 * * 1', '* * * * *'])
    expect(() => dailyCollectionSlot(cron, Date.parse(time))).toThrow('invalid_collection_cron');
  expect(() => minuteSlot('not-an-instant')).toThrow('invalid_schedule');
  const fetcher = vi.fn(fxFetch());
  expect(
    (
      await collectSource(local.env, source('ecb'), time, {
        now: () => later,
        savedOnly: true,
        network: { fetcher },
      })
    ).reason,
  ).toBe('saved_evidence_missing');
  expect(fetcher).not.toHaveBeenCalled();
});
