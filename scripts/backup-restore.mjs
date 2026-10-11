import { createHash } from 'node:crypto';
import { DatabaseSync, constants as C } from 'node:sqlite';
import { readFile, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { decryptGeneration } from './backup-generation.mjs';
import { boundedRead, durableWrite } from './backup-package.mjs';

const sha = (v) => createHash('sha256').update(v).digest('hex');
const stable = (v) =>
  v === null || typeof v !== 'object'
    ? JSON.stringify(v)
    : Array.isArray(v)
      ? '[' + v.map(stable).join(',') + ']'
      : '{' +
        Object.keys(v)
          .sort()
          .map((k) => JSON.stringify(k) + ':' + stable(v[k]))
          .join(',') +
        '}';
const fail = (code) => {
  throw new Error(code);
};
const schemaSql =
  "SELECT name,type,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name";
const quote = (s) => '"' + s.replaceAll('"', '""') + '"';

// No ATTACH, virtual tables, extension loading, filesystem PRAGMAs or arbitrary
// functions are available even if a captured SQL dump has been substituted.
function authorizer(action, a, b, db) {
  if (db && db !== 'main') return C.SQLITE_DENY;
  if (action === C.SQLITE_PRAGMA)
    return [
      'foreign_keys',
      'defer_foreign_keys',
      'integrity_check',
      'foreign_key_check',
      'table_info',
    ].includes(a?.toLowerCase())
      ? C.SQLITE_OK
      : C.SQLITE_DENY;
  if (action === C.SQLITE_FUNCTION)
    return ['count', 'min', 'max', 'like', 'coalesce', 'json_valid', 'typeof', 'length'].includes(
      b?.toLowerCase(),
    )
      ? C.SQLITE_OK
      : C.SQLITE_DENY;
  return [
    C.SQLITE_CREATE_TABLE,
    C.SQLITE_CREATE_INDEX,
    C.SQLITE_CREATE_TRIGGER,
    C.SQLITE_INSERT,
    C.SQLITE_UPDATE,
    C.SQLITE_READ,
    C.SQLITE_SELECT,
    C.SQLITE_TRANSACTION,
    C.SQLITE_SAVEPOINT,
    C.SQLITE_REINDEX,
  ].includes(action) ||
    (action === C.SQLITE_DELETE && a === 'sqlite_sequence')
    ? C.SQLITE_OK
    : C.SQLITE_DENY;
}

export function verifySqlRestore(sql, { which, schemaHash, observationSummary }) {
  if (
    !['private', 'public'].includes(which) ||
    !/^[a-f0-9]{64}$/.test(schemaHash ?? '') ||
    !Array.isArray(observationSummary) ||
    typeof sql !== 'string' ||
    Buffer.byteLength(sql) > 128 * 1024 * 1024
  )
    fail('restore_review_missing_or_limit');
  const db = new DatabaseSync(':memory:', { allowExtension: false });
  try {
    if (typeof db.setAuthorizer !== 'function') fail('restore_requires_node_24_10');
    db.setAuthorizer(authorizer);
    db.exec(sql);
    if (db.isTransaction) fail('restore_uncommitted_transaction');
    db.exec('PRAGMA foreign_keys=ON');
    const schema = db.prepare(schemaSql).all();
    if (sha(stable(schema)) !== schemaHash) fail('restore_schema_mismatch');
    if (
      db
        .prepare('PRAGMA integrity_check')
        .all()
        .some((r) => r.integrity_check !== 'ok') ||
      db.prepare('PRAGMA foreign_key_check').all().length
    )
      fail('restore_database_integrity_failed');
    const table = which === 'private' ? 'observations' : 'published_observations';
    const summary = db
      .prepare(
        'SELECT source_id,COUNT(*) AS n,MIN(observed_at) AS oldest,MAX(recorded_at) AS newest FROM ' +
          table +
          ' GROUP BY source_id ORDER BY source_id',
      )
      .all();
    if (stable(summary) !== stable(observationSummary))
      fail('restore_observation_summary_mismatch');
    let immutableVerified = 0,
      immutableEmpty = 0;
    const protectedTables = [
      ...new Set(
        schema
          .filter(
            (r) =>
              r.type === 'trigger' &&
              /\bBEFORE\s+UPDATE\b/i.test(r.sql) &&
              /RAISE\s*\(\s*ABORT/i.test(r.sql),
          )
          .map((r) => /\bON\s+["\x60\[]?([A-Za-z_][A-Za-z0-9_]*)/i.exec(r.sql)?.[1]),
      ),
    ].filter(Boolean);
    for (const name of protectedTables) {
      const column = db.prepare('PRAGMA table_info(' + quote(name) + ')').all()[0]?.name;
      if (!column) fail('restore_trigger_target_invalid');
      if (!db.prepare('SELECT 1 FROM ' + quote(name) + ' LIMIT 1').get()) {
        immutableEmpty++;
        continue;
      }
      db.exec('SAVEPOINT immutable_probe');
      let blocked = false;
      try {
        db.exec('UPDATE ' + quote(name) + ' SET ' + quote(column) + '=' + quote(column));
      } catch (error) {
        blocked = error.code === 'ERR_SQLITE_ERROR' && /append-only/.test(error.message);
      } finally {
        db.exec('ROLLBACK TO immutable_probe; RELEASE immutable_probe');
      }
      if (!blocked) fail('restore_immutable_trigger_failed');
      immutableVerified++;
    }
    if (which === 'private' && !protectedTables.includes('observations'))
      fail('restore_observations_not_immutable');
    const tables = schema.filter((r) => r.type === 'table').map((r) => r.name);
    const tableDigests = [];
    for (const name of tables) {
      // Values are hashed locally and never returned. Exact decimal strings,
      // IDs, timestamps, JSON and lineage remain in the imported original form.
      const hash = createHash('sha256');
      let rows = 0;
      const columns = db.prepare('PRAGMA table_info(' + quote(name) + ')').all();
      const order = columns
        .filter((c) => c.pk)
        .sort((a, b) => a.pk - b.pk)
        .map((c) => quote(c.name));
      const statement = db.prepare(
        'SELECT * FROM ' +
          quote(name) +
          ' ORDER BY ' +
          (order.join(',') || columns.map((c) => quote(c.name)).join(',')),
      );
      statement.setReadBigInts(true);
      for (const row of statement.iterate()) {
        hash.update(
          JSON.stringify(row, (_key, value) =>
            typeof value === 'bigint' ? { integer: value.toString() } : value,
          ),
        );
        hash.update('\n');
        rows++;
      }
      tableDigests.push({ table: name, rows, sha256: hash.digest('hex') });
    }
    return {
      status: 'passed',
      integrity: 'passed',
      foreign_keys: 'passed',
      schema: 'matched',
      observation_count: summary.reduce((n, r) => n + r.n, 0),
      immutable_verified: immutableVerified,
      immutable_empty_tables: immutableEmpty,
      table_digests: tableDigests,
    };
  } finally {
    db.close();
  }
}

function verifyInWorker(sql, expected) {
  return new Promise((resolveDone, reject) => {
    const worker = new Worker(new URL(import.meta.url), {
      workerData: { sql, expected },
      resourceLimits: { maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 64 },
      env: {},
      stdout: true,
      stderr: true,
    });
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(new Error(error));
      else resolveDone(value);
    };
    const timer = setTimeout(() => {
      void worker.terminate();
      finish('restore_time_limit');
    }, 120000);
    worker.on('message', (value) =>
      value?.status === 'passed' ? finish(null, value) : finish('restore_verification_failed'),
    );
    worker.on('error', () => finish('restore_worker_failed'));
    worker.on('exit', () => {
      if (!settled) finish('restore_worker_failed');
    });
    worker.stdout.resume();
    worker.stderr.resume();
  });
}

export async function restoreGeneration(
  directory,
  { expectedReceiptHash, outputDir, identityFile, ageBinary, now = Date.now() },
) {
  const restored = await decryptGeneration(join(directory, 'encrypted'), {
    expectedReceiptHash,
    outputDir,
    identityFile,
    ageBinary,
    now,
  });
  const auditText = await boundedRead(join(directory, 'capture-audit.json'));
  if (sha(auditText) !== restored.capture_audit_sha256) fail('restore_audit_mismatch');
  const audit = JSON.parse(auditText),
    databases = {};
  for (const which of ['private', 'public']) {
    const entry = restored.files.find((f) => f.path === 'd1/' + which + '.sql');
    if (!entry || (await lstat(entry.restored_path)).size > 128 * 1024 * 1024)
      fail('restore_sql_limit');
    databases[which] = await verifyInWorker(await readFile(entry.restored_path, 'utf8'), {
      which,
      schemaHash: audit.schema_sha256?.[which],
      observationSummary: audit.observation_summary?.[which],
    });
  }
  const report = {
    schema_version: 'backup-restore-result-v1',
    snapshot_id: audit.snapshot_id ?? null,
    receipt_sha256: expectedReceiptHash,
    verified_at: new Date(now).toISOString(),
    status: 'passed',
    databases,
    retained_files_verified: restored.files.length,
    full_inventory_available: restored.full_inventory_available,
    expired_groups: restored.expired_groups,
    cross_database_atomic: false,
    publication_allowed: false,
    original_databases_modified: false,
    plaintext_cleanup_required: true,
  };
  await durableWrite(join(resolve(outputDir), 'restore-result.json'), JSON.stringify(report));
  return report;
}

if (!isMainThread) {
  try {
    parentPort.postMessage(verifySqlRestore(workerData.sql, workerData.expected));
  } catch {
    parentPort.postMessage({ status: 'failed' });
  }
} else if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [flag, digest, directory, output, ...rest] = process.argv.slice(2);
    if (flag !== '--receipt-sha256' || !digest || !directory || !output || rest.length)
      fail('restore_arguments_invalid');
    const result = await restoreGeneration(resolve(directory), {
      expectedReceiptHash: digest,
      outputDir: resolve(output),
      identityFile: process.env.BACKUP_AGE_IDENTITY_FILE,
      ageBinary: process.env.AGE_BINARY,
    });
    // No SQL, identifiers or arbitrary error text leaves the verifier.
    console.log(
      JSON.stringify({
        schema_version: result.schema_version,
        status: result.status,
        receipt_sha256: result.receipt_sha256,
        verified_at: result.verified_at,
        full_inventory_available: result.full_inventory_available,
        expired_groups: result.expired_groups,
        publication_allowed: false,
        plaintext_cleanup_required: true,
      }),
    );
  } catch {
    console.error(
      JSON.stringify({
        status: 'restore_failed',
        publication_allowed: false,
        plaintext_cleanup_required: true,
      }),
    );
    process.exitCode = 1;
  }
}
