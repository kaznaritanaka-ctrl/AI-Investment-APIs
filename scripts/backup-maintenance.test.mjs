import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { packageBackup, verifyBackup } from './backup-package.mjs';
import {
  applyMaintenance,
  initializeBackupRoot,
  planDigest,
  planMaintenance,
} from './backup-maintenance.mjs';

const NOW = Date.parse('2026-10-08T01:00:00.000Z');
const DAY = 86400000;
const iso = (n) => new Date(n).toISOString();
const sha = (s) => createHash('sha256').update(s).digest('hex');
async function rootFixture() {
  await mkdir('work/backup-tests', { recursive: true });
  const base = await mkdtemp(resolve('work/backup-tests/maintenance-'));
  const root = join(base, 'snapshots');
  await mkdir(root, { mode: 0o700 });
  await initializeBackupRoot(root);
  return { base, root };
}

async function snapshot(f, captured, expires) {
  const binary = process.env.AGE_BINARY;
  assert.ok(binary, 'A verified real age binary is required.');
  const id = 'backup-' + iso(captured).replace(/[^0-9]/g, '') + '-' + randomUUID();
  const dest = join(f.root, id),
    input = join(f.base, id + '-input');
  await mkdir(dest, { mode: 0o700 });
  await mkdir(join(input, 'd1'), { recursive: true });
  const keygen = spawnSync(
    join(dirname(binary), process.platform === 'win32' ? 'age-keygen.exe' : 'age-keygen'),
    ['-o', join(f.base, id + '.key')],
    { windowsHide: true, stdio: 'pipe' },
  );
  assert.equal(keygen.status, 0);
  const recipient = keygen.stderr.toString().match(/age1[a-z0-9]{58}/)?.[0];
  const text = 'CREATE TABLE synthetic(id TEXT PRIMARY KEY);';
  const files = [];
  for (const name of ['private', 'public']) {
    const path = 'd1/' + name + '.sql';
    await writeFile(join(input, path), text);
    files.push({
      path,
      bytes: Buffer.byteLength(text),
      sha256: sha(text),
      delete_after: iso(expires),
    });
  }
  const audit = {
    schema_version: 'backup-capture-audit-v1',
    captured_at: iso(captured),
    finished_at: iso(captured + 1000),
    delete_after: iso(expires),
    databases_exported: 2,
  };
  await writeFile(join(dest, 'capture-audit.json'), JSON.stringify(audit));
  const result = await packageBackup(
    {
      schema_version: 'backup-input-v1',
      snapshot_id: id,
      captured_at: iso(captured),
      delete_after: iso(expires),
      inventory_complete: true,
      capture_audit_sha256: sha(JSON.stringify(audit)),
      files,
    },
    {
      inputRoot: input,
      outputDir: join(dest, 'encrypted'),
      recipient,
      ageBinary: binary,
      now: captured,
    },
  );
  const receipt = await verifyBackup(join(dest, 'encrypted'), captured);
  await writeFile(
    join(dest, 'status.json'),
    JSON.stringify({
      ...result,
      encrypted_bytes: receipt.files.reduce((n, v) => n + v.bytes, 0),
      plaintext_cleanup_required: false,
    }),
  );
  return { id, dest, receipt };
}

test('expiry plan is non-destructive; reviewed apply deletes only expired captures and leaves current backup byte-identical', async () => {
  const f = await rootFixture();
  const expired = await snapshot(f, NOW - 2 * DAY, NOW - 1000);
  const current = await snapshot(f, NOW - 10000, NOW + DAY);
  const before = await readFile(join(current.dest, 'encrypted/complete.json'));
  const plan = await planMaintenance(f.root, NOW);
  assert.equal(plan.status, 'current');
  assert.equal(plan.expired_count, 1);
  assert.equal(plan.unexpired_count, 1);
  assert.equal(plan.restore_verified, false);
  assert.equal(plan.offsite_verified, false);
  assert.equal((await readdir(f.root)).length, 3);
  await assert.rejects(() => verifyBackup(join(expired.dest, 'encrypted'), NOW), /expired/);
  const result = await applyMaintenance(f.root, plan, planDigest(plan), NOW);
  assert.deepEqual(result.deleted, [expired.id]);
  assert.deepEqual(await readFile(join(current.dest, 'encrypted/complete.json')), before);
  assert.deepEqual((await readdir(f.root)).sort(), ['.backup-root.json', current.id].sort());
  await assert.rejects(() => applyMaintenance(f.root, plan, planDigest(plan), NOW), /changed/);
});

test('empty, stale and expired-only inventories are not current or restored', async () => {
  const f = await rootFixture();
  assert.equal((await planMaintenance(f.root, NOW)).status, 'missing');
  await snapshot(f, NOW - 2 * DAY, NOW + DAY);
  const stale = await planMaintenance(f.root, NOW);
  assert.equal(stale.status, 'stale');
  assert.equal(stale.latest_captured_at, iso(NOW - 2 * DAY));
  assert.equal((await planMaintenance(f.root, NOW + 2 * DAY)).status, 'missing');
});

test('a capture lock blocks maintenance; initialization cannot adopt a nonempty directory', async () => {
  const f = await rootFixture();
  await assert.rejects(() => initializeBackupRoot(f.root), /empty/);
  await writeFile(join(f.root, '.capture.lock'), 'synthetic-owner');
  await assert.rejects(() => planMaintenance(f.root, NOW), /locked/);
  assert.equal(await readFile(join(f.root, '.capture.lock'), 'utf8'), 'synthetic-owner');
});

test('new files, altered ciphertext and incomplete captures block deletion rather than being skipped', async () => {
  for (const change of ['unknown', 'cipher', 'incomplete']) {
    const f = await rootFixture();
    const item = await snapshot(f, NOW - 2 * DAY, NOW - 1000);
    const plan = await planMaintenance(f.root, NOW);
    if (change === 'unknown') await writeFile(join(item.dest, 'operator-notes.txt'), 'keep');
    if (change === 'cipher')
      await writeFile(join(item.dest, 'encrypted', item.receipt.files[0].name), 'tampered');
    if (change === 'incomplete')
      await writeFile(join(item.dest, 'status.json'), '{"status":"failed"}');
    await assert.rejects(
      () => applyMaintenance(f.root, plan, planDigest(plan), NOW),
      /changed_or_blocked/,
    );
    const revised = await planMaintenance(f.root, NOW);
    assert.equal(revised.status, 'attention_required');
    assert.equal(revised.blocked_count, 1);
    await assert.rejects(
      () => applyMaintenance(f.root, revised, planDigest(revised), NOW),
      /blocked/,
    );
    assert.ok((await readdir(f.root)).includes(item.id));
  }
});

test('root identity, review hash, expiry window and exact inventory must match', async () => {
  const f = await rootFixture(),
    other = await rootFixture();
  const item = await snapshot(f, NOW - 2 * DAY, NOW - 1000);
  const plan = await planMaintenance(f.root, NOW);
  for (const [root, digest, time] of [
    [f.root, '0'.repeat(64), NOW],
    [f.root, planDigest(plan), NOW + 31 * 60000],
    [f.root, planDigest(plan), NOW - 1],
    [other.root, planDigest(plan), NOW],
  ])
    await assert.rejects(() => applyMaintenance(root, plan, digest, time));
  const forged = structuredClone(plan);
  forged.snapshots[0].files[0].path = '../../outside';
  await assert.rejects(() => applyMaintenance(f.root, forged, planDigest(forged), NOW), /changed/);
  await snapshot(f, NOW - 10000, NOW + DAY);
  await assert.rejects(() => applyMaintenance(f.root, plan, planDigest(plan), NOW), /changed/);
  assert.ok((await readdir(f.root)).includes(item.id));
});

test('hardlinked files and junction/symlink roots are rejected without touching the target', async () => {
  const f = await rootFixture();
  const item = await snapshot(f, NOW - 2 * DAY, NOW - 1000);
  const path = join(item.dest, 'encrypted', item.receipt.files[0].name);
  await link(path, join(f.base, 'outside-linked.age'));
  assert.equal((await planMaintenance(f.root, NOW)).blocked_count, 1);
  const alias = join(f.base, 'alias');
  await symlink(f.root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(() => planMaintenance(alias, NOW), /unsafe/);
  assert.ok((await readFile(path)).length > 0);
});

test('unrecognized names are never echoed; CLI signals missing backup without implying success', async () => {
  const f = await rootFixture();
  const output = join(f.base, 'plan.json');
  const cli = spawnSync(
    process.execPath,
    ['scripts/backup-maintenance.mjs', 'plan', f.root, output],
    { windowsHide: true, encoding: 'utf8' },
  );
  assert.equal(cli.status, 2);
  assert.equal(JSON.parse(cli.stdout).status, 'missing');
  await writeFile(join(f.root, 'private-sentinel-token'), 'not a backup');
  const plan = await planMaintenance(f.root, NOW);
  assert.equal(plan.status, 'attention_required');
  assert.ok(!JSON.stringify(plan).includes('private-sentinel-token'));
});
