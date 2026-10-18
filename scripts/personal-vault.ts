import { createCipheriv, createDecipheriv, randomBytes, createHmac } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, unlink, readdir, lstat, open } from 'node:fs/promises';
import { resolve, dirname, isAbsolute, relative, sep } from 'node:path';
import { z } from 'zod';
import { hash, stable } from '../src/util';
import {
  inspectPersonalContract,
  type PersonalV2Contract,
} from '../src/research/personal-contract';
import {
  checkPersonalSnapshot,
  createPersonalSnapshot,
  restorePersonalSnapshot,
  personalBackupManifest,
  type PersonalSnapshot,
} from '../src/research/personal-snapshot';
import {
  maintainPersonalGpu,
  type PersonalEnv,
  type PersonalOptions,
} from '../src/research/personal';
import { personalReviewHead, personalRunId } from '../src/research/personal-review';
import { personalLocalEnv } from './personal-local-env';

const fileName = /^[a-f0-9]{64}\.pgb$/;
export function parseBackupKey(input: string | undefined) {
  if (!input || !/^[a-f0-9]{64}$/i.test(input)) throw new Error('personal_backup_key_unavailable');
  return Buffer.from(input, 'hex');
}
export async function checkedLocalPath(path: string) {
  if (!isAbsolute(path) || path.startsWith('\\\\') || path.startsWith('//'))
    throw new Error('personal_local_path_required');
  const full = resolve(path);
  let cursor = full;
  while (true) {
    try {
      const st = await lstat(cursor);
      if (st.isSymbolicLink()) throw new Error('personal_symlink_forbidden');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return full;
}
export function separatePaths(a: string, b: string) {
  const under = (x: string, y: string) => {
    const r = relative(x, y);
    return r === '' || (!r.startsWith('..' + sep) && r !== '..' && !isAbsolute(r));
  };
  if (under(a, b) || under(b, a)) throw new Error('personal_backup_path_overlap');
}
const VaultSchema = z
  .object({
    version: z.literal('personal-vault-v1'),
    contract_hash: z.string(),
    store_id: z.string(),
    destination_id: z.string(),
    key_id: z.string(),
    key_check: z.string(),
    data_origin: z.enum(['synthetic', 'live']),
  })
  .strict();
const keyCheck = (key: Buffer, digest: string) =>
  createHmac('sha256', key)
    .update('personal-vault:' + digest)
    .digest('hex');
export async function initializePersonalVault(root: string, c: PersonalV2Contract, key: Buffer) {
  if (key.length !== 32) throw new Error('personal_backup_key_unavailable');
  await checkedLocalPath(root);
  const digest = await hash(stable(c));
  await mkdir(root, { recursive: true });
  // Never adopt an existing unlabelled directory or overwrite another vault.
  if ((await readdir(root)).length) throw new Error('personal_vault_exists');
  await writeFile(
    resolve(root, 'vault.json'),
    stable({
      version: 'personal-vault-v1',
      contract_hash: digest,
      store_id: c.decision.retention.store_id,
      destination_id: c.decision.retention.backup.destination_id,
      key_id: c.decision.retention.backup.key_id,
      key_check: keyCheck(key, digest),
      data_origin: c.data_origin,
    }),
    { flag: 'wx', mode: 0o600 },
  );
  await mkdir(resolve(root, 'copies'));
  await mkdir(resolve(root, 'control'));
}
export async function inspectPersonalVault(root: string, c: PersonalV2Contract, key?: Buffer) {
  await checkedLocalPath(root);
  const path = resolve(root, 'vault.json');
  if ((await lstat(path)).size > 8192) throw new Error('personal_vault_invalid');
  const v = VaultSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  if (
    v.contract_hash !== (await hash(stable(c))) ||
    v.store_id !== c.decision.retention.store_id ||
    v.destination_id !== c.decision.retention.backup.destination_id ||
    v.key_id !== c.decision.retention.backup.key_id ||
    v.data_origin !== c.data_origin
  )
    throw new Error('personal_vault_scope_invalid');
  if (key && (key.length !== 32 || v.key_check !== keyCheck(key, v.contract_hash)))
    throw new Error('personal_backup_key_mismatch');
  await checkedLocalPath(path);
  await checkedLocalPath(resolve(root, 'copies'));
  await checkedLocalPath(resolve(root, 'control'));
  return v;
}
export async function withVaultLock<T>(root: string, operation: () => Promise<T>) {
  const path = resolve(root, 'maintenance.lock');
  const lock = await open(path, 'wx', 0o600).catch(() => {
    throw new Error('personal_vault_busy');
  });
  try {
    await lock.writeFile(stable({ pid: process.pid, started_at: new Date().toISOString() }));
    return await operation();
  } finally {
    await lock.close();
    await unlink(path);
  }
}
const Envelope = z
  .object({
    version: z.literal('personal-encrypted-v1'),
    contract_hash: z.string(),
    key_id: z.string(),
    iv: z.string().regex(/^[a-f0-9]{24}$/),
    tag: z.string().regex(/^[a-f0-9]{32}$/),
    ciphertext: z.string().max(750000),
  })
  .strict();
export function encryptPersonalSnapshot(s: PersonalSnapshot, c: PersonalV2Contract, key: Buffer) {
  const iv = randomBytes(12),
    aad = stable(['personal-encrypted-v1', s.contract_hash, c.decision.retention.backup.key_id]);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad));
  const plaintext = Buffer.from(stable(s));
  if (plaintext.length > 524288) throw new Error('personal_snapshot_too_large');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return stable({
    version: 'personal-encrypted-v1',
    contract_hash: s.contract_hash,
    key_id: c.decision.retention.backup.key_id,
    iv: Buffer.from(iv).toString('hex'),
    tag: Buffer.from(cipher.getAuthTag()).toString('hex'),
    ciphertext: encrypted.toString('base64'),
  });
}
export async function decryptPersonalSnapshot(encoded: string, c: PersonalV2Contract, key: Buffer) {
  try {
    if (Buffer.byteLength(encoded) > 800000) throw new Error('oversize');
    const e = Envelope.parse(JSON.parse(encoded));
    if (
      e.contract_hash !== (await hash(stable(c))) ||
      e.key_id !== c.decision.retention.backup.key_id
    )
      throw new Error('scope');
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(e.iv, 'hex'));
    decipher.setAAD(Buffer.from(stable([e.version, e.contract_hash, e.key_id])));
    decipher.setAuthTag(Buffer.from(e.tag, 'hex'));
    const body = Buffer.concat([
      decipher.update(Buffer.from(e.ciphertext, 'base64')),
      decipher.final(),
    ]);
    if (body.length > 524288) throw new Error('oversize');
    return JSON.parse(body.toString('utf8')) as PersonalSnapshot;
  } catch {
    throw new Error('personal_backup_integrity_failed');
  }
}
async function files(root: string, c: PersonalV2Contract) {
  const dir = resolve(root, 'copies'),
    entries = await readdir(dir, { withFileTypes: true });
  if (
    entries.length > c.decision.retention.backup.max_copies + 2 ||
    entries.some(
      (e) =>
        !e.isFile() || (!fileName.test(e.name) && !/^[a-f0-9]{64}\.pgb\.pending$/.test(e.name)),
    )
  )
    throw new Error('personal_vault_inventory_invalid');
  return entries.map((e) => resolve(dir, e.name));
}
async function readCopy(path: string, c: PersonalV2Contract, key: Buffer) {
  await checkedLocalPath(path);
  if ((await lstat(path)).size > 800000) throw new Error('personal_backup_integrity_failed');
  const s = await decryptPersonalSnapshot(await readFile(path, 'utf8'), c, key);
  if (resolve(dirname(path), (await hash(stable(s))) + '.pgb') !== path)
    throw new Error('personal_backup_integrity_failed');
  return s;
}
export async function verifyRestoreInMemory(
  env: PersonalEnv,
  c: PersonalV2Contract,
  s: PersonalSnapshot,
  opt: PersonalOptions = {},
) {
  const staged = await personalLocalEnv(
    c.decision.retention.store_id,
    env.ENVIRONMENT as 'test' | 'development',
  );
  try {
    await restorePersonalSnapshot({ ...staged.env, EVIDENCE: env.EVIDENCE }, c, s, opt);
    const rows = await staged.env.PRIVATE_DB.prepare(
      'SELECT * FROM research_gpu_observations ORDER BY observation_id',
    ).all();
    const expected = [...s.tables.research_gpu_observations].sort((a, b) =>
      String(a.observation_id).localeCompare(String(b.observation_id)),
    );
    if (stable(rows.results) !== stable(expected))
      throw new Error('personal_restore_verify_failed');
    return { verified: true, count: rows.results.length };
  } finally {
    await staged.mf.dispose();
  }
}
// A supervised tick performs maintenance even when collection and analysis are blocked.
// No HTTP acquisition, raw output or approvals are generated by this function.
export async function personalBackupTick(
  env: PersonalEnv,
  input: unknown,
  root: string,
  key: Buffer | undefined,
  opt: PersonalOptions = {},
) {
  if (env.ENVIRONMENT !== 'test' && (opt.now || opt.fetcher))
    throw new Error('personal_synthetic_boundary');
  const at = (opt.now ?? (() => new Date().toISOString()))();
  const { contract: c } = await inspectPersonalContract(input, at, env.ENVIRONMENT, 'maintain');
  if (c.version !== 'personal-gpu-v2') throw new Error('personal_backup_v2_required');
  await inspectPersonalVault(root, c);
  return withVaultLock(root, async () => {
    const state = await maintainPersonalGpu(env, c, opt);
    const paths = await files(root, c);
    if (state.state === 'purged') {
      for (const path of paths) await unlink(path);
      await env.PRIVATE_DB.prepare(
        "UPDATE research_runs SET backup_residual_until=NULL WHERE run_id=? AND state='purged'",
      )
        .bind(await personalRunId(c))
        .run();
      return {
        state: 'purged',
        copies: 0,
        normalized_count: 0,
        deadline_missed: state.deadline_missed,
      };
    }
    // Expiry cleanup uses the current control manifest, even if the encryption key
    // is unavailable. Incomplete writes were never completed backups and are removed.
    const retainedPaths: string[] = [];
    for (const path of paths) {
      if (path.endsWith('.pending')) {
        await unlink(path);
        continue;
      }
      const m = await personalBackupManifest(env, c, path.slice(-68, -4));
      if (m.expires_at <= at) await unlink(path);
      else retainedPaths.push(path);
    }
    if (state.state === 'storage_unknown')
      return { state: 'storage_unknown', copies: retainedPaths.length };
    if (state.state === 'no_run' || state.state === 'leased')
      return { state: state.state, copies: retainedPaths.length };
    if (!key) throw new Error('personal_backup_key_unavailable');
    await inspectPersonalVault(root, c, key);
    const available: { path: string; s: PersonalSnapshot }[] = [];
    for (const path of retainedPaths) {
      const s = await readCopy(path, c, key);
      if (s.expires_at <= at) await unlink(path);
      else available.push({ path, s });
    }
    available.sort((a, b) => b.s.created_at.localeCompare(a.s.created_at));
    let latest = available[0]?.s,
      created = false;
    if (
      !latest ||
      Date.parse(at) - Date.parse(latest.created_at) >=
        c.decision.retention.backup.interval_hours * 3600000
    ) {
      if (available.length >= c.decision.retention.backup.max_copies)
        throw new Error('personal_backup_capacity_reached');
      const result = await createPersonalSnapshot(env, c, opt),
        encoded = encryptPersonalSnapshot(result.snapshot, c, key);
      // Validate ciphertext in memory before writing; plaintext is never a local file.
      await checkPersonalSnapshot(env, c, await decryptPersonalSnapshot(encoded, c, key), opt);
      const target = resolve(root, 'copies', result.snapshot_hash + '.pgb');
      const pending = target + '.pending';
      await writeFile(pending, encoded, { flag: 'wx', mode: 0o600 });
      await rename(pending, target);
      latest = result.snapshot;
      created = true;
      available.push({ path: target, s: latest });
    }
    if (!latest) throw new Error('personal_snapshot_not_ready');
    const statusPath = resolve(root, 'status.json');
    let lastVerified: string | null = null;
    try {
      await checkedLocalPath(statusPath);
      if ((await lstat(statusPath)).size > 8192) throw new Error('oversize');
      const status = JSON.parse(await readFile(statusPath, 'utf8'));
      if (
        typeof status.last_verified_at === 'string' &&
        Number.isFinite(Date.parse(status.last_verified_at)) &&
        status.last_verified_at <= at
      )
        lastVerified = status.last_verified_at;
      else throw new Error('invalid_status');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new Error('personal_maintenance_status_invalid');
    }
    let verified = false;
    if (
      !lastVerified ||
      Date.parse(at) - Date.parse(lastVerified) >=
        c.decision.retention.backup.restore_check_hours * 3600000
    ) {
      await verifyRestoreInMemory(env, c, latest, opt);
      lastVerified = at;
      verified = true;
    }
    const head = (await personalReviewHead(env, c, true))!;
    const status = {
      at,
      state: state.state,
      copies: available.length,
      last_backup_at: latest.created_at,
      last_verified_at: lastVerified,
      review_sequence: head.head.sequence,
    };
    const temp = resolve(root, 'status.pending');
    await writeFile(temp, stable(status), { mode: 0o600 });
    await rename(temp, statusPath);
    return { ...status, created, verified };
  });
}

export async function loadPersonalBackup(
  root: string,
  c: PersonalV2Contract,
  key: Buffer,
  digest: string,
) {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('personal_backup_id_invalid');
  await inspectPersonalVault(root, c, key);
  return readCopy(resolve(root, 'copies', digest + '.pgb'), c, key);
}
