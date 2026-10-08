import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  lstat,
  open,
  readdir,
  readFile,
  realpath,
  rmdir,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { verifyBackup } from './backup-package.mjs';

const MARKER = '.backup-root.json';
const ID = /^backup-\d{17}-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const SHA = /^[a-f0-9]{64}$/;
const iso = (n) => new Date(n).toISOString();
const sha = (v) => createHash('sha256').update(v).digest('hex');
const fail = (code) => {
  throw new Error(code);
};

// Operates only on a dedicated, private directory. No credentials or network access.
async function directory(path) {
  if (!isAbsolute(path) || resolve(path) !== path) fail('absolute_canonical_root_required');
  const st = await lstat(path);
  if (!st.isDirectory() || st.isSymbolicLink() || (await realpath(path)) !== path)
    fail('unsafe_directory');
  if (process.platform !== 'win32' && st.mode & 0o077) fail('private_directory_required');
  return path;
}

async function fileInfo(path, maxBytes = 32 * 1024 * 1024 * 1024) {
  const st = await lstat(path);
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.size > maxBytes)
    fail('unsafe_file');
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    bytes += chunk.length;
    if (bytes > maxBytes) fail('file_limit_exceeded');
    hash.update(chunk);
  }
  const after = await lstat(path);
  if (
    bytes !== st.size ||
    after.ino !== st.ino ||
    after.size !== st.size ||
    after.mtimeMs !== st.mtimeMs
  )
    fail('file_changed');
  return { bytes, sha256: hash.digest('hex') };
}

async function json(path, maxBytes = 32 * 1024 * 1024) {
  const info = await fileInfo(path, maxBytes);
  const text = await readFile(path);
  if (text.length !== info.bytes || sha(text) !== info.sha256) fail('file_changed');
  return { value: JSON.parse(text), info };
}

export async function initializeBackupRoot(root) {
  await directory(root);
  if ((await readdir(root)).length) fail('empty_dedicated_root_required');
  const marker = { schema_version: 'backup-root-v1', root_id: randomUUID() };
  await writeFile(join(root, MARKER), JSON.stringify(marker), { flag: 'wx', mode: 0o600 });
  return marker;
}

async function rootMarker(root) {
  await directory(root);
  const { value } = await json(join(root, MARKER), 1024);
  if (
    value.schema_version !== 'backup-root-v1' ||
    !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.root_id)
  )
    fail('root_marker_invalid');
  return value;
}

async function inspect(root, id, now) {
  const base = await directory(join(root, id));
  if ((await readdir(base)).sort().join(',') !== 'capture-audit.json,encrypted,status.json')
    fail('snapshot_incomplete_or_unknown_files');
  const encrypted = await directory(join(base, 'encrypted'));
  const { value: marker, info: completeInfo } = await json(join(encrypted, 'complete.json'));
  const captured = Date.parse(marker.captured_at);
  if (!Number.isFinite(captured) || captured > now || marker.snapshot_id !== id)
    fail('snapshot_identity_or_time_invalid');
  // Verification at capture time is ONLY for expiry inventory. Restore continues
  // to call verifyBackup at the actual current time and rejects expired bundles.
  const receipt = await verifyBackup(encrypted, captured);
  if (
    (await readdir(encrypted)).sort().join(',') !==
    ['complete.json', ...receipt.files.map((f) => f.name)].sort().join(',')
  )
    fail('unlisted_cipher_files');
  const { value: status, info: statusInfo } = await json(join(base, 'status.json'), 16384);
  const { value: audit, info: auditInfo } = await json(join(base, 'capture-audit.json'), 65536);
  if (
    status.status !== 'local_encrypted_only' ||
    status.snapshot_id !== id ||
    status.delete_after !== receipt.delete_after ||
    status.plaintext_cleanup_required !== false ||
    status.encrypted_files !== receipt.files.length ||
    status.encrypted_bytes !== receipt.files.reduce((n, f) => n + f.bytes, 0) ||
    audit.schema_version !== 'backup-capture-audit-v1' ||
    audit.captured_at !== receipt.captured_at ||
    audit.delete_after !== receipt.delete_after ||
    !Number.isFinite(Date.parse(audit.finished_at)) ||
    Date.parse(audit.finished_at) < captured ||
    Date.parse(audit.finished_at) >= Date.parse(receipt.delete_after) ||
    Date.parse(audit.finished_at) > now ||
    audit.databases_exported !== 2
  )
    fail('capture_metadata_mismatch');
  const files = [];
  for (const entry of receipt.files) {
    const actual = await fileInfo(join(encrypted, entry.name));
    if (entry.sha256 !== actual.sha256 || entry.bytes !== actual.bytes) fail('cipher_changed');
    files.push({ path: 'encrypted/' + entry.name, ...actual });
  }
  files.push(
    { path: 'encrypted/complete.json', ...completeInfo },
    { path: 'capture-audit.json', ...auditInfo },
    { path: 'status.json', ...statusInfo },
  );
  files.sort((a, b) => a.path.localeCompare(b.path));
  return {
    snapshot_id: id,
    captured_at: receipt.captured_at,
    delete_after: receipt.delete_after,
    state: Date.parse(receipt.delete_after) <= now ? 'expired' : 'unexpired',
    files,
  };
}

function report(snapshots, blockers, now) {
  const usable = snapshots.filter((s) => s.state === 'unexpired');
  const latest =
    usable
      .map((s) => s.captured_at)
      .sort()
      .at(-1) ?? null;
  const fresh = latest !== null && now - Date.parse(latest) <= 26 * 3600000;
  return {
    status: blockers.length
      ? 'attention_required'
      : !latest
        ? 'missing'
        : fresh
          ? 'current'
          : 'stale',
    latest_captured_at: latest,
    expired_count: snapshots.filter((s) => s.state === 'expired').length,
    unexpired_count: usable.length,
    blocked_count: blockers.length,
    restore_verified: false,
    offsite_verified: false,
    network_used: false,
  };
}

async function scan(root, now, locked) {
  if (!Number.isFinite(now)) fail('invalid_time');
  const marker = await rootMarker(root);
  const entries = (await readdir(root)).sort();
  if (entries.length > 1002) fail('root_inventory_limit');
  if (!locked && entries.includes('.capture.lock')) fail('capture_or_maintenance_locked');
  const snapshots = [],
    blockers = [];
  for (const id of entries) {
    if (id === MARKER || (locked && id === '.capture.lock')) continue;
    if (!ID.test(id)) {
      blockers.push({ code: 'unknown_root_entry' });
      continue;
    }
    try {
      snapshots.push(await inspect(root, id, now));
    } catch {
      blockers.push({ snapshot_id: id, code: 'snapshot_unverified' });
    }
  }
  return {
    schema_version: 'backup-maintenance-plan-v1',
    root_id: marker.root_id,
    inspected_at: iso(now),
    valid_until: iso(now + 30 * 60000),
    snapshots,
    blockers,
    ...report(snapshots, blockers, now),
  };
}

async function withLock(root, action) {
  await rootMarker(root);
  let handle;
  try {
    handle = await open(join(root, '.capture.lock'), 'wx', 0o600);
  } catch {
    fail('capture_or_maintenance_locked');
  }
  try {
    return await action();
  } finally {
    await handle.close();
    await unlink(join(root, '.capture.lock'));
  }
}

export async function planMaintenance(root, now = Date.now()) {
  // Short-lived filesystem lock is the only write during inspection.
  return withLock(root, () => scan(root, now, true));
}

export function planDigest(plan) {
  return sha(JSON.stringify(plan));
}

export async function applyMaintenance(root, plan, expectedDigest, now = Date.now()) {
  if (
    !SHA.test(expectedDigest) ||
    planDigest(plan) !== expectedDigest ||
    plan.schema_version !== 'backup-maintenance-plan-v1' ||
    !Number.isFinite(now) ||
    !Number.isFinite(Date.parse(plan.inspected_at)) ||
    Date.parse(plan.inspected_at) > now ||
    Date.parse(plan.valid_until) <= now ||
    Date.parse(plan.valid_until) !== Date.parse(plan.inspected_at) + 30 * 60000
  )
    fail('reviewed_plan_required');
  return withLock(root, async () => {
    // Reconstruct the entire reviewed plan before the first deletion. Rechecking
    // at its inspection time also detects any intervening capture or tampering.
    const current = await scan(root, Date.parse(plan.inspected_at), true);
    if (planDigest(current) !== expectedDigest || current.blockers.length)
      fail('inventory_changed_or_blocked');
    const expired = current.snapshots.filter((s) => s.state === 'expired');
    for (const snapshot of expired) {
      const base = join(root, snapshot.snapshot_id);
      if (Date.parse(snapshot.delete_after) > now) fail('unexpired_snapshot');
      for (const file of snapshot.files) {
        await directory(root);
        await directory(base);
        await directory(join(base, 'encrypted'));
        const path = join(base, file.path);
        const info = await fileInfo(path);
        if (info.sha256 !== file.sha256 || info.bytes !== file.bytes) fail('file_changed');
        await unlink(path);
      }
      // No recursive deletion: any unexpected remaining entry makes rmdir fail.
      await rmdir(join(base, 'encrypted'));
      await rmdir(base);
    }
    return {
      status: 'expired_snapshots_removed',
      deleted: expired.map((s) => s.snapshot_id),
      reviewed_plan_sha256: expectedDigest,
      restore_verified: false,
      offsite_verified: false,
      network_used: false,
    };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [mode, ...args] = process.argv.slice(2);
    let result;
    if (mode === 'init' && args.length === 1) result = await initializeBackupRoot(resolve(args[0]));
    else if (mode === 'plan' && args.length === 2) {
      const plan = await planMaintenance(resolve(args[0]));
      await writeFile(args[1], JSON.stringify(plan), { flag: 'wx', mode: 0o600 });
      result = {
        status: plan.status,
        latest_captured_at: plan.latest_captured_at,
        expired_count: plan.expired_count,
        unexpired_count: plan.unexpired_count,
        blocked_count: plan.blocked_count,
        plan_sha256: planDigest(plan),
        restore_verified: false,
        offsite_verified: false,
      };
      if (plan.status !== 'current' || plan.expired_count) process.exitCode = 2;
    } else if (
      mode === 'apply' &&
      args.length === 5 &&
      args[0] === '--allow-delete' &&
      args[1] === '--plan-sha256'
    ) {
      const { value: plan } = await json(resolve(args[4]));
      result = await applyMaintenance(resolve(args[3]), plan, args[2]);
    } else fail('invalid_arguments');
    console.log(JSON.stringify(result));
  } catch {
    // Never echo untrusted filenames, body content, audit bookmarks or OS errors.
    console.error(JSON.stringify({ status: 'maintenance_failed', complete: false }));
    process.exitCode = 1;
  }
}
