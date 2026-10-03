import { afterEach, expect, it, vi } from 'vitest';
import { localEnv } from '../scripts/local-env';
import { collectModels, resumeModelRuns } from '../src/models-pipeline';
import { syncSource } from '../src/publication';
import { catalog, expandedSource, finishModels } from './models-helpers';
import { hash } from '../src/util';
import { time, responder } from './helpers';

let local: Awaited<ReturnType<typeof localEnv>>;
afterEach(async () => {
  await local?.mf.dispose();
});
it('resumes a P0 legacy seconds-based checkpoint across midnight with the same evidence and snapshot', async () => {
  local = await localEnv();
  const s = expandedSource(),
    seconds = '2026-10-03T18:17:35.000Z';
  const run = await hash(s.source_id + '|' + seconds);
  await syncSource(local.env, s, seconds);
  await local.env.PRIVATE_DB.prepare(
    'INSERT INTO collection_runs(run_id,source_id,scheduled_for,state) VALUES (?,?,?,?)',
  )
    .bind(run, s.source_id, seconds, 'pending')
    .run();
  const fetcher = vi.fn(responder(JSON.stringify(catalog())));
  expect(
    await collectModels(local.env, s, time, {
      synthetic: true,
      now: () => seconds,
      network: { fetcher },
    }),
  ).toMatchObject({ run_id: run, logical_slot: time, state: 'pending' });
  const snapshot = await local.env.PRIVATE_DB.prepare(
    'SELECT snapshot_id,cursor FROM model_snapshots',
  ).first();
  const resumed = await resumeModelRuns(local.env, [s], '2026-10-04T00:01:00.000Z', true);
  expect(resumed[0]).toMatchObject({ run_id: run, logical_slot: time, state: 'pending' });
  expect(
    await local.env.PRIVATE_DB.prepare('SELECT snapshot_id,cursor FROM model_snapshots').first(),
  ).toEqual(snapshot);
  expect(
    await local.env.PRIVATE_DB.prepare('SELECT stage FROM model_snapshots').first('stage'),
  ).toBe('absence');
  expect(
    await local.env.PRIVATE_DB.prepare('SELECT COUNT(*) n FROM ai_model_catalog').first('n'),
  ).toBe(5);
  const finished = await finishModels(local.env, s, catalog(), time, {
    now: () => '2026-10-04T00:02:00.000Z',
    savedOnly: true,
  });
  expect(finished.result).toMatchObject({ run_id: run, state: 'complete', observations: 10 });
  expect(finished.calls).toBe(0);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(
    (
      await collectModels(local.env, s, seconds, {
        now: () => '2026-10-04T00:03:00.000Z',
        savedOnly: true,
      })
    ).reason,
  ).toBe('already_processed');
  expect(
    await local.env.PRIVATE_DB.prepare('SELECT COUNT(*) n FROM collection_runs').first('n'),
  ).toBe(1);
  expect(
    await local.env.PRIVATE_DB.prepare('SELECT COUNT(*) n FROM model_snapshots').first('n'),
  ).toBe(1);
  expect(
    await local.env.PRIVATE_DB.prepare('SELECT DISTINCT observed_at FROM observations').all(),
  ).toMatchObject({ results: [{ observed_at: seconds }] });
  expect((await local.env.PRIVATE_DB.prepare('PRAGMA foreign_key_check').all()).results).toEqual(
    [],
  );
});
