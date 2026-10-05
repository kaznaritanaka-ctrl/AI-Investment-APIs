import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { localEnv } from '../scripts/local-env';
import { collectModels } from '../src/models-pipeline';
import { collectSource } from '../src/pipeline';
import { readOperationalStatus } from '../src/operational-status';
import {
  loadRecoveryEvidence,
  quarantineKey,
  preserveRecoveryEvidence,
  incidentFromMetrics,
  recordRecoveryFailure,
} from '../src/recovery-evidence';
import { expireEvidence } from '../src/operations';
import { catalog, expandedSource, finishModels } from './models-helpers';
import { source, time, responder, fixture } from './helpers';
import { hash, stable } from '../src/util';
import { syncSource } from '../src/publication';
import { recordNotificationSignals } from '../src/notifications';

let local: Awaited<ReturnType<typeof localEnv>>;
beforeEach(async () => {
  local = await localEnv();
  Object.assign(local.env, {
    SCHEMA_RECOVERY_ENABLED: 'true',
    COLLECTION_CRON: '17 18 * * *',
    COLLECTION_ENABLED: 'true',
  });
});
afterEach(async () => {
  await local?.mf.dispose();
});
const at = (n: number) => new Date(Date.parse(time) + n * 60000).toISOString();
const run = async (body: unknown, now = time) =>
  collectModels(local.env, expandedSource(), time, {
    synthetic: true,
    now: () => now,
    network: { fetcher: responder(JSON.stringify(body)) },
  });
const count = (db: D1Database, table: string) =>
  db.prepare('SELECT COUNT(*) n FROM ' + table).first<number>('n');

it('preserves the original permitted fields and time, holds publication and does not reacquire a drifted slot', async () => {
  const s = expandedSource(),
    result = await run({ data: catalog() });
  expect(result).toMatchObject({ state: 'failed', reason: 'schema_drift_detected' });
  const e = await loadRecoveryEvidence(local.env, s, result.run_id, time);
  expect(e).toMatchObject({
    observed_at: time,
    wrapper: 'data',
    complete_projection: true,
    record_count: 5,
  });
  expect(
    await local.env.EVIDENCE.get('evidence/' + s.source_id + '/' + result.run_id + '.json'),
  ).toBeNull();
  expect(await count(local.env.PRIVATE_DB, 'observations')).toBe(0);
  expect(await count(local.env.PUBLIC_DB, 'published_observations')).toBe(0);
  const forbidden = vi.fn();
  const second = await collectModels(local.env, s, time, {
    savedOnly: true,
    synthetic: true,
    now: () => at(10),
    network: { fetcher: forbidden },
  });
  expect(second.reason).toBe('schema_drift_detected');
  expect(forbidden).not.toHaveBeenCalled();
  expect(await loadRecoveryEvidence(local.env, s, result.run_id, at(10))).toEqual(e);
  const report = await readOperationalStatus(local.env, [s], at(11));
  expect(report.overnight.sources[0]).toMatchObject({
    schema_drift: true,
    detected_at: time,
    evidence_state: 'preserved',
    collection_status: 'failed',
    publication_status: 'awaiting_collection',
    missing_observation_count: null,
  });
  expect(report.sources[0].signals).toContainEqual({
    key: 'models_dev:schema_drift',
    condition: 'alert',
    code: 'schema_drift_detected',
  });
  const stored = await local.env.PRIVATE_DB.prepare(
    'SELECT metrics_json FROM collection_runs WHERE run_id=?',
  )
    .bind(result.run_id)
    .first<string>('metrics_json');
  expect(stored).not.toMatch(/SYNTHETIC|Authorization|synthetic-model|description/);
});

it('normal acquisition still completes with capture enabled; unchanged prices remain legitimate observations', async () => {
  const s = expandedSource();
  const first = await finishModels(local.env, s, catalog());
  expect(first.result.state).toBe('complete');
  const next = '2026-10-04T18:17:00.000Z';
  const second = await finishModels(local.env, s, catalog(), next);
  expect(second.result.state).toBe('complete');
  expect(first.calls).toBe(1);
  expect(second.calls).toBe(1);
  expect(await count(local.env.PRIVATE_DB, 'observations')).toBe(20);
  expect(await count(local.env.PRIVATE_DB, 'raw_artifacts')).toBe(4);
  expect((await readOperationalStatus(local.env, [s], next)).overnight.sources[0]).toMatchObject({
    collection_status: 'complete',
    publication_status: 'complete',
    missing_observation_count: 0,
  });
  const recovered = await readOperationalStatus(local.env, [s], at(1));
  expect(recovered.sources[0].signals).toContainEqual({
    key: 'models_dev:schema_drift',
    condition: 'clear',
    code: 'schema_recovery_complete',
  });
  const notifications = { ...local.env, NOTIFICATIONS_ACTIVE_FROM: time };
  await recordNotificationSignals(
    notifications,
    [{ key: 'models_dev:schema_drift', condition: 'alert', code: 'schema_drift_detected' }],
    time,
  );
  const cleared = await recordNotificationSignals(
    notifications,
    recovered.sources[0].signals,
    at(1),
  );
  expect(cleared.events).toContain('models_dev:schema_drift:recovered');
  expect(
    await local.env.PRIVATE_DB.prepare(
      "SELECT active FROM notification_incidents WHERE incident_key='models_dev:schema_drift'",
    ).first<number>('active'),
  ).toBe(0);
});

it('keeps permission gates and default-off behavior, including source suspension during HTTP', async () => {
  local.env.SCHEMA_RECOVERY_ENABLED = undefined;
  const result = await run({ data: catalog() });
  expect(await local.env.EVIDENCE.get(quarantineKey(expandedSource(), result.run_id))).toBeNull();
  local.env.SCHEMA_RECOVERY_ENABLED = 'true';
  const s = expandedSource(),
    slot = at(1);
  const result2 = await collectModels(local.env, s, slot, {
    synthetic: true,
    now: () => slot,
    network: {
      fetcher: (async () => {
        await local.env.PRIVATE_DB.prepare(
          "UPDATE sources SET suspended=1 WHERE source_id='models_dev'",
        ).run();
        return new Response(JSON.stringify(catalog()), {
          headers: { 'content-type': 'application/json' },
        });
      }) as typeof fetch,
    },
  });
  expect(result2.state).toBe('failed');
  expect(await local.env.EVIDENCE.get(quarantineKey(s, result2.run_id))).toBeNull();
  expect(await count(local.env.PRIVATE_DB, 'observations')).toBe(0);
});

it('saves the response before a fetch-attempt D1 failure and classifies the failure without a network retry', async () => {
  const db = local.env.PRIVATE_DB,
    prepare = db.prepare.bind(db);
  local.env.PRIVATE_DB = {
    ...db,
    prepare(sql: string) {
      if (sql.startsWith('INSERT INTO fetch_attempts'))
        return {
          bind() {
            return this;
          },
          async run() {
            throw new Error('SYNTHETIC_SECRET');
          },
        } as unknown as D1PreparedStatement;
      return prepare(sql);
    },
    batch: db.batch.bind(db),
  } as D1Database;
  const fetcher = vi.fn(responder(JSON.stringify(catalog()))),
    s = expandedSource();
  const result = await collectModels(local.env, s, time, {
    synthetic: true,
    now: () => time,
    network: { fetcher },
  });
  expect(result.reason).toBe('attempt_log_failed');
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(await loadRecoveryEvidence(local.env, s, result.run_id, time)).toMatchObject({
    complete_projection: true,
    record_count: 5,
  });
  const metrics = await prepare('SELECT metrics_json FROM collection_runs WHERE run_id=?')
    .bind(result.run_id)
    .first<string>('metrics_json');
  expect(incidentFromMetrics(metrics, result.run_id, s.source_id)).toMatchObject({
    classification: 'storage_or_publication',
    schema_drift: false,
    evidence_state: 'preserved',
  });
});

it('re-registers an orphaned R2 capture with its original expiry and preserves the first response on retries', async () => {
  const s = expandedSource(),
    result = await run({ data: catalog() }),
    e = await loadRecoveryEvidence(local.env, s, result.run_id, time);
  await local.env.PRIVATE_DB.prepare('DELETE FROM raw_artifacts WHERE artifact_ref=?')
    .bind(quarantineKey(s, result.run_id))
    .run();
  const again = await preserveRecoveryEvidence(
    local.env,
    s,
    result.run_id,
    JSON.stringify({ data: catalog(10) }),
    at(20),
    at(20),
    true,
  );
  expect(again).toEqual(e);
  expect(
    await local.env.PRIVATE_DB.prepare('SELECT expires_at FROM raw_artifacts WHERE artifact_ref=?')
      .bind(quarantineKey(s, result.run_id))
      .first<string>('expires_at'),
  ).toBe(e!.expires_at);
  await expireEvidence(local.env, e!.expires_at);
  expect(await local.env.EVIDENCE.get(quarantineKey(s, result.run_id))).toBeNull();
  expect(
    await local.env.PRIVATE_DB.prepare('SELECT state FROM raw_artifacts WHERE artifact_ref=?')
      .bind(quarantineKey(s, result.run_id))
      .first<string>('state'),
  ).toBe('expired');
});

it('does not let stale diagnostic writers overwrite a successor lease or expose source text', async () => {
  const s = expandedSource(),
    result = await run({ data: catalog() });
  await local.env.PRIVATE_DB.prepare(
    "UPDATE collection_runs SET lease_token='successor',lease_until=?,metrics_json='{}' WHERE run_id=?",
  )
    .bind(at(30), result.run_id)
    .run();
  const e = await loadRecoveryEvidence(local.env, s, result.run_id, time);
  await recordRecoveryFailure(
    local.env,
    s,
    result.run_id,
    'stale',
    at(2),
    'projection',
    'schema_drift_detected',
    e,
  );
  const row = await local.env.PRIVATE_DB.prepare(
    'SELECT lease_token,metrics_json FROM collection_runs WHERE run_id=?',
  )
    .bind(result.run_id)
    .first();
  expect(row).toMatchObject({ lease_token: 'successor', metrics_json: '{}' });
});

it('holds the run if R2 capture fails, and records malformed JSON without retaining the unapproved body', async () => {
  const bucket = local.env.EVIDENCE;
  local.env.EVIDENCE = new Proxy(bucket, {
    get(target, key) {
      if (key === 'put')
        return async () => {
          throw new Error('SYNTHETIC_STORAGE_ERROR');
        };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const s = expandedSource(),
    fetcher = vi.fn(responder(JSON.stringify(catalog())));
  const failure = await collectModels(local.env, s, time, {
    synthetic: true,
    now: () => time,
    network: { fetcher },
  });
  expect(failure.reason).toBe('recovery_capture_failed');
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(await count(local.env.PRIVATE_DB, 'observations')).toBe(0);
  local.env.EVIDENCE = bucket;
  const next = '2026-10-04T18:17:00.000Z';
  const malformed = await collectModels(local.env, s, next, {
    synthetic: true,
    now: () => next,
    network: { fetcher: responder('{"SYNTHETIC_UNAPPROVED":') },
  });
  expect(malformed.reason).toBe('schema_drift_detected');
  const saved = await loadRecoveryEvidence(local.env, s, malformed.run_id, next);
  expect(saved).toMatchObject({ body: null, complete_projection: false, record_count: null });
  expect(JSON.stringify(saved)).not.toContain('SYNTHETIC_UNAPPROVED');
  const report = await readOperationalStatus(local.env, [s], next);
  expect(report.overnight.sources[0]).toMatchObject({
    schema_drift: true,
    evidence_state: 'metadata_only',
    remaining_human_action: 'evidence_unavailable_do_not_backfill',
  });
});

it('retains ECB parser failure evidence and rejects a new base instead of silently publishing EUR', async () => {
  const s = source('ecb');
  const malformed = await collectSource(local.env, s, time, {
    synthetic: true,
    now: () => time,
    network: { fetcher: responder('<invalid>', 'application/xml') },
  });
  expect(malformed).toMatchObject({ state: 'failed', reason: 'invalid_xml' });
  expect(await loadRecoveryEvidence(local.env, s, malformed.run_id, time)).toMatchObject({
    raw_response: true,
    body: '<invalid>',
  });
  expect(await local.env.EVIDENCE.get('evidence/ecb/' + malformed.run_id + '.json')).not.toBeNull();
  const next = '2026-10-04T18:17:00.000Z',
    xml = fixture('ecb.synthetic.xml').replace('<Cube>', '<Cube base="USD">');
  const changed = await collectSource(local.env, s, next, {
    synthetic: true,
    now: () => next,
    network: { fetcher: responder(xml, 'application/xml') },
  });
  expect(changed.reason).toBe('schema_drift_detected');
  expect(await count(local.env.PUBLIC_DB, 'published_observations')).toBe(0);
});

it('recognizes legacy seconds-based run identities in the same logical slot', async () => {
  const s = expandedSource(),
    seconds = '2026-10-03T18:17:35.000Z',
    id = await hash(s.source_id + '|' + seconds);
  await syncSource(local.env, s, time);
  // Insert an existing-style synthetic row; do not rewrite established history.
  await local.env.PRIVATE_DB.prepare(
    "INSERT INTO collection_runs(run_id,source_id,scheduled_for,state) VALUES(?,?,?,'pending')",
  )
    .bind(id, s.source_id, seconds)
    .run();
  const result = await collectModels(local.env, s, time, {
    synthetic: true,
    now: () => at(1),
    network: { fetcher: responder(stable({ data: catalog() })) },
  });
  expect(result.run_id).toBe(id);
  const report = await readOperationalStatus(local.env, [s], at(2));
  expect(report.overnight.sources[0]).toMatchObject({ run_id: id, schema_drift: true });
});
