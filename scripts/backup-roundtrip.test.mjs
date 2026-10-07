import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { packageBackup, decryptBackup, verifyBackup } from './backup-package.mjs';

test('real age encryption/decryption restores two synthetic SQL databases, immutable trigger and evidence', async () => {
  const ageBinary = process.env.AGE_BINARY;
  assert.ok(
    ageBinary,
    'Set AGE_BINARY to a verified official age binary; this test never substitutes fake encryption.',
  );
  await mkdir('work/backup-tests', { recursive: true });
  const root = await mkdtemp(resolve('work/backup-tests/synthetic-'));
  const input = join(root, 'input'),
    encrypted = join(root, 'encrypted'),
    restored = join(root, 'restored');
  await mkdir(join(input, 'd1'), { recursive: true });
  await mkdir(join(input, 'evidence/ecb'), { recursive: true });
  const identity = join(root, 'synthetic-only.key');
  const keygen = spawnSync(
    join(dirname(ageBinary), process.platform === 'win32' ? 'age-keygen.exe' : 'age-keygen'),
    ['-o', identity],
    { windowsHide: true, stdio: 'pipe' },
  );
  assert.equal(keygen.status, 0);
  const recipient = keygen.stderr.toString().match(/age1[a-z0-9]{58}/)?.[0];
  assert.ok(recipient);
  const sql =
    "CREATE TABLE observations(id TEXT PRIMARY KEY, observed_at TEXT, fingerprint TEXT); INSERT INTO observations VALUES('synthetic-1','2026-10-05T00:00:00Z','synthetic-hash'); CREATE TRIGGER immutable BEFORE UPDATE ON observations BEGIN SELECT RAISE(ABORT,'append-only'); END;";
  const entries = [
    ['d1/private.sql', sql],
    ['d1/public.sql', sql],
    ['evidence/ecb/synthetic.json', '{"synthetic":true,"value":"1.00"}'],
  ];
  const now = Date.now(),
    expiry = new Date(now + 86400000).toISOString();
  const files = [];
  for (const [path, text] of entries) {
    await writeFile(join(input, path), text, { flag: 'wx' });
    files.push({
      path,
      bytes: Buffer.byteLength(text),
      sha256: createHash('sha256').update(text).digest('hex'),
      delete_after: expiry,
    });
  }
  const plan = {
    schema_version: 'backup-input-v1',
    snapshot_id: 'synthetic-test',
    captured_at: new Date(now).toISOString(),
    delete_after: expiry,
    inventory_complete: true,
    files,
  };
  const packed = await packageBackup(plan, {
    inputRoot: input,
    outputDir: encrypted,
    recipient,
    ageBinary,
    now,
  });
  assert.equal(packed.offsite_verified, false);
  const receipt = await verifyBackup(encrypted, now);
  for (const entry of receipt.files) {
    const cipher = await readFile(join(encrypted, entry.name));
    assert.ok(cipher.subarray(0, 22).toString().startsWith('age-encryption.org/v1'));
    assert.ok(!cipher.includes(Buffer.from('synthetic-1')));
  }
  const result = await decryptBackup(encrypted, {
    outputDir: restored,
    identityFile: identity,
    ageBinary,
    now,
  });
  assert.equal(result.publication_allowed, false);
  for (const [path, text] of entries)
    assert.equal(await readFile(join(restored, path), 'utf8'), text);
  for (const name of ['private', 'public']) {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec(await readFile(join(restored, 'd1/' + name + '.sql'), 'utf8'));
      assert.equal(db.prepare('SELECT count(*) AS n FROM observations').get().n, 1);
      assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
      assert.throws(() => db.exec("UPDATE observations SET observed_at='bad'"), /append-only/);
    } finally {
      db.close();
    }
  }
  await assert.rejects(() =>
    packageBackup(plan, { inputRoot: input, outputDir: encrypted, recipient, ageBinary, now }),
  );
  await assert.rejects(() => verifyBackup(encrypted, now + 2 * 86400000), /expired/);
  const tampered = join(encrypted, receipt.files[0].name),
    ciphertext = await readFile(tampered);
  ciphertext[ciphertext.length - 1] ^= 1;
  await writeFile(tampered, ciphertext);
  await assert.rejects(() => verifyBackup(encrypted, now), /cipher_integrity_failed/);
});
