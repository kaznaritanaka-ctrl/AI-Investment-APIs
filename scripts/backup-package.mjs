import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, realpath, open } from 'node:fs/promises';
import { resolve, relative, dirname, isAbsolute } from 'node:path';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { pathToFileURL } from 'node:url';

const DAY = 86400000;
const MAX_MANIFEST_BYTES = 32 * 1024 * 1024;
const fail = (code) => {
  throw new Error(code);
};
const sha = (value) => createHash('sha256').update(value).digest('hex');
const instant = (value) =>
  typeof value === 'string' &&
  /^\d{4}-\d\d-\d\dT/.test(value) &&
  Number.isFinite(Date.parse(value));
const snapshotId = (value) => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
const logical = (value) =>
  typeof value === 'string' &&
  value.length <= 512 &&
  !value.split('/').some((part) => !part || part === '.' || part === '..') &&
  (/^d1\/(private|public)\.sql$/.test(value) ||
    /^(evidence|archive)\/(ecb|models_dev|price_of_compute)\/[a-zA-Z0-9_./-]+\.json$/.test(value));
const digest = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function inside(root, path) {
  const rel = relative(root, path);
  return (
    rel !== '' &&
    rel !== '..' &&
    !rel.startsWith('..\\') &&
    !rel.startsWith('../') &&
    !isAbsolute(rel)
  );
}
export async function hashFile(file) {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk);
    size += chunk.length;
  }
  return { sha256: hash.digest('hex'), bytes: size };
}
function boundedStream(limit) {
  let bytes = 0;
  return new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      callback(bytes > limit ? new Error('output_too_large') : null, chunk);
    },
  });
}
export async function boundedRead(file) {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_MANIFEST_BYTES)
    fail('manifest_too_large');
  const parts = [];
  let bytes = 0;
  for await (const chunk of createReadStream(file)) {
    bytes += chunk.length;
    if (bytes > MAX_MANIFEST_BYTES) fail('manifest_too_large');
    parts.push(chunk);
  }
  return Buffer.concat(parts);
}

export async function durableWrite(path, text) {
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(text);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncFile(path) {
  const handle = await open(path, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

// Packaging is offline. A separately approved exporter must establish completeness,
// source policy and absolute deletion deadlines before calling this boundary.
export function validatePlan(plan, now = Date.now()) {
  if (
    !['backup-input-v1', 'backup-input-v2'].includes(plan?.schema_version) ||
    !snapshotId(plan.snapshot_id) ||
    !Number.isFinite(now) ||
    !instant(plan.captured_at) ||
    Date.parse(plan.captured_at) > now ||
    now - Date.parse(plan.captured_at) > DAY ||
    !instant(plan.delete_after) ||
    Date.parse(plan.delete_after) <= now ||
    Date.parse(plan.delete_after) > Date.parse(plan.captured_at) + 30 * DAY ||
    plan.inventory_complete !== true ||
    !Array.isArray(plan.files) ||
    plan.files.length <
      (plan.schema_version === 'backup-input-v2' && plan.kind === 'artifacts' ? 1 : 2) ||
    plan.files.length > 100000 ||
    (plan.capture_audit_sha256 !== undefined && !digest(plan.capture_audit_sha256))
  )
    fail('backup_plan_invalid');
  const grouped = plan.schema_version === 'backup-input-v2';
  if (
    grouped &&
    (!['databases', 'artifacts'].includes(plan.kind) ||
      !/^g-[a-f0-9]{64}$/.test(plan.group_id ?? '') ||
      !digest(plan.capture_audit_sha256))
  )
    fail('backup_group_invalid');
  const seen = new Set();
  for (const entry of plan.files) {
    if (
      !logical(entry.path) ||
      seen.has(entry.path) ||
      !digest(entry.sha256) ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes < 1 ||
      !instant(entry.delete_after) ||
      Date.parse(entry.delete_after) < Date.parse(plan.delete_after) ||
      (grouped && entry.delete_after !== plan.delete_after) ||
      (grouped && entry.path.startsWith('d1/') !== (plan.kind === 'databases'))
    )
      fail('backup_entry_invalid');
    seen.add(entry.path);
  }
  if (
    (!grouped || plan.kind === 'databases') &&
    (!seen.has('d1/private.sql') || !seen.has('d1/public.sql'))
  )
    fail('both_databases_required');
  return plan;
}

// age receives no Cloudflare, storage, notification or GitHub credentials.
async function runAge(binary, args, input, output, maxOutput = Infinity) {
  if (!isAbsolute(binary)) fail('absolute_age_binary_required');
  const env = Object.fromEntries(
    ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'PATH']
      .filter((key) => process.env[key])
      .map((key) => [key, process.env[key]]),
  );
  const child = spawn(binary, args, {
    windowsHide: true,
    shell: false,
    env,
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const timer = setTimeout(() => child.kill(), 20 * 60 * 1000);
  const done = new Promise((resolveDone, reject) => {
    child.once('error', () => reject(new Error('age_process_failed')));
    child.once('close', (code) => (code === 0 ? resolveDone() : reject(new Error('age_failed'))));
  });
  try {
    await Promise.all([
      pipeline(input, child.stdin),
      pipeline(child.stdout, boundedStream(maxOutput), output),
      done,
    ]);
  } catch {
    child.kill();
    fail('age_failed');
  } finally {
    clearTimeout(timer);
  }
}

export async function packageBackup(
  plan,
  { inputRoot, outputDir, recipient, ageBinary, now = Date.now() },
) {
  validatePlan(plan, now);
  // Native public recipients only. No plugin execution or private key input.
  if (!/^age1[a-z0-9]{58}$/.test(recipient ?? '')) fail('native_age_recipient_required');
  const root = await realpath(inputRoot),
    output = resolve(outputDir);
  if (output === root || inside(root, output) || inside(output, root))
    fail('separate_output_required');
  const files = [];
  for (const entry of plan.files) {
    const file = resolve(root, entry.path);
    if (
      !inside(root, file) ||
      (await lstat(file)).isSymbolicLink() ||
      !inside(root, await realpath(file)) ||
      !(await lstat(file)).isFile()
    )
      fail('unsafe_input_path');
    const actual = await hashFile(file);
    if (actual.sha256 !== entry.sha256 || actual.bytes !== entry.bytes)
      fail('input_integrity_failed');
    files.push({ ...entry, file, cipher: sha(entry.path) + '.age' });
  }
  // Never merge with or overwrite an existing directory. A failed directory has no complete marker.
  await mkdir(output, { recursive: false, mode: 0o700 });
  const encrypted = [];
  for (const file of files) {
    const dest = resolve(output, file.cipher);
    const hash = createHash('sha256');
    let bytes = 0;
    // Hash the exact bytes sent to age, not a second read of a mutable source file.
    async function* input() {
      for await (const chunk of createReadStream(file.file)) {
        bytes += chunk.length;
        if (bytes > file.bytes) fail('input_changed_during_backup');
        hash.update(chunk);
        yield chunk;
      }
    }
    await runAge(
      ageBinary,
      ['--encrypt', '-r', recipient],
      Readable.from(input()),
      createWriteStream(dest, { flags: 'wx', mode: 0o600 }),
    );
    if (hash.digest('hex') !== file.sha256 || bytes !== file.bytes)
      fail('input_changed_during_backup');
    await syncFile(dest);
    encrypted.push({ name: file.cipher, ...(await hashFile(dest)) });
  }
  const manifest = {
    schema_version: plan.schema_version,
    snapshot_id: plan.snapshot_id,
    captured_at: plan.captured_at,
    delete_after: plan.delete_after,
    inventory_complete: true,
    ...(plan.schema_version === 'backup-input-v2'
      ? { kind: plan.kind, group_id: plan.group_id }
      : {}),
    ...(plan.capture_audit_sha256 ? { capture_audit_sha256: plan.capture_audit_sha256 } : {}),
    files: files.map(({ path, sha256, bytes, delete_after, cipher }) => ({
      path,
      sha256,
      bytes,
      delete_after,
      cipher,
    })),
  };
  const manifestText = JSON.stringify(manifest);
  if (Buffer.byteLength(manifestText) > MAX_MANIFEST_BYTES) fail('manifest_too_large');
  await runAge(
    ageBinary,
    ['--encrypt', '-r', recipient],
    Readable.from([manifestText]),
    createWriteStream(resolve(output, 'manifest.age'), { flags: 'wx', mode: 0o600 }),
  );
  encrypted.push({ name: 'manifest.age', ...(await hashFile(resolve(output, 'manifest.age'))) });
  await syncFile(resolve(output, 'manifest.age'));
  const receipt = {
    schema_version:
      plan.schema_version === 'backup-input-v2' ? 'encrypted-backup-v2' : 'encrypted-backup-v1',
    ...(plan.schema_version === 'backup-input-v2'
      ? { kind: plan.kind, group_id: plan.group_id }
      : {}),
    snapshot_id: plan.snapshot_id,
    captured_at: plan.captured_at,
    delete_after: plan.delete_after,
    files: encrypted,
  };
  // No plaintext filenames, bodies, resource IDs or credentials in this marker.
  await durableWrite(resolve(output, 'complete.json'), JSON.stringify(receipt));
  return {
    snapshot_id: plan.snapshot_id,
    encrypted_files: encrypted.length,
    delete_after: plan.delete_after,
    status: 'local_encrypted_only',
    offsite_verified: false,
  };
}

export async function verifyBackup(directory, now = Date.now()) {
  const root = await realpath(directory);
  const raw = await boundedRead(resolve(root, 'complete.json'));
  const receipt = JSON.parse(raw);
  if (
    !['encrypted-backup-v1', 'encrypted-backup-v2'].includes(receipt.schema_version) ||
    !snapshotId(receipt.snapshot_id) ||
    !instant(receipt.captured_at) ||
    Date.parse(receipt.captured_at) > now ||
    !instant(receipt.delete_after) ||
    Date.parse(receipt.delete_after) <= now ||
    Date.parse(receipt.delete_after) > Date.parse(receipt.captured_at) + 30 * DAY ||
    !Array.isArray(receipt.files) ||
    receipt.files.length > 100001
  )
    fail('backup_expired_or_incomplete');
  if (
    receipt.schema_version === 'encrypted-backup-v2' &&
    (!['databases', 'artifacts'].includes(receipt.kind) ||
      !/^g-[a-f0-9]{64}$/.test(receipt.group_id ?? ''))
  )
    fail('receipt_invalid');
  const names = new Set();
  for (const entry of receipt.files) {
    if (
      !/^(manifest|[a-f0-9]{64})\.age$/.test(entry.name) ||
      names.has(entry.name) ||
      !digest(entry.sha256) ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes < 1
    )
      fail('receipt_invalid');
    names.add(entry.name);
    const path = resolve(root, entry.name);
    if (
      !(await lstat(path)).isFile() ||
      (await lstat(path)).isSymbolicLink() ||
      !inside(root, await realpath(path))
    )
      fail('unsafe_cipher_path');
    const actual = await hashFile(path);
    if (entry.sha256 !== actual.sha256 || entry.bytes !== actual.bytes)
      fail('cipher_integrity_failed');
  }
  if (!names.has('manifest.age') || names.size < (receipt.kind === 'artifacts' ? 2 : 3))
    fail('backup_incomplete');
  return receipt;
}

export async function decryptBackup(
  directory,
  { outputDir, identityFile, ageBinary, now = Date.now() },
) {
  const receipt = await verifyBackup(directory, now);
  const root = await realpath(directory),
    output = resolve(outputDir);
  if (output === root || inside(root, output) || inside(output, root))
    fail('separate_output_required');
  await mkdir(output, { recursive: false, mode: 0o700 });
  const manifestPath = resolve(output, 'manifest.json');
  await runAge(
    ageBinary,
    ['--decrypt', '-i', resolve(identityFile)],
    createReadStream(resolve(root, 'manifest.age')),
    createWriteStream(manifestPath, { flags: 'wx', mode: 0o600 }),
    MAX_MANIFEST_BYTES,
  );
  const bytes = await boundedRead(manifestPath);
  const manifest = validatePlan(JSON.parse(bytes), Date.parse(receipt.captured_at));
  if (
    manifest.snapshot_id !== receipt.snapshot_id ||
    manifest.captured_at !== receipt.captured_at ||
    manifest.delete_after !== receipt.delete_after ||
    manifest.kind !== receipt.kind ||
    manifest.group_id !== receipt.group_id ||
    manifest.files.length + 1 !== receipt.files.length
  )
    fail('manifest_mismatch');
  for (const entry of manifest.files) {
    if (
      entry.cipher !== sha(entry.path) + '.age' ||
      !receipt.files.some((file) => file.name === entry.cipher)
    )
      fail('manifest_mismatch');
    const dest = resolve(output, entry.path);
    if (!inside(output, dest)) fail('unsafe_restore_path');
    await mkdir(dirname(dest), { recursive: true, mode: 0o700 });
    await runAge(
      ageBinary,
      ['--decrypt', '-i', resolve(identityFile)],
      createReadStream(resolve(root, entry.cipher)),
      createWriteStream(dest, { flags: 'wx', mode: 0o600 }),
      entry.bytes,
    );
    const actual = await hashFile(dest);
    if (actual.sha256 !== entry.sha256 || actual.bytes !== entry.bytes)
      fail('plaintext_integrity_failed');
  }
  return {
    status: 'decrypted_files_verified',
    files: manifest.files.length,
    database_import_performed: false,
    publication_allowed: false,
    ...(manifest.capture_audit_sha256
      ? { capture_audit_sha256: manifest.capture_audit_sha256 }
      : {}),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [mode, ...args] = process.argv.slice(2);
    let result;
    if (mode === 'pack' && args.length === 3)
      result = await packageBackup(JSON.parse(await boundedRead(args[0])), {
        inputRoot: args[1],
        outputDir: args[2],
        recipient: process.env.BACKUP_AGE_RECIPIENT,
        ageBinary: process.env.AGE_BINARY,
      });
    else if (mode === 'verify' && args.length === 1) {
      const receipt = await verifyBackup(args[0]);
      result = {
        status: 'ciphertext_verified',
        snapshot_id: receipt.snapshot_id,
        offsite_verified: false,
        restore_verified: false,
      };
    } else if (mode === 'decrypt' && args.length === 2)
      result = await decryptBackup(args[0], {
        outputDir: args[1],
        identityFile: process.env.BACKUP_AGE_IDENTITY_FILE,
        ageBinary: process.env.AGE_BINARY,
      });
    else fail('usage_pack_plan_input_output_or_verify_directory_or_decrypt_directory_output');
    console.log(JSON.stringify(result));
  } catch {
    console.error(JSON.stringify({ status: 'failed', complete: false }));
    process.exitCode = 1;
  }
}
