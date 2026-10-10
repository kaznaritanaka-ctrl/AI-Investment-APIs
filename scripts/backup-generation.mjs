import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  boundedRead,
  durableWrite,
  hashFile,
  packageBackup,
  decryptBackup,
  validatePlan,
} from './backup-package.mjs';

const sha = (v) => createHash('sha256').update(v).digest('hex');
const SHA = /^[a-f0-9]{64}$/;
const GROUP = /^g-[a-f0-9]{64}$/;
const DAY = 86400000;
const fail = (code) => {
  throw new Error(code);
};
const groupId = (kind, expiry) => 'g-' + sha(kind + '/' + expiry);
const iso = (v) =>
  typeof v === 'string' &&
  Number.isFinite(Date.parse(v)) &&
  new Date(Date.parse(v)).toISOString() === v;

async function directory(path) {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (await realpath(path)) !== resolve(path))
    fail('unsafe_generation_directory');
}
async function file(path, expected) {
  const st = await lstat(path);
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1) fail('unsafe_generation_file');
  const info = await hashFile(path);
  if (info.bytes !== expected.bytes || info.sha256 !== expected.sha256)
    fail('generation_integrity_failed');
  return info;
}

// v1 remains readable. v2 separates the two-DB recovery point from R2 objects,
// grouping by the already approved absolute expiry, never by a new retention period.
export async function packageGeneration(plan, options) {
  validatePlan(plan, options.now);
  const buckets = new Map();
  for (const entry of plan.files) {
    const kind = entry.path.startsWith('d1/') ? 'databases' : 'artifacts';
    const id = groupId(kind, entry.delete_after);
    if (!buckets.has(id))
      buckets.set(id, { group_id: id, kind, delete_after: entry.delete_after, files: [] });
    buckets.get(id).files.push(entry);
  }
  if (
    [...buckets.values()].filter((g) => g.kind === 'databases').length !== 1 ||
    buckets.size > 4096
  )
    fail('generation_group_limit_or_database_deadline_mismatch');
  const output = resolve(options.outputDir);
  await mkdir(output, { mode: 0o700 });
  const groups = [];
  for (const group of [...buckets.values()].sort((a, b) => a.group_id.localeCompare(b.group_id))) {
    const groupPlan = { ...plan, ...group, schema_version: 'backup-input-v2' };
    await packageBackup(groupPlan, { ...options, outputDir: join(output, group.group_id) });
    const text = await boundedRead(join(output, group.group_id, 'complete.json'));
    groups.push({ group_id: group.group_id, receipt: JSON.parse(text), receipt_sha256: sha(text) });
  }
  const database = groups.find((g) => g.receipt.kind === 'databases').receipt;
  const receipt = {
    schema_version: 'backup-generation-v2',
    snapshot_id: plan.snapshot_id,
    captured_at: plan.captured_at,
    capture_audit_sha256: plan.capture_audit_sha256,
    database_delete_after: database.delete_after,
    full_inventory_until: new Date(
      Math.min(...groups.map((g) => Date.parse(g.receipt.delete_after))),
    ).toISOString(),
    delete_after: new Date(
      Math.max(...groups.map((g) => Date.parse(g.receipt.delete_after))),
    ).toISOString(),
    groups,
  };
  const text = JSON.stringify(receipt);
  if (Buffer.byteLength(text) > 32 * 1024 * 1024) fail('generation_manifest_limit');
  await durableWrite(join(output, 'complete.json'), text);
  return {
    snapshot_id: plan.snapshot_id,
    status: 'local_encrypted_only',
    format: receipt.schema_version,
    delete_after: receipt.delete_after,
    database_delete_after: receipt.database_delete_after,
    full_inventory_until: receipt.full_inventory_until,
    group_count: groups.length,
    encrypted_files: groups.reduce((n, g) => n + g.receipt.files.length, 0),
    encrypted_bytes: groups.reduce(
      (n, g) => n + g.receipt.files.reduce((m, f) => m + f.bytes, 0),
      0,
    ),
    receipt_sha256: sha(text),
    offsite_verified: false,
    restore_verified: false,
  };
}

export function validateGenerationReceipt(receipt) {
  if (
    receipt?.schema_version !== 'backup-generation-v2' ||
    !/^[a-zA-Z0-9_-]{1,80}$/.test(receipt.snapshot_id ?? '') ||
    !iso(receipt.captured_at) ||
    !SHA.test(receipt.capture_audit_sha256 ?? '') ||
    !Array.isArray(receipt.groups) ||
    !receipt.groups.length ||
    receipt.groups.length > 4096
  )
    fail('generation_receipt_invalid');
  let databases = 0,
    total = 0;
  const seen = new Set();
  for (const g of receipt.groups) {
    const r = g.receipt;
    if (
      !GROUP.test(g.group_id ?? '') ||
      seen.has(g.group_id) ||
      !SHA.test(g.receipt_sha256 ?? '') ||
      sha(JSON.stringify(r)) !== g.receipt_sha256 ||
      r?.schema_version !== 'encrypted-backup-v2' ||
      r.group_id !== g.group_id ||
      !['databases', 'artifacts'].includes(r.kind) ||
      r.group_id !== groupId(r.kind, r.delete_after) ||
      r.snapshot_id !== receipt.snapshot_id ||
      r.captured_at !== receipt.captured_at ||
      !iso(r.delete_after) ||
      Date.parse(r.delete_after) <= Date.parse(r.captured_at) ||
      Date.parse(r.delete_after) > Date.parse(r.captured_at) + 30 * DAY ||
      !Array.isArray(r.files) ||
      r.files.length < (r.kind === 'databases' ? 3 : 2)
    )
      fail('generation_group_invalid');
    seen.add(g.group_id);
    databases += Number(r.kind === 'databases');
    const names = new Set();
    for (const f of r.files) {
      if (
        !/^(manifest|[a-f0-9]{64})\.age$/.test(f.name ?? '') ||
        names.has(f.name) ||
        !SHA.test(f.sha256 ?? '') ||
        !Number.isSafeInteger(f.bytes) ||
        f.bytes < 1 ||
        f.bytes > 32 * 1024 ** 3
      )
        fail('generation_file_invalid');
      names.add(f.name);
    }
    if (!names.has('manifest.age')) fail('generation_manifest_missing');
    total += r.files.length - 1;
  }
  const deadlines = receipt.groups.map((g) => Date.parse(g.receipt.delete_after));
  if (
    databases !== 1 ||
    total > 100000 ||
    receipt.database_delete_after !==
      receipt.groups.find((g) => g.receipt.kind === 'databases').receipt.delete_after ||
    receipt.full_inventory_until !== new Date(Math.min(...deadlines)).toISOString() ||
    receipt.delete_after !== new Date(Math.max(...deadlines)).toISOString()
  )
    fail('generation_deadline_mismatch');
  return receipt;
}

// Expired groups may be absent or partly deleted. Their ORIGINAL immutable receipt
// remains the sole allowlist for any remaining file; unexpired omissions always fail.
export async function inspectGeneration(path, now = Date.now(), expectedReceiptHash) {
  const root = resolve(path);
  await directory(root);
  const raw = await boundedRead(join(root, 'complete.json'));
  const receiptHash = sha(raw);
  if (
    expectedReceiptHash !== undefined &&
    (!SHA.test(expectedReceiptHash) || receiptHash !== expectedReceiptHash)
  )
    fail('generation_receipt_mismatch');
  const receipt = validateGenerationReceipt(JSON.parse(raw));
  if (!Number.isFinite(now) || Date.parse(receipt.captured_at) > now)
    fail('generation_time_invalid');
  const names = await readdir(root);
  if (
    names.some(
      (name) => name !== 'complete.json' && !receipt.groups.some((g) => g.group_id === name),
    )
  )
    fail('unlisted_generation_group');
  const groups = [];
  for (const g of receipt.groups) {
    const expired = Date.parse(g.receipt.delete_after) <= now;
    const files = [];
    let present = names.includes(g.group_id);
    if (present) {
      const base = join(root, g.group_id);
      await directory(base);
      const expected = [
        ...g.receipt.files.map((f) => ({ path: f.name, bytes: f.bytes, sha256: f.sha256 })),
        {
          path: 'complete.json',
          bytes: Buffer.byteLength(JSON.stringify(g.receipt)),
          sha256: g.receipt_sha256,
        },
      ];
      const children = await readdir(base);
      if (
        children.some((name) => !expected.some((f) => f.path === name)) ||
        (!expired && children.length !== expected.length)
      )
        fail('group_incomplete_or_unlisted');
      for (const f of expected) {
        if (!children.includes(f.path)) continue;
        await file(join(base, f.path), f);
        files.push({ ...f, path: g.group_id + '/' + f.path });
      }
    } else if (!expired) fail('unexpired_group_missing');
    groups.push({
      group_id: g.group_id,
      kind: g.receipt.kind,
      delete_after: g.receipt.delete_after,
      state: expired ? (present ? 'expired' : 'expired_removed') : 'unexpired',
      present,
      files,
    });
  }
  return {
    receipt,
    receipt_sha256: receiptHash,
    groups,
    index_file: { path: 'complete.json', bytes: raw.length, sha256: receiptHash },
    database_available: groups.some((g) => g.kind === 'databases' && g.state === 'unexpired'),
    full_inventory_available: groups.every((g) => g.state === 'unexpired'),
    expired_group_count: groups.filter((g) => g.state === 'expired').length,
  };
}

export async function decryptGeneration(directory, options) {
  if (!SHA.test(options.expectedReceiptHash ?? '')) fail('independent_receipt_hash_required');
  const checked = await inspectGeneration(directory, options.now, options.expectedReceiptHash);
  if (!checked.database_available) fail('database_backup_expired');
  const output = resolve(options.outputDir);
  if (
    output === resolve(directory) ||
    output.startsWith(resolve(directory) + '/') ||
    output.startsWith(resolve(directory) + '\\')
  )
    fail('separate_output_required');
  await mkdir(output, { mode: 0o700 });
  const paths = new Set(),
    files = [];
  for (const g of checked.groups.filter((g) => g.state === 'unexpired')) {
    const dest = join(output, g.group_id);
    const result = await decryptBackup(join(directory, g.group_id), {
      ...options,
      outputDir: dest,
    });
    if (result.capture_audit_sha256 !== checked.receipt.capture_audit_sha256)
      fail('generation_audit_mismatch');
    const manifest = JSON.parse(await boundedRead(join(dest, 'manifest.json')));
    for (const f of manifest.files) {
      if (paths.has(f.path)) fail('duplicate_generation_path');
      paths.add(f.path);
      files.push({ ...f, restored_path: join(dest, f.path) });
    }
  }
  return {
    status: 'decrypted_files_verified',
    files,
    receipt_sha256: checked.receipt_sha256,
    capture_audit_sha256: checked.receipt.capture_audit_sha256,
    full_inventory_available: checked.full_inventory_available,
    expired_groups: checked.groups.filter((g) => g.state !== 'unexpired').length,
    database_import_performed: false,
    publication_allowed: false,
  };
}
