import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { highresoIdentityDryRun } from './highreso-identity-links.mjs';

const fromRun = 'a'.repeat(64),
  toRun = '5afcf3ba' + 'b'.repeat(56),
  recordedAt = '2026-10-27T01:00:00.000Z';
function database() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE research_runs(run_id TEXT PRIMARY KEY,source_id TEXT,synthetic INTEGER,state TEXT,scheduled_for TEXT);
    CREATE TABLE research_gpu_observations(observation_id TEXT PRIMARY KEY,run_id TEXT,method_version TEXT,change_kind TEXT,domain_json TEXT);
    INSERT INTO research_runs VALUES ('${fromRun}','highreso_public',0,'complete','2026-10-25T18:17:00.000Z'),('${toRun}','highreso_public',0,'complete','2026-10-26T18:17:00.000Z');`);
  db.exec(readFileSync('migrations/private/0018_research_identity_links.sql', 'utf8'));
  return db;
}
function row(
  db,
  id,
  run,
  instance,
  amount = '123',
  storage = '500',
  kind = run === fromRun ? 'reobserved' : 'first_seen',
) {
  db.prepare('INSERT INTO research_gpu_observations VALUES (?,?,?,?,?)').run(
    id,
    run,
    'domestic-gpu-html-v2',
    kind,
    JSON.stringify({
      instance_id: instance,
      storage_gb: storage,
      identity: { vram_gb: '80' },
      offer: {
        reported_product: 'Artificial A100 80GB',
        gpu_count: 1,
        unit: 'node_hour',
        amount_decimal: amount,
      },
    }),
  );
}
const dry = () => highresoIdentityDryRun({ fromRun, toRun, recordedAt });
test('dry-run pairs duplicates by binary instance order and never writes; inserts are idempotent, scoped and immutable', () => {
  const db = database();
  row(db, 'old-z', fromRun, 'fake-ubs22-z');
  row(db, 'old-a', fromRun, 'fake-ubs22-a');
  row(db, 'new-y', toRun, 'renamed-ubs22-y');
  row(db, 'new-b', toRun, 'renamed-ubs22-b');
  const before = db
    .prepare('SELECT * FROM research_gpu_observations ORDER BY observation_id')
    .all();
  const report = db.prepare(dry()).all();
  const pairs = report.filter((r) => r.status === 'pair');
  assert.deepEqual(
    pairs.map((p) => [p.from_id, p.to_id]),
    [
      ['old-a', 'new-b'],
      ['old-z', 'new-y'],
    ],
  );
  assert.equal(db.prepare('SELECT count(*) n FROM research_identity_links').get().n, 0);
  for (const pair of pairs) {
    db.exec(pair.proposed_sql);
    db.exec(pair.proposed_sql);
  }
  assert.equal(db.prepare('SELECT count(*) n FROM research_identity_links').get().n, 2);
  assert.deepEqual(
    db.prepare('SELECT * FROM research_gpu_observations ORDER BY observation_id').all(),
    before,
  );
  assert.throws(() => db.exec("UPDATE research_identity_links SET basis='other'"), /immutable/);
  assert.throws(() => db.exec('DELETE FROM research_identity_links'), /immutable/);
  assert.throws(
    () =>
      db
        .prepare('INSERT INTO research_identity_links VALUES (?,?,?,?,?,?,?)')
        .run(
          'bad',
          'highreso_public',
          'new-b',
          'old-a',
          'content_match_v1',
          'domestic-gpu-html-v3',
          recordedAt,
        ),
    /scope/,
  );
  db.close();
});
test('unequal counts, missing OS, changed prices, and different storage are reported, never partially linked', () => {
  const db = database();
  row(db, 'a1', fromRun, 'fake-ubs22-a');
  row(db, 'a2', fromRun, 'fake-ubs22-b');
  row(db, 'b1', toRun, 'renamed-ubs22-a');
  row(db, 'p1', fromRun, 'fake-ubs24-a', '500');
  row(db, 'p2', toRun, 'renamed-ubs24-a', '600');
  row(db, 's1', fromRun, 'fake-ubs24-b', '700', '100');
  row(db, 's2', toRun, 'renamed-ubs24-b', '700', '1000');
  row(db, 'x1', fromRun, 'fake-no-os');
  row(db, 'x2', toRun, 'renamed-no-os');
  const report = db.prepare(dry()).all();
  assert.equal(report.filter((r) => r.status === 'pair').length, 0);
  assert.equal(report.filter((r) => r.status.startsWith('unmatched_')).length, 9);
  db.close();
});
test('requires full run IDs, expected incident run prefix, and a fixed timestamp', () => {
  assert.throws(() =>
    highresoIdentityDryRun({ fromRun: "';DELETE FROM research_runs;--", toRun, recordedAt }),
  );
  assert.throws(() => highresoIdentityDryRun({ fromRun, toRun: 'b'.repeat(64), recordedAt }));
  assert.throws(() => highresoIdentityDryRun({ fromRun, toRun, recordedAt: 'now' }));
});

test('forward migration preserves populated Phase 1 history, foreign keys and immutable triggers', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  const dir = 'migrations/private/';
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    if (file === '0018_research_identity_links.sql') {
      db.exec(
        "INSERT INTO research_sources(source_id,policy_version,config_hash) VALUES ('highreso_public','synthetic-policy','synthetic-config')",
      );
      for (const [id, at, kind] of [
        ['synthetic-old', '2026-10-25T18:17:00.000Z', 'reobserved'],
        ['synthetic-new', '2026-10-26T18:17:00.000Z', 'first_seen'],
      ]) {
        db.prepare(
          `INSERT INTO research_runs(run_id,source_id,config_hash,query_hash,policy_version,terms_version,scheduled_for,recorded_at,synthetic,state,evidence_expires_at,normalized_expires_at)
          VALUES (?,'highreso_public','synthetic-config','synthetic-query','synthetic-policy','synthetic-terms',?,?,1,'complete','2026-11-01T00:00:00.000Z','2027-01-01T00:00:00.000Z')`,
        ).run(id, at, at);
        db.prepare(
          `INSERT INTO research_gpu_observations(observation_id,run_id,page_number,record_key,source_url,method_version,observed_at,recorded_at,record_hash,change_kind,domain_json)
          VALUES (?,?,0,?,'https://synthetic.invalid','domestic-gpu-html-v2',?,?,'synthetic-hash',?,'{}')`,
        ).run(id, id, id, at, at, kind);
      }
    }
    db.exec('BEGIN');
    db.exec(readFileSync(dir + file, 'utf8'));
    db.exec('COMMIT');
    if (file === '0001_initial.sql') {
      db.exec(`INSERT INTO collection_runs(run_id,source_id,scheduled_for,state) VALUES ('synthetic-run','synthetic-source','2026-10-01T00:00:00.000Z','complete');
        INSERT INTO observations(observation_id,source_id,policy_version,run_id,dataset,entity_key,observed_at,recorded_at,fingerprint,parser_version,quality_status,metadata_json)
          VALUES ('synthetic-obs','synthetic-source','synthetic-policy','synthetic-run','fx','EUR/USD','2026-10-01T00:00:00.000Z','2026-10-01T00:00:00.000Z','synthetic-hash','v1','accepted','{}');
        INSERT INTO fx_observations VALUES ('synthetic-obs','EUR','USD','1.23','2026-10-01','{}');`);
    }
  }
  assert.equal(db.prepare('SELECT rate_decimal FROM fx_observations').get().rate_decimal, '1.23');
  assert.equal(db.prepare('SELECT count(*) n FROM observations').get().n, 1);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.throws(() => db.exec("UPDATE observations SET fingerprint='changed'"), /append-only/);
  assert.throws(() => db.exec("UPDATE fx_observations SET rate_decimal='0'"), /append-only/);
  assert.equal(
    db
      .prepare(
        "SELECT count(*) n FROM sqlite_master WHERE type='trigger' AND name LIKE 'research_identity_links_%'",
      )
      .get().n,
    3,
  );
  assert.equal(db.prepare('SELECT count(*) n FROM research_gpu_observations').get().n, 2);
  assert.throws(
    () => db.exec("UPDATE research_gpu_observations SET record_key='changed'"),
    /immutable/,
  );
  db.exec(
    "INSERT INTO research_identity_links VALUES ('synthetic-link','highreso_public','synthetic-old','synthetic-new','content_match_v1','domestic-gpu-html-v3','2026-10-27T00:00:00.000Z')",
  );
  assert.throws(
    () => db.exec("DELETE FROM research_gpu_observations WHERE observation_id='synthetic-old'"),
    /retention/,
  );
  db.exec("UPDATE research_runs SET state='purging' WHERE run_id='synthetic-old'");
  db.exec("DELETE FROM research_gpu_observations WHERE observation_id='synthetic-old'");
  assert.equal(db.prepare('SELECT count(*) n FROM research_identity_links').get().n, 1);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  db.close();
});
