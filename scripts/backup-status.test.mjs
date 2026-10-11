import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  statusFromInventory,
  validateBackupStatus,
  signBackupStatus,
  verifyBackupStatus,
} from './backup-status.mjs';
import { sendBackupStatus } from './backup-notify.mjs';

const NOW = Date.parse('2026-10-11T01:00:00.000Z');
const iso = (n) => new Date(n).toISOString();
const sha = (v) => createHash('sha256').update(v).digest('hex');
const inventory = {
  snapshots: [
    {
      state: 'unexpired',
      captured_at: iso(NOW - 3600000),
      database_available: true,
      receipt_sha256: 'a'.repeat(64),
      database_delete_after: iso(NOW + 86400000),
      full_inventory_until: iso(NOW + 1000),
    },
  ],
  blocked_count: 0,
  expired_group_count: 0,
  expired_count: 0,
  next_delete_after: iso(NOW + 1000),
};
const secret = 'b'.repeat(64);

test('metadata status keeps capture, integrity, full inventory expiry, restore and delivery separate', () => {
  const status = statusFromInventory(inventory, NOW);
  assert.equal(status.capture_status, 'current');
  assert.equal(status.restore_status, 'not_checked');
  assert.equal(status.offsite_status, 'not_verified');
  assert.equal(status.notification_status, 'not_sent');
  assert.ok(status.remaining_actions.includes('review_expiry_soon'));
  assert.equal(statusFromInventory(null, NOW).capture_status, 'unknown');
  assert.equal(statusFromInventory({ snapshots: [] }, NOW).capture_status, 'missing');
  assert.equal(statusFromInventory({ ...inventory, blocked_count: 1 }, NOW).severity, 'critical');
});

test('only a matching restore receipt can mark the selected generation verified', () => {
  const restore = {
    schema_version: 'backup-restore-result-v1',
    status: 'passed',
    receipt_sha256: 'a'.repeat(64),
    databases: { private: { status: 'passed' }, public: { status: 'passed' } },
    original_databases_modified: false,
    publication_allowed: false,
    verified_at: iso(NOW - 1000),
  };
  assert.equal(
    statusFromInventory(inventory, NOW, restore).restore_status,
    'verified_current_generation',
  );
  assert.equal(
    statusFromInventory(inventory, NOW, { ...restore, receipt_sha256: 'c'.repeat(64) })
      .restore_status,
    'not_checked',
  );
});

test('signed metadata rejects raw extra fields, tampering, stale replay and invented healthy state', () => {
  const status = statusFromInventory(inventory, NOW);
  const signed = signBackupStatus(status, secret, NOW);
  assert.deepEqual(verifyBackupStatus(signed.body, signed.signature, secret, NOW), status);
  assert.throws(() => validateBackupStatus({ ...status, token: 'do-not-send' }, NOW));
  assert.throws(() => verifyBackupStatus(signed.body, '0'.repeat(64), secret, NOW), /signature/);
  assert.throws(() => verifyBackupStatus(signed.body, signed.signature, secret, NOW + 6 * 60000));
  assert.throws(
    () => validateBackupStatus({ ...status, database_delete_after: iso(NOW - 1) }, NOW),
    /false_current/,
  );
  assert.throws(() => validateBackupStatus({ ...status, capture_status: 'healthy' }, NOW));
});

test('notification requires exact config hash, separate opt-ins and fresh bounded approval; never contacts endpoint on refusal', async () => {
  const config = {
    schema_version: 'backup-notification-v1',
    enabled: true,
    approval_ref: 'synthetic',
    endpoint: 'https://synthetic.example/v1/backup-status',
    window_start: iso(NOW - 1000),
    window_end: iso(NOW + 60000),
  };
  const hash = sha(JSON.stringify(config)),
    status = statusFromInventory(inventory, NOW);
  let calls = 0;
  const fetcher = async (_url, opts) => {
    calls++;
    assert.equal(opts.redirect, 'error');
    assert.ok(!JSON.stringify(opts).includes(secret));
    verifyBackupStatus(opts.body, opts.headers['x-backup-signature'], secret, NOW);
    return Response.json({ status: 'accepted', body_sha256: sha(opts.body) });
  };
  for (const options of [
    {},
    { allowNetwork: true },
    { allowSend: true },
    { allowSend: true, allowNetwork: true, approvedConfigHash: '0'.repeat(64) },
  ])
    await assert.rejects(
      () => sendBackupStatus(config, status, secret, { now: NOW, fetcher, ...options }),
      /approval/,
    );
  assert.equal(calls, 0);
  const result = await sendBackupStatus(config, status, secret, {
    now: NOW,
    fetcher,
    allowSend: true,
    allowNetwork: true,
    approvedConfigHash: hash,
  });
  assert.equal(result.status, 'delivered');
  assert.equal(calls, 1);
  await assert.rejects(
    () =>
      sendBackupStatus(config, status, secret, {
        now: NOW,
        allowSend: true,
        allowNetwork: true,
        approvedConfigHash: hash,
        fetcher: async () => Response.json({ status: 'accepted', body_sha256: 'bad' }),
      }),
    /ack/,
  );
});
