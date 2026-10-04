import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { localEnv } from '../scripts/local-env';
import { catalog, expandedSource, finishModels } from './models-helpers';
import { responder, time } from './helpers';
import { collectModels } from '../src/models-pipeline';
import type { CollectorEnv, Source } from '../src/schema';

let local: Awaited<ReturnType<typeof localEnv>>;
beforeEach(async () => {
  local = await localEnv();
});
afterEach(async () => {
  await local?.mf.dispose();
});
const later = (minutes: number) => new Date(Date.parse(time) + minutes * 60000).toISOString();
const resume = (source: Source, env = local.env, clock = () => time, slot = time) =>
  collectModels(env, source, slot, {
    savedOnly: true,
    now: clock,
    network: {
      fetcher: async () => {
        throw new Error('unexpected HTTP');
      },
    },
  });
async function intake(source: Source) {
  const result = await collectModels(local.env, source, time, {
    synthetic: true,
    now: () => time,
    network: { fetcher: responder(JSON.stringify(catalog(2, ['openai']))) },
  });
  expect(result.state).toBe('pending');
  return result.run_id;
}
async function toFinalize(source: Source) {
  await intake(source);
  expect((await resume(source)).state).toBe('pending');
  expect((await resume(source)).state).toBe('pending');
}
function faultDatabase(db: D1Database, fail: (sql: string[]) => void) {
  const queries = new WeakMap<D1PreparedStatement, string>();
  const wrap = (original: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const proxy = new Proxy(original, {
      get(target, key) {
        if (key === 'bind') return (...values: unknown[]) => wrap(target.bind(...values), sql);
        if (key === 'run')
          return async () => {
            fail([sql]);
            return target.run();
          };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    queries.set(proxy, sql);
    return proxy;
  };
  return new Proxy(db, {
    get(target, key) {
      if (key === 'prepare') return (sql: string) => wrap(target.prepare(sql), sql);
      if (key === 'batch')
        return async (items: D1PreparedStatement[]) => {
          fail(items.map((item) => queries.get(item) ?? ''));
          return target.batch(items);
        };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

// Preserve the deployed 1622d2f recovery behavior using the ordinary Collector path,
// with no operations transport, receipts, or unapproved 0004 migration.
describe('deployed Models recovery compatibility', () => {
  it('preserves public completion time when private snapshot finalization fails', async () => {
    const source = expandedSource(['openai']);
    await toFinalize(source);
    let once = true;
    const env = {
      ...local.env,
      PRIVATE_DB: faultDatabase(local.env.PRIVATE_DB, (sql) => {
        if (
          once &&
          sql.some((q) => q.startsWith("UPDATE model_snapshots SET state=?,stage='done'"))
        ) {
          once = false;
          throw new Error('synthetic private failure');
        }
      }),
    };
    expect((await resume(source, env)).state).toBe('failed');
    expect(
      await local.env.PUBLIC_DB.prepare('SELECT completed_at FROM publication_batches').first(),
    ).toEqual({ completed_at: time });
    expect((await resume(source, local.env, () => later(1))).state).toBe('complete');
    expect(
      await local.env.PUBLIC_DB.prepare(
        "SELECT p.completed_at snapshot_time,b.completed_at batch_time,json_extract(p.public_json,'$.completed_at') coverage_time FROM published_model_snapshots p JOIN publication_batches b ON b.batch_id=p.batch_id",
      ).first(),
    ).toEqual({ snapshot_time: time, batch_time: time, coverage_time: time });
    expect(
      await local.env.PRIVATE_DB.prepare('SELECT completed_at FROM model_snapshots').first(),
    ).toEqual({ completed_at: time });
  });

  it('reconciles snapshot done with an interrupted run completion', async () => {
    const source = expandedSource(['openai']);
    await toFinalize(source);
    let once = true;
    const env = {
      ...local.env,
      PRIVATE_DB: faultDatabase(local.env.PRIVATE_DB, (sql) => {
        if (
          once &&
          sql.some((q) => q.startsWith('UPDATE collection_runs SET state=?,finished_at='))
        ) {
          once = false;
          throw new Error('synthetic run failure');
        }
      }),
    };
    expect((await resume(source, env)).state).toBe('failed');
    expect(await local.env.PRIVATE_DB.prepare('SELECT stage FROM model_snapshots').first()).toEqual(
      { stage: 'done' },
    );
    expect(await local.env.PRIVATE_DB.prepare('SELECT state FROM collection_runs').first()).toEqual(
      { state: 'failed' },
    );
    expect((await resume(source, local.env, () => later(1))).state).toBe('complete');
    expect(
      await local.env.PRIVATE_DB.prepare(
        'SELECT state,observation_count,accepted_count FROM collection_runs',
      ).first(),
    ).toEqual({ state: 'complete', observation_count: 4, accepted_count: 4 });
  });

  it('cannot advance a checkpoint or clear a successor lease after archive write takeover', async () => {
    const source = expandedSource(['openai']),
      run = await intake(source);
    let clock = time;
    const env: CollectorEnv = {
      ...local.env,
      EVIDENCE: new Proxy(local.env.EVIDENCE, {
        get(target, key) {
          if (key === 'put')
            return async (...args: Parameters<R2Bucket['put']>) => {
              const result = await target.put(...args);
              if (args[0].startsWith('archive/')) {
                clock = later(11);
                await local.env.PRIVATE_DB.prepare(
                  'UPDATE collection_runs SET lease_token=?,lease_until=? WHERE run_id=?',
                )
                  .bind('successor', later(21), run)
                  .run();
              }
              return result;
            };
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }),
    };
    expect(await resume(source, env, () => clock)).toMatchObject({
      state: 'failed',
      reason: 'operation_lease_lost',
    });
    expect(
      await local.env.PRIVATE_DB.prepare('SELECT cursor,stage FROM model_snapshots').first(),
    ).toEqual({ cursor: 0, stage: 'ingest' });
    expect(
      await local.env.PRIVATE_DB.prepare(
        'SELECT lease_token,recovery_count FROM collection_runs',
      ).first(),
    ).toEqual({ lease_token: 'successor', recovery_count: 0 });
    expect(
      await local.env.PUBLIC_DB.prepare('SELECT state FROM publication_batches').first(),
    ).toEqual({ state: 'staging' });
  });

  it('keeps newer source metadata when an older saved run finishes', async () => {
    const source = expandedSource(['openai']),
      old = await intake(source);
    const tomorrow = '2026-10-04T18:17:00.000Z';
    expect(
      (await finishModels(local.env, source, catalog(2, ['openai']), tomorrow)).result.state,
    ).toBe('complete');
    const before = await local.env.PRIVATE_DB.prepare(
      'SELECT last_success_at,last_artifact_ref,last_count FROM sources',
    ).first();
    for (let i = 0; i < 3; i++) await resume(source, local.env, () => tomorrow);
    expect(
      await local.env.PRIVATE_DB.prepare('SELECT state FROM collection_runs WHERE run_id=?')
        .bind(old)
        .first(),
    ).toEqual({ state: 'complete' });
    expect(
      await local.env.PRIVATE_DB.prepare(
        'SELECT last_success_at,last_artifact_ref,last_count FROM sources',
      ).first(),
    ).toEqual(before);
  });

  it('rechecks suspension after reading saved R2 evidence before intake persistence', async () => {
    const source = expandedSource(['openai']);
    const interrupted = await collectModels(local.env, source, time, {
      synthetic: true,
      now: () => time,
      network: { fetcher: responder(JSON.stringify(catalog(2, ['openai']))) },
      afterEvidenceSaved: async () => {
        throw new Error('synthetic intake interruption');
      },
    });
    expect(interrupted.state).toBe('failed');
    const env = {
      ...local.env,
      EVIDENCE: new Proxy(local.env.EVIDENCE, {
        get(target, key) {
          if (key === 'get')
            return async (...args: Parameters<R2Bucket['get']>) => {
              const object = await target.get(...args);
              await local.env.PRIVATE_DB.prepare('UPDATE sources SET suspended=1 WHERE source_id=?')
                .bind(source.source_id)
                .run();
              return object;
            };
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }),
    };
    expect(await resume(source, env)).toMatchObject({
      state: 'failed',
      reason: 'source_suspended_or_policy_changed',
    });
    for (const table of ['raw_artifacts', 'model_snapshots', 'observations'])
      expect(await local.env.PRIVATE_DB.prepare('SELECT COUNT(*) n FROM ' + table).first()).toEqual(
        { n: 0 },
      );
  });

  it('checks the shared retry budget at claim even when the earlier read is stale', async () => {
    const source = expandedSource(['openai']),
      run = await intake(source);
    await local.env.PRIVATE_DB.prepare('UPDATE collection_runs SET recovery_count=2 WHERE run_id=?')
      .bind(run)
      .run();
    let interleaved = false;
    const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
      new Proxy(statement, {
        get(target, key) {
          if (key === 'bind') return (...values: unknown[]) => wrap(target.bind(...values));
          if (key === 'first')
            return async () => {
              const stale = await target.first();
              if (!interleaved) {
                interleaved = true;
                await local.env.PRIVATE_DB.prepare(
                  'UPDATE collection_runs SET recovery_count=3 WHERE run_id=?',
                )
                  .bind(run)
                  .run();
              }
              return stale;
            };
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    const db = new Proxy(local.env.PRIVATE_DB, {
      get(target, key) {
        if (key === 'prepare')
          return (sql: string) => {
            const statement = target.prepare(sql);
            return sql.startsWith('SELECT state,next_attempt_at,recovery_count')
              ? wrap(statement)
              : statement;
          };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    expect(await resume(source, { ...local.env, PRIVATE_DB: db })).toMatchObject({
      state: 'failed',
      reason: 'recovery_exhausted',
    });
    expect(interleaved).toBe(true);
    expect(
      await local.env.PRIVATE_DB.prepare('SELECT COUNT(*) n FROM observations').first(),
    ).toEqual({ n: 0 });
  });
});
