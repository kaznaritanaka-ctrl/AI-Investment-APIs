import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { join, relative, isAbsolute, sep } from 'node:path';
import { hostname } from 'node:os';
import { z } from 'zod';
import {
  CloudControlSchema,
  CloudManifestSchema,
  cloudControlKey,
  cloudRoot,
  cloudSource,
} from '../src/research/personal-cloud';
import { PersonalSnapshotSchema } from '../src/research/personal-snapshot';
import { PersonalCloudSchema } from '../src/research/personal-contract';
import { PersonalReviewSchema } from '../src/research/personal-review';
import { stable } from '../src/util';
import { checkedLocalPath } from './personal-vault';
import { sealNas, openNas } from './personal-nas-crypto';
import { verifyNasRestore } from './personal-nas-restore';
import { NasReadError, type NasReader } from './personal-nas-transport';

const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const NasSourceSchema = z
  .object({
    source_id: cloudSource,
    contract_hash: digest,
    retention_days: z.number().int().min(1).max(90),
    max_copies: z.number().int().min(2).max(96),
  })
  .strict();
export type NasSource = z.infer<typeof NasSourceSchema>;
export type NasOptions = {
  root: string;
  ageBinary: string;
  recipient: string;
  identityFile: string;
  now: () => string;
};
export function nasFreshness(lastVerified: string | null, at: string) {
  const age = lastVerified ? Date.parse(at) - Date.parse(lastVerified) : NaN;
  return !Number.isFinite(age) || age < 0
    ? { state: 'unknown', age_hours: null }
    : {
        state: age >= 48 * 3600000 ? 'stale' : age >= 26 * 3600000 ? 'warning' : 'healthy',
        age_hours: age / 3600000,
      };
}
const ReceiptSchema = z
  .object({
    snapshot_hash: digest,
    cipher_hash: digest.nullable(),
    created_at: z.iso.datetime(),
    expires_at: z.iso.datetime(),
    verified_at: z.iso.datetime().nullable(),
  })
  .strict();
const StateSchema = z
  .object({
    sequence: z.number().int().min(0),
    review_hash: digest,
    checked_at: z.iso.datetime(),
    denied: z.boolean(),
    storage_ends_at: z.iso.datetime().nullable(),
    retry_at: z.iso.datetime().nullable(),
    failures: z.number().int().min(0),
    last_verified_at: z.iso.datetime().nullable(),
  })
  .strict();

export async function smallFile(path: string, max = 600000) {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > max)
      throw new Error('nas_file_invalid');
    return await readFile(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}
export async function durable(path: string, body: string | Uint8Array) {
  const h = await open(path, 'wx', 0o600);
  try {
    await h.writeFile(body);
    await h.sync();
  } finally {
    await h.close();
  }
}
export async function atomic(path: string, body: string) {
  const temp = path + '.' + crypto.randomUUID() + '.tmp';
  await durable(temp, body);
  await rename(temp, path);
  // Directory fsync is supported on Linux/NAS. Windows requires native custody admission later.
  if (process.platform !== 'win32') {
    const h = await open(join(path, '..'), 'r');
    try {
      await h.sync();
    } finally {
      await h.close();
    }
  }
}
export async function sourceLock(root: string) {
  const path = join(root, 'cycle.lock');
  const acquire = () => open(path, 'wx', 0o600);
  let lock;
  try {
    lock = await acquire();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    // A dead process can be reclaimed, but a live/reused PID never loses its lease.
    const reaper = join(root, 'reap.lock');
    let guard;
    try {
      guard = await open(reaper, 'wx', 0o600);
    } catch {
      throw new Error('nas_cycle_leased');
    }
    try {
      const raw = await smallFile(path, 1024);
      if (!raw) throw new Error('nas_cycle_leased');
      const prior = JSON.parse(raw.toString());
      if (prior.host !== hostname() || !Number.isSafeInteger(prior.pid) || prior.pid <= 0)
        throw new Error('nas_cycle_leased');
      try {
        process.kill(prior.pid, 0);
        throw new Error('nas_cycle_leased');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw new Error('nas_cycle_leased');
      }
      await unlink(path);
      lock = await acquire();
    } finally {
      await guard.close();
      await unlink(reaper);
    }
  }
  await lock.writeFile(stable({ pid: process.pid, host: hostname() }));
  await lock.sync();
  return async () => {
    await lock.close();
    await unlink(path);
  };
}
async function current(
  reader: NasReader,
  c: NasSource,
  at: string,
  prior: z.infer<typeof StateSchema> | null,
) {
  const raw = await reader.get(cloudControlKey(c.source_id));
  if (!raw) throw new Error('nas_current_control_missing');
  const state = CloudControlSchema.parse(JSON.parse(Buffer.from(raw).toString()));
  if (
    state.source_id !== c.source_id ||
    state.contract_hash !== c.contract_hash ||
    state.checked_at > at ||
    Date.parse(at) - Date.parse(state.checked_at) > 48 * 3600000
  )
    throw new Error('nas_current_control_stale_or_scope');
  // The scheduled summary can lag an owner revocation. Re-read authoritative native
  // head/review/deny markers on every admission/restore, with source-fixed S3 GETs.
  const source = c.source_id,
    nativeRoot = 'personal-research/control/' + source + '/';
  const heads = Object.keys(state.records).filter((k) =>
    new RegExp(
      '^research-control/personal-heads/' + source + '/[a-z0-9][a-z0-9_-]{0,79}\\.json$',
    ).test(k),
  );
  if (heads.length !== 1) throw new Error('nas_current_control_missing');
  const headKey = heads[0],
    headBytes = await reader.get(nativeRoot + headKey);
  if (!headBytes) throw new Error('nas_current_control_missing');
  const head = z
    .object({
      contract_hash: digest,
      sequence: z.number().int().min(0),
      review_hash: digest,
      approved_at: z.iso.datetime(),
      review_after: z.iso.datetime(),
      analysis_until: z.iso.datetime(),
      storage_state: z.enum(['continuing', 'unknown']),
      storage_ends_at: z.iso.datetime().nullable(),
    })
    .strict()
    .parse(JSON.parse(Buffer.from(headBytes).toString()));
  if (
    head.contract_hash !== c.contract_hash ||
    head.approved_at > at ||
    head.sequence < state.sequence ||
    (head.sequence === state.sequence && head.review_hash !== state.review_hash) ||
    (head.sequence === 0 && head.review_hash !== c.contract_hash)
  )
    throw new Error('nas_control_rollback');
  state.records[headKey] = Buffer.from(headBytes).toString();
  Object.assign(state, {
    sequence: head.sequence,
    review_hash: head.review_hash,
    review_after: head.review_after,
    analysis_until: head.analysis_until,
    storage_state: head.storage_state,
    storage_ends_at: head.storage_ends_at,
  });
  if (head.sequence) {
    const key = headKey
      .replace('personal-heads/', 'personal-reviews/')
      .replace(/\.json$/, '/' + head.review_hash + '.json');
    const body = await reader.get(nativeRoot + key);
    if (!body) throw new Error('nas_current_control_missing');
    const review = PersonalReviewSchema.parse(JSON.parse(Buffer.from(body).toString()));
    if (
      sha(stable(review)) !== head.review_hash ||
      review.contract_hash !== c.contract_hash ||
      review.sequence !== head.sequence ||
      review.approved_at !== head.approved_at ||
      review.review_after !== head.review_after ||
      review.analysis_until !== head.analysis_until ||
      review.storage_state !== head.storage_state ||
      review.storage_ends_at !== head.storage_ends_at
    )
      throw new Error('nas_control_rollback');
    state.records[key] = Buffer.from(body).toString();
  }
  const attemptKey = headKey.replace('personal-heads/', 'personal-attempts/'),
    attemptText = state.records[attemptKey];
  if (!attemptText) throw new Error('nas_current_control_missing');
  const attempt = z
    .object({
      contract_hash: digest,
      run_id: digest,
      source_id: cloudSource,
      started_at: z.iso.datetime(),
    })
    .strict()
    .parse(JSON.parse(attemptText));
  if (attempt.contract_hash !== c.contract_hash || attempt.source_id !== source)
    throw new Error('nas_control_rollback');
  for (const key of [
    'research-control/revocations/' + source + '.json',
    'research-control/deletions/' + source + '/' + attempt.run_id + '.json',
  ]) {
    const denied = await reader.get(nativeRoot + key);
    if (denied) {
      state.denied = true;
      state.records[key] = Buffer.from(denied).toString();
    }
    // Absence cannot clear a previously observed deny marker.
  }
  if (
    prior &&
    (state.sequence < prior.sequence ||
      state.checked_at < prior.checked_at ||
      (state.sequence === prior.sequence && state.review_hash !== prior.review_hash) ||
      (prior.denied && !state.denied) ||
      (prior.storage_ends_at &&
        (!state.storage_ends_at || state.storage_ends_at > prior.storage_ends_at)))
  )
    throw new Error('nas_control_rollback');
  // Preserve every authority observed during the cycle, including a cancellation
  // racing encryption/restore. The caller persists this even when admission fails.
  if (prior)
    Object.assign(prior, {
      sequence: state.sequence,
      review_hash: state.review_hash,
      checked_at: state.checked_at,
      denied: state.denied,
      storage_ends_at: state.storage_ends_at,
    });
  return state;
}
function usable(control: z.infer<typeof CloudControlSchema>, at: string) {
  if (
    control.denied ||
    control.storage_state !== 'continuing' ||
    (control.storage_ends_at && control.storage_ends_at <= at)
  )
    throw new Error('nas_storage_blocked');
}
async function cleanup(dir: string, at: string, denied: boolean) {
  const receipts = [];
  for (const file of (await readdir(dir)).sort())
    if (/^[a-f0-9]{64}\.json$/.test(file)) {
      const value = await smallFile(join(dir, file), 4096);
      if (!value) continue;
      const r = ReceiptSchema.parse(JSON.parse(value.toString()));
      if (file !== r.snapshot_hash + '.json') throw new Error('nas_receipt_scope');
      receipts.push(r);
    }
  let removed = 0;
  for (const r of receipts)
    if ((denied || r.expires_at <= at) && removed < 20) {
      const path = join(dir, r.snapshot_hash + '.age');
      if (await smallFile(path)) await unlink(path);
      await unlink(join(dir, r.snapshot_hash + '.json'));
      removed++;
    }
  return {
    remaining: receipts.filter((r) => !denied && r.expires_at > at),
    removed,
    more: receipts.filter((r) => denied || r.expires_at <= at).length > removed,
  };
}

// Hourly invocation is sufficient: bounded work, persisted backoff, source-local leases,
// daily full-history generation + daily real decryption/SQLite restore verification.
export async function personalNasCycle(reader: NasReader, input: unknown, opt: NasOptions) {
  const c = NasSourceSchema.parse(input),
    at = opt.now(),
    root = await checkedLocalPath(opt.root);
  if (!Number.isFinite(Date.parse(at))) throw new Error('nas_invalid_time');
  const dir = join(root, c.source_id);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await checkedLocalPath(dir);
  const sealed = join(dir, 'sealed');
  await mkdir(sealed, { recursive: true, mode: 0o700 });
  await checkedLocalPath(sealed);
  const unlock = await sourceLock(dir),
    statePath = join(dir, 'state.json');
  const backoffPath = join(dir, 'backoff.json');
  let previous: z.infer<typeof StateSchema> | null = null;
  try {
    const raw = await smallFile(statePath, 4096);
    previous = raw ? StateSchema.parse(JSON.parse(raw.toString())) : null;
    // Local generation expiry and already-observed denial still run during network failures.
    await cleanup(sealed, at, previous?.denied ?? false);
    const backoffRaw = await smallFile(backoffPath, 4096);
    const backoff = backoffRaw
      ? z
          .object({ retry_at: z.iso.datetime(), failures: z.number().int().min(1) })
          .strict()
          .parse(JSON.parse(backoffRaw.toString()))
      : null;
    if (backoff && backoff.retry_at > at) return { state: 'backoff', retry_at: backoff.retry_at };
    if (previous?.retry_at && previous.retry_at > at)
      return { state: 'backoff', retry_at: previous.retry_at };
    const control = await current(reader, c, at, previous);
    previous = {
      sequence: control.sequence,
      review_hash: control.review_hash,
      checked_at: control.checked_at,
      denied: control.denied,
      storage_ends_at: control.storage_ends_at,
      retry_at: null,
      failures: previous?.failures ?? backoff?.failures ?? 0,
      last_verified_at: previous?.last_verified_at ?? null,
    };
    // Persist latest independent authority BEFORE any data admission or restore.
    await atomic(statePath, stable(previous));
    const clean = await cleanup(
      sealed,
      at,
      control.denied || !!(control.storage_ends_at && control.storage_ends_at <= at),
    );
    usable(control, at);
    if (!control.latest_manifest) return { state: 'no_complete_snapshot', removed: clean.removed };
    const base = cloudRoot(c.source_id) + c.contract_hash + '/';
    if (
      !control.latest_manifest.startsWith(base) ||
      !/\/\d{4}-\d{2}-\d{2}\/manifest\.json$/.test(control.latest_manifest)
    )
      throw new Error('nas_manifest_scope');
    const manifestBytes = await reader.get(control.latest_manifest);
    if (!manifestBytes) throw new Error('nas_manifest_missing');
    const manifest = CloudManifestSchema.parse(JSON.parse(Buffer.from(manifestBytes).toString()));
    if (
      manifest.source_id !== c.source_id ||
      manifest.contract_hash !== c.contract_hash ||
      manifest.created_at > at ||
      manifest.expires_at <= at ||
      Date.parse(manifest.expires_at) - Date.parse(manifest.created_at) >
        c.retention_days * 86400000
    )
      throw new Error('nas_manifest_invalid');
    const name = manifest.snapshot_hash,
      cipherPath = join(sealed, name + '.age'),
      receiptPath = join(sealed, name + '.json');
    const saved = await smallFile(receiptPath, 4096),
      receipt = saved ? ReceiptSchema.parse(JSON.parse(saved.toString())) : null;
    let cipher: Buffer | null = await smallFile(cipherPath);
    if (
      receipt &&
      (receipt.snapshot_hash !== name ||
        receipt.created_at !== manifest.created_at ||
        receipt.expires_at !== manifest.expires_at ||
        (receipt.cipher_hash && (!cipher || sha(cipher) !== receipt.cipher_hash)))
    )
      throw new Error('nas_cipher_integrity');
    if (receipt?.verified_at && Date.parse(at) - Date.parse(receipt.verified_at) < 86400000) {
      await atomic(
        statePath,
        stable({ ...previous, failures: 0, retry_at: null, last_verified_at: receipt.verified_at }),
      );
      return { state: 'current', verified_at: receipt.verified_at };
    }
    if (!cipher) {
      if (!receipt && clean.remaining.length >= c.max_copies)
        throw new Error('nas_capacity_review_required');
      const parts: Uint8Array[] = [];
      let bytes = 0;
      for (const [index, chunk] of manifest.chunks.entries()) {
        if (
          chunk.key !== control.latest_manifest.replace('manifest.json', 'part-' + index + '.json')
        )
          throw new Error('nas_chunk_scope');
        const body = await reader.get(chunk.key);
        if (!body || body.length !== chunk.bytes || sha(body) !== chunk.sha256)
          throw new Error('nas_chunk_integrity');
        bytes += body.length;
        if (bytes > 524288) throw new Error('nas_snapshot_too_large');
        parts.push(body);
      }
      const plain = Buffer.concat(parts);
      if (bytes !== manifest.bytes || sha(plain) !== name)
        throw new Error('nas_snapshot_integrity');
      const snapshot = PersonalSnapshotSchema.parse(JSON.parse(plain.toString()));
      if (
        snapshot.contract_hash !== c.contract_hash ||
        snapshot.expires_at !== manifest.expires_at ||
        snapshot.created_at !== manifest.created_at
      )
        throw new Error('nas_snapshot_scope');
      const contract = PersonalCloudSchema.parse(
        JSON.parse(String(snapshot.tables.research_personal_contracts[0].contract_json)),
      );
      if (
        sha(stable(contract)) !== c.contract_hash ||
        contract.decision.retention.backup.retention_days !== c.retention_days ||
        contract.decision.retention.backup.max_copies !== c.max_copies
      )
        throw new Error('nas_copy_contract_mismatch');
      const refreshed = await current(reader, c, opt.now(), previous);
      usable(refreshed, opt.now());
      // Intent precedes ciphertext: a crash cannot strand a copy without its absolute expiry.
      await atomic(
        receiptPath,
        stable({
          snapshot_hash: name,
          cipher_hash: null,
          created_at: manifest.created_at,
          expires_at: manifest.expires_at,
          verified_at: null,
        }),
      );
      cipher = await sealNas(opt.ageBinary, opt.recipient, plain);
      await durable(cipherPath, cipher);
    }
    // Never substitute a fixture cipher or treat encryption success as restore success.
    const decoded = await openNas(opt.ageBinary, opt.identityFile, cipher);
    if (sha(decoded) !== name) throw new Error('nas_snapshot_integrity');
    const latest = await current(reader, c, opt.now(), previous);
    usable(latest, opt.now());
    const proof = await verifyNasRestore(JSON.parse(decoded.toString()), latest, opt.now());
    const final = await current(reader, c, opt.now(), previous);
    usable(final, opt.now());
    if (final.review_hash !== latest.review_hash || final.sequence !== latest.sequence)
      throw new Error('nas_review_changed_during_restore');
    // Independent recovery material, not part of a data generation and never silently
    // used as "current" when R2 is unavailable. Recovery adoption needs owner review.
    const controlCipher = await sealNas(opt.ageBinary, opt.recipient, Buffer.from(stable(final)));
    const controlFile = join(dir, 'current-control.age'),
      controlTemp = controlFile + '.' + crypto.randomUUID() + '.tmp';
    await durable(controlTemp, controlCipher);
    await rename(controlTemp, controlFile);
    await atomic(
      receiptPath,
      stable(
        ReceiptSchema.parse({
          snapshot_hash: name,
          cipher_hash: sha(cipher),
          created_at: manifest.created_at,
          expires_at: manifest.expires_at,
          verified_at: at,
        }),
      ),
    );
    previous = { ...previous, last_verified_at: at, failures: 0, retry_at: null };
    await atomic(statePath, stable(previous));
    return {
      state: 'verified',
      observation_count: proof.observation_count,
      verified_at: at,
      removed: clean.removed,
    };
  } catch (error) {
    const failures = (previous?.failures ?? 0) + 1;
    const delay =
      error instanceof NasReadError && error.retryAfterSeconds !== null
        ? error.retryAfterSeconds
        : Math.min(86400, 300 * 2 ** Math.min(failures - 1, 8));
    const retryAt = new Date(Date.parse(at) + delay * 1000).toISOString();
    await atomic(backoffPath, stable({ failures, retry_at: retryAt }));
    if (previous) await atomic(statePath, stable({ ...previous, failures, retry_at: retryAt }));
    // No upstream payload, URL, credentials, key or arbitrary error string in operational output.
    const code =
      error instanceof NasReadError
        ? error.code
        : error instanceof Error && /^nas_[a-z_]+$/.test(error.message)
          ? error.message
          : 'nas_cycle_failed';
    return { state: 'failed', code, retry_at: retryAt };
  } finally {
    await unlock();
  }
}

export async function personalNasSources(
  sources: NasSource[],
  reader: (c: NasSource) => NasReader,
  opt: NasOptions,
) {
  const results = [];
  for (const c of sources) {
    try {
      results.push({ source_id: c.source_id, ...(await personalNasCycle(reader(c), c, opt)) });
    } catch {
      results.push({ source_id: c.source_id, state: 'failed', code: 'nas_initialization_failed' });
    }
  }
  return results;
}

// Owner-directed recovery to a NEW local staging DB. Normal scheduled maintenance uses
// ephemeral verification only. Never overwrite a primary DB or restore authority from a copy.
export async function restoreNasGeneration(
  reader: NasReader,
  input: unknown,
  opt: NasOptions,
  destination: string,
  approvalRef: string,
) {
  z.string().trim().min(1).max(500).parse(approvalRef);
  const c = NasSourceSchema.parse(input),
    at = opt.now(),
    root = await checkedLocalPath(opt.root),
    target = await checkedLocalPath(destination);
  if (!Number.isFinite(Date.parse(at))) throw new Error('nas_invalid_time');
  const rel = relative(root, target);
  if (!rel || !(rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)))
    throw new Error('nas_restore_separate_staging_required');
  // No directory creation before current authority and a usable copy have been verified.
  const dir = await checkedLocalPath(join(root, c.source_id)),
    sealed = await checkedLocalPath(join(dir, 'sealed')),
    unlock = await sourceLock(dir);
  const statePath = join(dir, 'state.json');
  let latestState: z.infer<typeof StateSchema> | null = null;
  try {
    const raw = await smallFile(statePath, 4096);
    if (!raw) throw new Error('nas_restore_receipt_required');
    const prior = StateSchema.parse(JSON.parse(raw.toString()));
    latestState = prior;
    if (prior.retry_at && prior.retry_at > at) throw new Error('nas_restore_backoff');
    const control = await current(reader, c, at, prior);
    const saved = {
      ...prior,
      sequence: control.sequence,
      review_hash: control.review_hash,
      checked_at: control.checked_at,
      denied: control.denied,
      storage_ends_at: control.storage_ends_at,
    };
    latestState = saved;
    await atomic(statePath, stable(saved));
    usable(control, at);
    const receipts = [];
    for (const file of await readdir(sealed)) {
      if (!/^[a-f0-9]{64}\.json$/.test(file)) continue;
      const body = await smallFile(join(sealed, file), 4096);
      if (!body) continue;
      const r = ReceiptSchema.parse(JSON.parse(body.toString()));
      if (file !== r.snapshot_hash + '.json') throw new Error('nas_receipt_scope');
      if (r.verified_at && r.cipher_hash && r.created_at <= at && r.expires_at > at)
        receipts.push(r);
    }
    const receipt = receipts.sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
    if (!receipt) throw new Error('nas_restore_receipt_required');
    const cipher = await smallFile(join(sealed, receipt.snapshot_hash + '.age'));
    if (!cipher || sha(cipher) !== receipt.cipher_hash) throw new Error('nas_cipher_integrity');
    const plain = await openNas(opt.ageBinary, opt.identityFile, cipher);
    if (sha(plain) !== receipt.snapshot_hash) throw new Error('nas_snapshot_integrity');
    const snapshot = PersonalSnapshotSchema.parse(JSON.parse(plain.toString()));
    if (
      snapshot.contract_hash !== c.contract_hash ||
      snapshot.created_at !== receipt.created_at ||
      snapshot.expires_at !== receipt.expires_at
    )
      throw new Error('nas_snapshot_scope');
    const contract = PersonalCloudSchema.parse(
      JSON.parse(String(snapshot.tables.research_personal_contracts[0].contract_json)),
    );
    if (
      sha(stable(contract)) !== c.contract_hash ||
      contract.decision.retention.backup.retention_days !== c.retention_days ||
      contract.decision.retention.backup.max_copies !== c.max_copies
    )
      throw new Error('nas_copy_contract_mismatch');
    // Current summary may reference a newer generation; fetch the chosen copy's immutable proof.
    const key =
      'research-control/personal-backups/' +
      c.source_id +
      '/' +
      contract.decision.exception_id +
      '/' +
      receipt.snapshot_hash +
      '.json';
    const proof = await reader.get('personal-research/control/' + c.source_id + '/' + key);
    if (!proof) throw new Error('nas_restore_manifest_missing');
    const latest = await current(reader, c, opt.now(), saved);
    usable(latest, opt.now());
    latest.records[key] = Buffer.from(proof).toString();
    const result = await verifyNasRestore(snapshot, latest, opt.now(), target);
    const final = await current(reader, c, opt.now(), saved);
    usable(final, opt.now());
    if (
      final.sequence !== latest.sequence ||
      final.review_hash !== latest.review_hash ||
      final.storage_ends_at !== latest.storage_ends_at
    )
      throw new Error('nas_review_changed_during_restore');
    await durable(
      join(target, 'restore-complete.json'),
      stable({
        ...result,
        source_id: c.source_id,
        snapshot_hash: receipt.snapshot_hash,
        contract_hash: c.contract_hash,
        current_review_hash: final.review_hash,
        restore_approval_ref: approvalRef,
      }),
    );
    return result;
  } finally {
    try {
      if (latestState) await atomic(statePath, stable(latestState));
    } finally {
      await unlock();
    }
  }
}
