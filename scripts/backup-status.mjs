import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { boundedRead } from './backup-package.mjs';
import { inspectBackupRoot } from './backup-maintenance.mjs';

const sha = (v) => createHash('sha256').update(v).digest('hex');
const fail = (code) => {
  throw new Error(code);
};
const iso = (n) => new Date(n).toISOString();
const ACTIONS = [
  'inspect_backup',
  'create_restore_point',
  'verify_restore',
  'review_expiry_plan',
  'review_expiry_soon',
  'inspect_incomplete_generation',
  'configure_notification_delivery',
];
const CAPTURE = ['current', 'stale', 'missing', 'unknown'];
const exact = (obj, keys) =>
  obj &&
  typeof obj === 'object' &&
  !Array.isArray(obj) &&
  Object.keys(obj).length === keys.length &&
  keys.every((k) => Object.hasOwn(obj, k));

// The only data eligible for Admin / independent monitoring / Dots transport.
// No source values, filenames, account IDs, bookmarks, SQL or arbitrary messages.
export function validateBackupStatus(value, now = Date.now()) {
  const keys = [
    'schema_version',
    'checked_at',
    'valid_until',
    'capture_status',
    'integrity_status',
    'latest_captured_at',
    'receipt_sha256',
    'database_delete_after',
    'full_inventory_until',
    'expired_group_count',
    'blocked_count',
    'restore_status',
    'offsite_status',
    'notification_status',
    'severity',
    'remaining_actions',
  ];
  if (
    !exact(value, keys) ||
    value.schema_version !== 'nas-backup-status-v1' ||
    !Number.isFinite(now) ||
    !Number.isFinite(Date.parse(value.checked_at)) ||
    Math.abs(now - Date.parse(value.checked_at)) > 5 * 60000 ||
    Date.parse(value.valid_until) !== Date.parse(value.checked_at) + 5 * 60000 ||
    !CAPTURE.includes(value.capture_status) ||
    !['verified', 'unverified'].includes(value.integrity_status) ||
    !['not_checked', 'verified_current_generation'].includes(value.restore_status) ||
    value.offsite_status !== 'not_verified' ||
    value.notification_status !== 'not_sent' ||
    !['info', 'warning', 'critical'].includes(value.severity) ||
    !(
      (value.capture_status === 'unknown' && value.expired_group_count === null) ||
      (Number.isSafeInteger(value.expired_group_count) && value.expired_group_count >= 0)
    ) ||
    !(
      (value.capture_status === 'unknown' && value.blocked_count === null) ||
      (Number.isSafeInteger(value.blocked_count) && value.blocked_count >= 0)
    ) ||
    !Array.isArray(value.remaining_actions) ||
    value.remaining_actions.length > ACTIONS.length ||
    new Set(value.remaining_actions).size !== value.remaining_actions.length ||
    value.remaining_actions.some((a) => !ACTIONS.includes(a)) ||
    (value.receipt_sha256 !== null && !/^[a-f0-9]{64}$/.test(value.receipt_sha256))
  )
    fail('backup_status_contract_invalid');
  for (const key of ['latest_captured_at', 'database_delete_after', 'full_inventory_until'])
    if (
      value[key] !== null &&
      (!Number.isFinite(Date.parse(value[key])) || iso(Date.parse(value[key])) !== value[key])
    )
      fail('backup_status_time_invalid');
  if (
    value.latest_captured_at &&
    Date.parse(value.latest_captured_at) > Date.parse(value.checked_at)
  )
    fail('backup_status_future_capture');
  if (
    value.capture_status === 'current' &&
    (!value.latest_captured_at ||
      Date.parse(value.checked_at) - Date.parse(value.latest_captured_at) > 26 * 3600000 ||
      !value.database_delete_after ||
      Date.parse(value.database_delete_after) <= Date.parse(value.checked_at) ||
      value.integrity_status !== 'verified')
  )
    fail('backup_status_false_current');
  if (value.restore_status === 'verified_current_generation' && !value.receipt_sha256)
    fail('backup_status_restore_unbound');
  if (
    (value.capture_status !== 'current' || value.blocked_count || value.expired_group_count) &&
    value.severity !== 'critical'
  )
    fail('backup_status_false_severity');
  if (
    ['unknown', 'missing'].includes(value.capture_status) &&
    (value.latest_captured_at !== null ||
      value.receipt_sha256 !== null ||
      value.integrity_status !== 'unverified')
  )
    fail('backup_status_false_inventory');
  return value;
}

export function statusFromInventory(inventory, now = Date.now(), restore = null) {
  const usable =
    inventory?.snapshots?.filter(
      (s) => s.state === 'unexpired' && s.database_available !== false,
    ) ?? [];
  const latest = usable.sort((a, b) => a.captured_at.localeCompare(b.captured_at)).at(-1);
  const known = inventory && Array.isArray(inventory.snapshots);
  const capture = !known
    ? 'unknown'
    : !latest
      ? 'missing'
      : now - Date.parse(latest.captured_at) > 26 * 3600000
        ? 'stale'
        : 'current';
  const receipt = latest?.receipt_sha256 ?? null;
  const restored =
    receipt &&
    restore?.schema_version === 'backup-restore-result-v1' &&
    restore.status === 'passed' &&
    restore.receipt_sha256 === receipt &&
    restore.databases?.private?.status === 'passed' &&
    restore.databases?.public?.status === 'passed' &&
    restore.original_databases_modified === false &&
    restore.publication_allowed === false &&
    Date.parse(restore.verified_at) >= Date.parse(latest.captured_at) &&
    Date.parse(restore.verified_at) <= now;
  const expired = inventory?.expired_group_count ?? 0;
  const blocked = inventory?.blocked_count ?? 0;
  const actions = [];
  if (capture === 'unknown') actions.push('inspect_backup');
  else if (capture !== 'current') actions.push('create_restore_point');
  if (blocked) actions.push('inspect_incomplete_generation');
  if (expired || inventory?.expired_count) actions.push('review_expiry_plan');
  else if (
    inventory?.next_delete_after &&
    Date.parse(inventory.next_delete_after) - now < 6 * 3600000
  )
    actions.push('review_expiry_soon');
  if (!restored) actions.push('verify_restore');
  actions.push('configure_notification_delivery');
  return validateBackupStatus(
    {
      schema_version: 'nas-backup-status-v1',
      checked_at: iso(now),
      valid_until: iso(now + 5 * 60000),
      capture_status: capture,
      integrity_status: latest ? 'verified' : 'unverified',
      latest_captured_at: latest?.captured_at ?? null,
      receipt_sha256: receipt,
      database_delete_after: latest?.database_delete_after ?? latest?.delete_after ?? null,
      full_inventory_until: latest?.full_inventory_until ?? latest?.delete_after ?? null,
      expired_group_count: known ? expired : null,
      blocked_count: known ? blocked : null,
      restore_status: restored ? 'verified_current_generation' : 'not_checked',
      offsite_status: 'not_verified',
      notification_status: 'not_sent',
      severity:
        capture !== 'current' || blocked || expired || inventory?.expired_count
          ? 'critical'
          : 'warning',
      remaining_actions: actions,
    },
    now,
  );
}

export function signBackupStatus(status, secret, now = Date.now()) {
  validateBackupStatus(status, now);
  if (typeof secret !== 'string' || !/^[a-f0-9]{64}$/.test(secret))
    fail('status_signing_key_invalid');
  const body = JSON.stringify(status),
    bodyHash = sha(body);
  return {
    body,
    body_sha256: bodyHash,
    signature: createHmac('sha256', Buffer.from(secret, 'hex'))
      .update(status.checked_at + '\n' + bodyHash)
      .digest('hex'),
  };
}

export function verifyBackupStatus(body, signature, secret, now = Date.now()) {
  if (
    typeof body !== 'string' ||
    Buffer.byteLength(body) > 4096 ||
    !/^[a-f0-9]{64}$/.test(signature ?? '')
  )
    fail('backup_status_envelope_invalid');
  const value = validateBackupStatus(JSON.parse(body), now);
  const expected = signBackupStatus(value, secret, now);
  // The sender must use the canonical object serialization, not an alternate body.
  if (
    body !== expected.body ||
    !timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected.signature, 'hex'))
  )
    fail('backup_status_signature_invalid');
  return value;
}

export async function readBackupStatus(root, now = Date.now(), restore = null) {
  let inventory;
  try {
    inventory = await inspectBackupRoot(root, now);
  } catch {
    inventory = null;
  }
  return statusFromInventory(inventory, now, restore);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [root, restoreFile, ...rest] = process.argv.slice(2);
    if (!root || rest.length) fail('backup_status_arguments_invalid');
    const restore = restoreFile ? JSON.parse(await boundedRead(resolve(restoreFile))) : null;
    const status = await readBackupStatus(resolve(root), Date.now(), restore);
    console.log(JSON.stringify(status));
    if (status.severity !== 'info') process.exitCode = 2;
  } catch {
    console.error(
      JSON.stringify({ status: 'backup_status_failed', notification_status: 'not_sent' }),
    );
    process.exitCode = 1;
  }
}
