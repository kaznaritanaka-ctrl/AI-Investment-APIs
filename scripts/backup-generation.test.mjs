import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, writeFile, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { packageGeneration, inspectGeneration, decryptGeneration } from './backup-generation.mjs';
import {
  initializeBackupRoot,
  planMaintenance,
  planDigest,
  applyMaintenance,
  inspectBackupRoot,
} from './backup-maintenance.mjs';
import { validatePlan } from './backup-package.mjs';

const NOW = Date.parse('2026-10-11T00:30:00.000Z'),
  DAY = 86400000;
const iso = (n) => new Date(n).toISOString();
const sha = (v) => createHash('sha256').update(v).digest('hex');

async function fixture() {
  const ageBinary = process.env.AGE_BINARY;
  assert.ok(ageBinary, 'Use verified real age; encryption is not mocked');
  await mkdir('work/backup-tests', { recursive: true });
  const root = await mkdtemp(resolve('work/backup-tests/generation-'));
  const snapshots = join(root, 'snapshots');
  await mkdir(snapshots, { mode: 0o700 });
  await initializeBackupRoot(snapshots);
  const id = 'backup-' + iso(NOW).replace(/[^0-9]/g, '') + '-' + randomUUID();
  const dest = join(snapshots, id),
    input = join(root, 'input');
  await mkdir(dest, { mode: 0o700 });
  const identityFile = join(root, 'synthetic.key');
  const keygen = spawnSync(
    join(dirname(ageBinary), process.platform === 'win32' ? 'age-keygen.exe' : 'age-keygen'),
    ['-o', identityFile],
    { windowsHide: true, stdio: 'pipe' },
  );
  assert.equal(keygen.status, 0);
  const recipient = keygen.stderr.toString().match(/age1[a-z0-9]{58}/)?.[0];
  const files = [];
  for (const [path, text, deadline] of [
    ['d1/private.sql', 'CREATE TABLE private_test(id TEXT PRIMARY KEY);', NOW + 30 * DAY],
    ['d1/public.sql', 'CREATE TABLE public_test(id TEXT PRIMARY KEY);', NOW + 30 * DAY],
    [
      'evidence/price_of_compute/synthetic.json',
      '{"synthetic":true,"amount_decimal":"1.0000000000000001"}',
      NOW + 3600000,
    ],
    ['archive/models_dev/synthetic.json', '{"synthetic":true}', NOW + 2 * DAY],
  ]) {
    await mkdir(dirname(join(input, path)), { recursive: true });
    await writeFile(join(input, path), text);
    files.push({
      path,
      bytes: Buffer.byteLength(text),
      sha256: sha(text),
      delete_after: iso(deadline),
    });
  }
  const audit = {
    schema_version: 'backup-capture-audit-v1',
    format: 'backup-generation-v2',
    captured_at: iso(NOW),
    finished_at: iso(NOW + 100),
    delete_after: iso(NOW + 30 * DAY),
    databases_exported: 2,
  };
  await writeFile(join(dest, 'capture-audit.json'), JSON.stringify(audit));
  const plan = {
    schema_version: 'backup-input-v1',
    snapshot_id: id,
    captured_at: iso(NOW),
    delete_after: iso(NOW + 3600000),
    inventory_complete: true,
    capture_audit_sha256: sha(JSON.stringify(audit)),
    files,
  };
  const encrypted = join(dest, 'encrypted');
  const result = await packageGeneration(plan, {
    inputRoot: input,
    outputDir: encrypted,
    recipient,
    ageBinary,
    now: NOW,
  });
  await writeFile(
    join(dest, 'status.json'),
    JSON.stringify({ ...result, plaintext_cleanup_required: false }),
  );
  return { root, snapshots, id, dest, encrypted, result, identityFile, ageBinary, plan };
}

test('separate expiry keeps both DBs after short evidence expiry; decrypt never reads expired evidence', async () => {
  const f = await fixture();
  const checked = await inspectGeneration(f.encrypted, NOW);
  assert.equal(checked.full_inventory_available, true);
  assert.equal(checked.receipt.database_delete_after, iso(NOW + 30 * DAY));
  assert.equal(checked.receipt.full_inventory_until, iso(NOW + 3600000));
  const later = await inspectGeneration(f.encrypted, NOW + 2 * 3600000);
  assert.equal(later.database_available, true);
  assert.equal(later.full_inventory_available, false);
  const out = await decryptGeneration(f.encrypted, {
    outputDir: join(f.root, 'restored'),
    ageBinary: f.ageBinary,
    identityFile: f.identityFile,
    expectedReceiptHash: f.result.receipt_sha256,
    now: NOW + 2 * 3600000,
  });
  assert.equal(out.files.length, 3);
  assert.equal(out.expired_groups, 1);
  assert.equal(out.full_inventory_available, false);
  assert.equal(out.publication_allowed, false);
  assert.ok(!out.files.some((v) => v.path.startsWith('evidence/price_of_compute')));
  assert.ok(out.files.some((v) => v.path === 'd1/private.sql'));
});

test('reviewed expiry removes only elapsed groups and preserves DB ciphertext; later removes the whole elapsed generation', async () => {
  const f = await fixture();
  const checked = await inspectGeneration(f.encrypted, NOW);
  const db = checked.groups.find((g) => g.kind === 'databases');
  const before = await readFile(join(f.encrypted, db.files[0].path));
  const now = NOW + 2 * 3600000;
  const plan = await planMaintenance(f.snapshots, now, { isolateIncomplete: true });
  assert.equal(plan.expired_group_count, 1);
  assert.equal(plan.full_inventory_count, 0);
  assert.equal(plan.status, 'current');
  const result = await applyMaintenance(f.snapshots, plan, planDigest(plan), now);
  assert.equal(result.deleted.length, 0);
  assert.equal(result.deleted_groups.length, 1);
  assert.deepEqual(await readFile(join(f.encrypted, db.files[0].path)), before);
  assert.equal((await inspectGeneration(f.encrypted, now)).database_available, true);
  const end = NOW + 31 * DAY;
  const all = await planMaintenance(f.snapshots, end, { isolateIncomplete: true });
  assert.equal(all.expired_count, 1);
  await applyMaintenance(f.snapshots, all, planDigest(all), end);
  assert.deepEqual(await readdir(f.snapshots), ['.backup-root.json']);
});

test('an incomplete sibling remains untouched while an explicitly scoped plan expires a verified group', async () => {
  const f = await fixture(),
    now = NOW + 2 * 3600000;
  const broken = 'backup-' + iso(NOW).replace(/[^0-9]/g, '') + '-' + randomUUID();
  await mkdir(join(f.snapshots, broken));
  await writeFile(join(f.snapshots, broken, 'status.json'), '{"status":"failed"}');
  const old = await planMaintenance(f.snapshots, now);
  await assert.rejects(() => applyMaintenance(f.snapshots, old, planDigest(old), now), /blocked/);
  const plan = await planMaintenance(f.snapshots, now, { isolateIncomplete: true });
  assert.equal(plan.status, 'attention_required');
  const result = await applyMaintenance(f.snapshots, plan, planDigest(plan), now);
  assert.equal(result.deleted_groups.length, 1);
  assert.equal(result.untouched_blocked_count, 1);
  assert.equal(
    await readFile(join(f.snapshots, broken, 'status.json'), 'utf8'),
    '{"status":"failed"}',
  );
});

test('interrupted expired-group deletion can be replanned from original hashes, but missing live data is blocked', async () => {
  const f = await fixture(),
    now = NOW + 2 * 3600000;
  const checked = await inspectGeneration(f.encrypted, now);
  const expired = checked.groups.find((g) => g.state === 'expired');
  await unlink(join(f.encrypted, expired.files[0].path));
  const plan = await planMaintenance(f.snapshots, now, { isolateIncomplete: true });
  assert.equal(plan.blocked_count, 0);
  await applyMaintenance(f.snapshots, plan, planDigest(plan), now);
  const live = (await inspectGeneration(f.encrypted, now)).groups.find(
    (g) => g.kind === 'databases',
  );
  await unlink(join(f.encrypted, live.files[0].path));
  await assert.rejects(() => inspectGeneration(f.encrypted, now), /incomplete/);
  const unsafe = await planMaintenance(f.snapshots, now, { isolateIncomplete: true });
  assert.equal(unsafe.blocked_count, 1);
  assert.equal(unsafe.snapshots.length, 0);
});

test('restore requires an independently held receipt digest and rejects substitution or unknown group files', async () => {
  const f = await fixture();
  const opts = {
    outputDir: join(f.root, 'restore'),
    ageBinary: f.ageBinary,
    identityFile: f.identityFile,
    now: NOW,
  };
  await assert.rejects(() => decryptGeneration(f.encrypted, opts), /independent_receipt/);
  await assert.rejects(
    () => decryptGeneration(f.encrypted, { ...opts, expectedReceiptHash: '0'.repeat(64) }),
    /mismatch/,
  );
  const group = (await inspectGeneration(f.encrypted, NOW)).groups[0];
  await writeFile(join(f.encrypted, group.group_id, 'private-note'), 'keep');
  await assert.rejects(() => inspectGeneration(f.encrypted, NOW), /unlisted/);
});

test('v2 format never permits source expansion, DB omissions, extended deadlines or artifacts in DB groups', () => {
  const base = {
    schema_version: 'backup-input-v2',
    kind: 'databases',
    group_id: 'g-' + 'a'.repeat(64),
    snapshot_id: 'synthetic',
    captured_at: iso(NOW),
    delete_after: iso(NOW + DAY),
    capture_audit_sha256: 'a'.repeat(64),
    inventory_complete: true,
    files: ['d1/private.sql', 'd1/public.sql'].map((path) => ({
      path,
      sha256: 'b'.repeat(64),
      bytes: 1,
      delete_after: iso(NOW + DAY),
    })),
  };
  validatePlan(base, NOW);
  for (const mutate of [
    (p) => {
      p.files.pop();
    },
    (p) => {
      p.delete_after = iso(NOW + 31 * DAY);
    },
    (p) => {
      p.files[1].path = 'evidence/lambda/secret.json';
    },
    (p) => {
      p.kind = 'artifacts';
    },
    (p) => {
      p.files[0].delete_after = iso(NOW + 2 * DAY);
    },
  ]) {
    const p = structuredClone(base);
    mutate(p);
    assert.throws(() => validatePlan(p, NOW));
  }
});

test('read-only health inventory creates no lock or files and distinguishes missing backup', async () => {
  const f = await fixture();
  const before = await readdir(f.snapshots);
  const result = await inspectBackupRoot(f.snapshots, NOW + 1000);
  assert.equal(result.status, 'current');
  assert.equal(result.restore_verified, false);
  assert.deepEqual(await readdir(f.snapshots), before);
});
