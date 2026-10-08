import { afterEach, describe, expect, it } from 'vitest';
import { localEnv } from '../scripts/local-env';
import { applyMigrations } from '../scripts/migrations';
import { readAdmin, pageContext } from '../src/admin-read';
import { domainFields } from '../src/admin-read-data';
import { AdminQuery, AdminReport, ReleaseRecord } from '../src/admin-contract';
import { collectSource } from '../src/pipeline';
import { recordSummary, watchdog } from '../src/operations';
import { recordNotificationSignals } from '../src/notifications';
import { hash, stable } from '../src/util';
import { sources } from '../src/sources';
import { fxFetch, source, time } from './helpers';
import { expandedSource, catalog, finishModels } from './models-helpers';
import type { CollectorEnv } from '../src/schema';
import { revokeSource } from '../src/publication';
const cleanups: Array<() => Promise<void>> = [];
async function setup(through = Infinity) {
  const local = await localEnv('test', undefined, through);
  cleanups.push(() => local.mf.dispose());
  Object.assign(local.env, {
    COLLECTION_ENABLED: 'true',
    COLLECTION_CRON: '17 18 * * *',
    WATCHDOG_CRON: '47 18 * * *',
    GPU_RESUME_CRON: '*/5 18-23 * * *',
  });
  return local;
}
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
const now = '2026-10-03T19:00:00.000Z';
async function counts(env: CollectorEnv) {
  const out: Record<string, number> = {};
  for (const table of [
    'observations',
    'collection_runs',
    'daily_summaries',
    'notification_outbox',
    'admin_release_ledger',
  ])
    out[table] = (await env.PRIVATE_DB.prepare('SELECT COUNT(*) n FROM ' + table).first<{
      n: number;
    }>())!.n;
  return out;
}
describe('Admin read projection', () => {
  it('preserves fetch outcomes while withholding unknown codes and inconsistent success', async () => {
    const { env } = await setup(),
      s = source('ecb');
    const run = await collectSource(env, s, time, {
      synthetic: true,
      now: () => time,
      network: { fetcher: fxFetch() },
    });
    const cases: Array<[string, number | null, string]> = [
      ['success', 200, 'success'],
      ['revalidated', 304, 'revalidated'],
      ['success', 503, 'unknown'],
      ['revalidated', 200, 'unknown'],
      ['unexpected_content_type', 200, 'unexpected_content_type'],
      ['timeout', null, 'timeout'],
      ['http_401', 401, 'http_401'],
      ['private-sentinel-token', 200, 'unknown'],
    ];
    for (const [index, [code, status]] of cases.entries())
      await env.PRIVATE_DB.prepare(
        'INSERT INTO fetch_attempts(run_id,attempt,started_at,status,code,duration_ms) VALUES(?,?,?,?,?,?)',
      )
        .bind(run.run_id, index + 2, time, status, code, 10)
        .run();
    const before = await counts(env);
    const report = await readAdmin('runs', { run: run.run_id }, env, now, [s]);
    expect(report.state).toBe('ready');
    for (const [index, [, , expected]] of cases.entries())
      expect(report.runs![0].attempts.find((a) => a.attempt === index + 2)?.code).toBe(expected);
    expect(JSON.stringify(report)).not.toContain('private-sentinel-token');
    expect(await counts(env)).toEqual(before);
  });
  it('migrates populated 0003 additively and preserves rows, FKs and immutable triggers', async () => {
    const { env } = await setup(3),
      s = source('ecb');
    await collectSource(env, s, time, {
      synthetic: true,
      now: () => time,
      network: { fetcher: fxFetch() },
    });
    const before = await env.PRIVATE_DB.prepare(
      'SELECT observation_id,observed_at,fingerprint FROM observations ORDER BY observation_id',
    ).all();
    await applyMigrations(env.PRIVATE_DB, 'private');
    expect(
      (
        await env.PRIVATE_DB.prepare(
          'SELECT observation_id,observed_at,fingerprint FROM observations ORDER BY observation_id',
        ).all()
      ).results,
    ).toEqual(before.results);
    expect((await env.PRIVATE_DB.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
    await expect(
      env.PRIVATE_DB.prepare("UPDATE observations SET quality_status='accepted'").run(),
    ).rejects.toThrow(/append-only/);
  });
  it('reads separate collection, publication, watchdog and notification evidence without writes', async () => {
    const { env } = await setup(),
      s = source('ecb');
    const result = await collectSource(env, s, time, {
      synthetic: true,
      now: () => time,
      network: { fetcher: fxFetch() },
    });
    await recordSummary(env, time, [result], time, { process_kind: 'collection' });
    const results = await watchdog(env, [s], time, now);
    await recordSummary(env, time, results, now, { process_kind: 'watchdog', logical_slot: time });
    const before = await counts(env);
    for (const resource of [
      'overview',
      'sources',
      'runs',
      'data',
      'rights',
      'settings',
      'releases',
    ] as const) {
      const report = await readAdmin(
        resource,
        resource === 'runs' ? { run: result.run_id } : {},
        env,
        now,
        [s],
      );
      expect(report.state, resource + ':' + JSON.stringify(report.issues)).toBe('ready');
      expect(AdminReport.safeParse(report).success).toBe(true);
      expect(JSON.stringify(report)).not.toContain('artifact_ref');
      if (resource === 'runs') {
        expect(report.runs![0].attempts[0]).toMatchObject({ status: 200, code: 'success' });
        expect(report.runs![0].publication).toMatchObject({
          state: 'complete',
          original_count: 2,
          derived_count: 1,
          visible_count: 3,
        });
        expect(report.runs![0].invocations.map((x) => x.kind)).toEqual(['watchdog', 'collection']);
        expect(
          report.runs![0].invocations.every(
            (x) => x.notification === 'not_configured' || x.notification === 'not_queued',
          ),
        ).toBe(true);
      }
      if (resource === 'data') {
        expect(report.data).toHaveLength(3);
        expect(report.data!.filter((x) => x.derived)).toHaveLength(1);
        expect(
          report.data!.find((x) => x.derived)!.fields.find((f) => f.name === 'rate_decimal')?.value,
        ).toBeTruthy();
        expect(report.datasets).toContainEqual({
          dataset: 'fx',
          visible_count: 3,
          latest_observed_at: time,
        });
      }
    }
    expect(await counts(env)).toEqual(before);
    const overview = await readAdmin('overview', {}, env, now, [s]);
    const runs = await readAdmin('runs', { run: result.run_id, as_of: overview.as_of }, env, now, [
      s,
    ]);
    expect(overview.overview!.sources[0].last_run!.publication).toEqual(runs.runs![0].publication);
    expect(overview.overview!.completed).toBe(1);
    expect(overview.overview!.published).toBe(1);
    // A public-first emergency stop must be reflected before private suspension completes.
    await env.PUBLIC_DB.prepare(
      'UPDATE source_publications SET active=0,revoked=1 WHERE source_id=?',
    )
      .bind(s.source_id)
      .run();
    const publicStopped = (await readAdmin('rights', {}, env, now, [s])).policies![0];
    expect(publicStopped.collection_allowed).toBe(true);
    expect(publicStopped.publication_allowed).toBe(false);
    expect(publicStopped.blockers).toContain('public_policy_revoked');
    // No source fetch or R2 read can be performed by browsing.
    const readOnlyDB = (db: D1Database) =>
      new Proxy(db, {
        get(target, key) {
          if (key === 'prepare')
            return (sql: string) => {
              expect(sql).toMatch(/^\s*(SELECT|WITH)\b/i);
              expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/i);
              return target.prepare(sql);
            };
          throw new Error('non_read_capability');
        },
      });
    const guarded = {
      ...env,
      PRIVATE_DB: readOnlyDB(env.PRIVATE_DB),
      PUBLIC_DB: readOnlyDB(env.PUBLIC_DB),
      EVIDENCE: new Proxy({} as R2Bucket, {
        get() {
          throw new Error('r2_forbidden');
        },
      }),
    };
    expect((await readAdmin('data', {}, guarded, now, [s])).state).toBe('ready');
    await revokeSource(env, s.source_id);
    const held = await readAdmin('data', {}, env, now, [s]);
    expect(
      held.data!.every((r) => r.public_fields.length === 0 && r.publication.state === 'held'),
    ).toBe(true);
    expect(held.data!.every((r) => !r.private_readable && r.fields.length === 0)).toBe(true);
    const denied = structuredClone(s);
    denied.policy.rights.internal_analysis = 'denied';
    const hidden = await readAdmin('data', {}, env, now, [denied]);
    expect(hidden.data!.every((r) => !r.private_readable && !r.fields.length)).toBe(true);
  });
  it('prefers a seconds-based completed legacy run over a false minute missing row', async () => {
    const { env } = await setup(),
      s = source('ecb'),
      seconds = '2026-10-03T18:17:35.000Z';
    const old = await hash('ecb|' + seconds),
      minute = await hash('ecb|' + time);
    await env.PRIVATE_DB.prepare(
      "INSERT INTO collection_runs(run_id,source_id,scheduled_for,state) VALUES (?,'ecb',?,'complete'),(?,'ecb',?,'missing')",
    )
      .bind(old, seconds, minute, time)
      .run();
    const report = await readAdmin('runs', {}, env, now, [s]);
    expect(report.state).toBe('ready');
    expect(report.runs).toHaveLength(1);
    expect(report.runs![0]).toMatchObject({ run_id: old, logical_slot: time });
    expect(
      (await readAdmin('runs', { run: minute }, env, now, [s])).runs![0].canonical_run_id,
    ).toBe(old);
  });
  it('paginates 125 models without losing records and rejects cursor filter changes', async () => {
    const { env } = await setup(),
      s = expandedSource(['mistral']);
    // Exercise the collector once; seed the remaining synthetic rows in bounded SQL.
    // Collector throughput has its own workerd suite. This test targets read pagination.
    const finished = await finishModels(env, s, catalog(1, ['mistral']));
    expect(finished.result.state).toBe('complete');
    const base = await env.PRIVATE_DB.prepare(
      "SELECT observation_id FROM observations WHERE dataset='ai_model_catalog' LIMIT 1",
    ).first<{ observation_id: string }>();
    await env.PRIVATE_DB.batch([
      env.PRIVATE_DB.prepare(
        "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<124) INSERT INTO observations SELECT 'admin-model-'||i,source_id,policy_version,run_id,dataset,'synthetic-model-'||i,observed_at,recorded_at,'synthetic-fingerprint-'||i,parser_version,quality_status,NULL,metadata_json FROM observations,n WHERE observation_id=?",
      ).bind(base!.observation_id),
      env.PRIVATE_DB.prepare(
        "INSERT INTO ai_model_catalog SELECT o.observation_id,'mistral',o.entity_key,NULL,c.domain_json FROM observations o CROSS JOIN ai_model_catalog c WHERE o.observation_id LIKE 'admin-model-%' AND c.observation_id=?",
      ).bind(base!.observation_id),
      env.PRIVATE_DB.prepare(
        'UPDATE model_snapshots SET model_count=125,enumerated_count=125 WHERE run_id=?',
      ).bind(finished.result.run_id),
    ]);
    const ids: string[] = [];
    let cursor: string | null = null;
    for (let pageNumber = 0; pageNumber < 4; pageNumber++) {
      const result: Awaited<ReturnType<typeof readAdmin>> = await readAdmin(
        'data',
        { source: s.source_id, dataset: 'ai_model_catalog', ...(cursor ? { cursor } : {}) },
        env,
        now,
        [s],
      );
      expect(result.state, JSON.stringify(result.issues)).toBe('ready');
      expect(result.data!.length).toBeLessThanOrEqual(50);
      ids.push(...result.data!.map((x) => x.observation_id));
      cursor = result.next_cursor;
      if (!cursor) break;
    }
    expect(cursor).toBeNull();
    expect(ids).toHaveLength(125);
    expect(new Set(ids).size).toBe(125);
    const first = await readAdmin('data', { dataset: 'ai_model_catalog' }, env, now, [s]);
    await expect(
      readAdmin('data', { dataset: 'ai_api_prices', cursor: first.next_cursor! }, env, now, [s]),
    ).rejects.toThrow('invalid_cursor');
    const detail = await readAdmin('data', { id: ids[0] }, env, now, [s]);
    expect(detail.data![0].private_readable).toBe(true);
    expect(detail.data![0].fields.some((f) => f.name === 'context_limit')).toBe(true);
    const expired = await readAdmin('data', { id: ids[0] }, env, '2031-01-01T00:00:00.000Z', [s]);
    expect(expired.data![0].private_readable).toBe(false);
    expect(expired.data![0].fields).toEqual([]);
    expect(expired.data![0].public_fields).toEqual([]);
    expect(JSON.stringify(detail)).not.toContain('SYNTHETIC forbidden credential');
  }, 120000);
  it('distinguishes private-store failure from empty and exposes no arbitrary exception', async () => {
    const { env } = await setup();
    const bad: CollectorEnv = {
      ...env,
      PRIVATE_DB: {
        prepare() {
          throw new Error('secret-sentinel');
        },
      } as unknown as D1Database,
    };
    const result = await readAdmin('overview', {}, bad, now);
    expect(result.state).toBe('unavailable');
    expect(result.overview).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('secret-sentinel');
  });
  it('projects GPU units, monthly periods and decimal strings without arbitrary payload fields', () => {
    const fields = domainFields({
      amount_decimal: '0.1234567890123456789',
      currency: 'USD',
      billing_unit: 'gpu_hour',
      period: '2026-09',
      Authorization: 'secret',
      evidence_pointer: 'private-key',
      asking_price: '99.00',
      condition: 'used',
    });
    expect(fields).toContainEqual({
      name: 'amount_decimal',
      value: '0.1234567890123456789',
      unit: 'USD / gpu_hour',
    });
    expect(fields.find((x) => x.name === 'period')!.value).toBe('2026-09');
    expect(JSON.stringify(fields)).not.toMatch(/secret|private-key/);
  });
  it('retains null counts and distinguishes disabled/unsupported configuration', async () => {
    const { env } = await setup();
    const sourceReport = await readAdmin('sources', { source: 'electricity' }, env, now, sources);
    expect(sourceReport.sources![0]).toMatchObject({
      adapter_available: false,
      enabled: false,
      latest_observed_at: null,
    });
    expect((await readAdmin('data', { dataset: 'electricity' }, env, now)).state).toBe(
      'not_supported',
    );
    await expect(
      pageContext(AdminQuery.parse({ from: '2026-01-01T00:00:00.000Z', to: now }), 'runs', now),
    ).rejects.toThrow('invalid_query');
  });
  it('keeps notification failure and rights expiry independent from successful collection', async () => {
    const { env } = await setup(),
      s = source('ecb');
    s.policy.valid_until = '2026-10-09T00:00:00.000Z';
    env.ALERT_WEBHOOK_URL = 'https://synthetic.invalid/webhook';
    env.NOTIFICATIONS_ACTIVE_FROM = time;
    const result = await collectSource(env, s, time, {
      synthetic: true,
      now: () => time,
      network: { fetcher: fxFetch() },
    });
    await recordSummary(env, time, [result], time, { process_kind: 'collection' });
    await recordNotificationSignals(
      env,
      [{ key: 'ecb:review', condition: 'alert', code: 'internal_policy_review_within_7_days' }],
      now,
    );
    await env.PRIVATE_DB.prepare(
      "UPDATE notification_outbox SET attempts=3 WHERE state='pending'",
    ).run();
    const report = await readAdmin('overview', {}, env, now, [s]);
    expect(report.overview!.completed).toBe(1);
    expect(report.overview!.published).toBe(1);
    expect(report.overview!.attention.some((x) => x.id.endsWith(':expiry'))).toBe(true);
    expect(report.overview!.attention.some((x) => x.id.endsWith(':notification'))).toBe(true);
    const rights = await readAdmin('rights', {}, env, now, [s]);
    expect(rights.policies![0].expiry).toBe('seven_days');
    delete env.ALERT_WEBHOOK_URL;
    expect(
      (await readAdmin('overview', {}, env, now, [s])).overview!.attention.some((x) =>
        x.id.endsWith(':notification'),
      ),
    ).toBe(false);
  });
  it('keeps public read failures separate and freezes pagination through the current JST end date', async () => {
    const { env } = await setup(),
      s = source('ecb');
    await collectSource(env, s, time, {
      synthetic: true,
      now: () => time,
      network: { fetcher: fxFetch() },
    });
    const bad: CollectorEnv = {
      ...env,
      PUBLIC_DB: {
        prepare() {
          throw new Error('credential-sentinel');
        },
      } as unknown as D1Database,
    };
    const result = await readAdmin('data', {}, bad, now, [s]);
    expect(result.state).toBe('partial');
    expect(result.datasets).toBeUndefined();
    expect(result.data!.every((r) => r.publication.visible_count === null)).toBe(true);
    const summary = (await readAdmin('overview', {}, bad, now, [s])).overview!;
    expect(summary.completed).toBe(1);
    expect(summary.published).toBeNull();
    expect(summary.fresh).toBeNull();
    const context = await pageContext(
      AdminQuery.parse({ from: '2026-10-03T15:00:00.000Z', to: '2026-10-04T14:59:59.999Z' }),
      'runs',
      now,
    );
    expect(context.to).toBe(now);
  });
  it('permits authorized private-only values without implying publication success', async () => {
    const { env } = await setup(),
      s = source('ecb');
    s.policy.rights.public_display = 'denied';
    await collectSource(env, s, time, {
      synthetic: true,
      now: () => time,
      network: { fetcher: fxFetch() },
    });
    const result = await readAdmin('data', {}, env, now, [s]);
    expect(result.data!.length).toBeGreaterThan(0);
    expect(
      result.data!.every(
        (r) => r.private_readable && r.fields.length > 0 && r.public_fields.length === 0,
      ),
    ).toBe(true);
    const overview = await readAdmin('overview', {}, env, now, [s]);
    expect(overview.overview!.completed).toBe(1);
    expect(overview.overview!.published).toBe(0);
    expect(overview.overview!.attention.some((x) => x.page === 'rights')).toBe(true);
  });
  it('does not reuse a later successful run as proof of success before the cutoff', async () => {
    const { env } = await setup(),
      s = source('ecb');
    const r = await collectSource(env, s, time, {
      synthetic: true,
      now: () => time,
      network: { fetcher: fxFetch() },
    });
    await env.PRIVATE_DB.prepare(
      'UPDATE collection_runs SET finished_at=?,last_progress_at=? WHERE run_id=?',
    )
      .bind('2026-10-04T01:00:00.000Z', '2026-10-04T01:00:00.000Z', r.run_id)
      .run();
    const run = (
      await readAdmin('runs', { run: r.run_id, as_of: now }, env, '2026-10-04T02:00:00.000Z', [s])
    ).runs![0];
    expect(run.state).toBe('unavailable_at_as_of');
    expect(run.accepted_count).toBeNull();
    expect(run.finished_at).toBeNull();
    expect(
      (await readAdmin('overview', { as_of: now }, env, '2026-10-04T02:00:00.000Z', [s])).overview!
        .completed,
    ).toBeNull();
  });
});
