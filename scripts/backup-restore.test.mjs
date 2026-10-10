import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { verifySqlRestore, restoreGeneration } from './backup-restore.mjs';
import { packageGeneration } from './backup-generation.mjs';
import { reviewHashes, QUERIES } from './backup-capture.mjs';

const NOW = Date.parse('2026-10-11T00:30:00.000Z');
const iso = (n) => new Date(n).toISOString();
const sha = (v) => createHash('sha256').update(v).digest('hex');
function sqlFixture(which = 'private') {
  const privateSql =
    'PRAGMA foreign_keys=OFF; CREATE TABLE collection_runs(run_id TEXT PRIMARY KEY);' +
    "INSERT INTO collection_runs VALUES('synthetic-run');" +
    'CREATE TABLE observations(observation_id TEXT PRIMARY KEY,source_id TEXT,run_id TEXT REFERENCES collection_runs,' +
    'observed_at TEXT,recorded_at TEXT,fingerprint TEXT);' +
    "INSERT INTO observations VALUES('synthetic-id','ecb','synthetic-run','2026-10-10T18:17:00.000Z','2026-10-10T18:17:01.000Z','unchanged-fingerprint');" +
    'CREATE TABLE fx_observations(observation_id TEXT PRIMARY KEY REFERENCES observations,rate_decimal TEXT);' +
    "INSERT INTO fx_observations VALUES('synthetic-id','1.123456789012345678');" +
    "CREATE TRIGGER immutable_observations BEFORE UPDATE ON observations BEGIN SELECT RAISE(ABORT,'append-only observations'); END;" +
    "CREATE TRIGGER immutable_fx BEFORE UPDATE ON fx_observations BEGIN SELECT RAISE(ABORT,'append-only FX'); END;";
  const publicSql =
    'CREATE TABLE published_observations(observation_id TEXT PRIMARY KEY,source_id TEXT,observed_at TEXT,recorded_at TEXT,public_json TEXT);' +
    "INSERT INTO published_observations VALUES('synthetic-id','ecb','2026-10-10T18:17:00.000Z','2026-10-10T18:17:01.000Z','{\"rate\":\"1.123456789012345678\"}');";
  const sql = which === 'private' ? privateSql : publicSql;
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(sql);
    const schema = db.prepare(QUERIES.schema).all();
    const observationSummary = db
      .prepare(which === 'private' ? QUERIES.observations : QUERIES.public)
      .all();
    return {
      sql,
      expected: {
        which,
        schemaHash: reviewHashes([], { [which]: schema }).schema_sha256[which],
        observationSummary,
      },
    };
  } finally {
    db.close();
  }
}

test('offline SQL restore checks source counts, schema, exact values, FK links and immutable triggers', () => {
  const f = sqlFixture();
  const result = verifySqlRestore(f.sql, f.expected);
  assert.equal(result.status, 'passed');
  assert.equal(result.observation_count, 1);
  assert.equal(result.immutable_verified, 2);
  const exact = { observation_id: 'synthetic-id', rate_decimal: '1.123456789012345678' };
  assert.equal(
    result.table_digests.find((t) => t.table === 'fx_observations').sha256,
    sha(JSON.stringify(exact) + '\n'),
  );
  assert.equal(
    verifySqlRestore(sqlFixture('public').sql, sqlFixture('public').expected).status,
    'passed',
  );
});

test('restore rejects missing records, broken lineage and schema/trigger substitution', () => {
  const f = sqlFixture();
  for (const [sql, expected] of [
    [f.sql.replace("'ecb'", "'models_dev'"), f.expected],
    [
      f.sql.replace(
        "'synthetic-run');CREATE TABLE observations",
        "'different-run');CREATE TABLE observations",
      ),
      f.expected,
    ],
    [f.sql.replace('BEFORE UPDATE', 'AFTER UPDATE'), f.expected],
    [f.sql, { ...f.expected, schemaHash: '0'.repeat(64) }],
  ])
    assert.throws(() => verifySqlRestore(sql, expected), /restore/);
});

test('malicious SQL cannot attach files, load extensions, write files or use unsafe PRAGMAs', () => {
  const f = sqlFixture();
  for (const prefix of [
    "ATTACH DATABASE 'file:outside.sqlite' AS outside;",
    "SELECT load_extension('untrusted');",
    'PRAGMA writable_schema=ON;',
    "VACUUM INTO 'outside.sqlite';",
    'CREATE VIRTUAL TABLE x USING fts5(secret);',
    'SELECT randomblob(1000000000);',
  ])
    assert.throws(() => verifySqlRestore(prefix + f.sql, f.expected));
});

test('real age generation -> restricted worker SQLite restore -> metadata receipt; no original database target', async () => {
  const ageBinary = process.env.AGE_BINARY;
  assert.ok(ageBinary);
  await mkdir('work/backup-tests', { recursive: true });
  const root = await mkdtemp(resolve('work/backup-tests/restore-'));
  const input = join(root, 'input'),
    dest = join(root, 'generation'),
    identityFile = join(root, 'synthetic.key');
  await mkdir(join(input, 'd1'), { recursive: true });
  await mkdir(dest);
  const keygen = spawnSync(
    join(dirname(ageBinary), process.platform === 'win32' ? 'age-keygen.exe' : 'age-keygen'),
    ['-o', identityFile],
    { windowsHide: true, stdio: 'pipe' },
  );
  assert.equal(keygen.status, 0);
  const recipient = keygen.stderr.toString().match(/age1[a-z0-9]{58}/)?.[0];
  const files = [],
    schema_sha256 = {},
    observation_summary = {};
  for (const which of ['private', 'public']) {
    const f = sqlFixture(which),
      path = 'd1/' + which + '.sql';
    await writeFile(join(input, path), f.sql);
    files.push({
      path,
      bytes: Buffer.byteLength(f.sql),
      sha256: sha(f.sql),
      delete_after: iso(NOW + 86400000),
    });
    schema_sha256[which] = f.expected.schemaHash;
    observation_summary[which] = f.expected.observationSummary;
  }
  const snapshot_id = 'synthetic-' + randomUUID();
  const audit = { snapshot_id, schema_sha256, observation_summary };
  await writeFile(join(dest, 'capture-audit.json'), JSON.stringify(audit));
  const result = await packageGeneration(
    {
      schema_version: 'backup-input-v1',
      snapshot_id,
      captured_at: iso(NOW),
      delete_after: iso(NOW + 86400000),
      inventory_complete: true,
      capture_audit_sha256: sha(JSON.stringify(audit)),
      files,
    },
    { inputRoot: input, outputDir: join(dest, 'encrypted'), ageBinary, recipient, now: NOW },
  );
  const report = await restoreGeneration(dest, {
    outputDir: join(root, 'restored'),
    identityFile,
    ageBinary,
    expectedReceiptHash: result.receipt_sha256,
    now: NOW,
  });
  assert.equal(report.status, 'passed');
  assert.equal(report.original_databases_modified, false);
  assert.equal(report.publication_allowed, false);
  assert.equal(report.databases.private.immutable_verified, 2);
  assert.equal(report.cross_database_atomic, false);
});
