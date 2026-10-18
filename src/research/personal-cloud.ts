import { z } from 'zod';
import { hash, stable } from '../util';
import { PersonalCloudSchema, type PersonalCloudContract } from './personal-contract';
import { inspectPersonalAuthority, type CloudPersonalBinding } from './personal-cloud-authority';
import {
  maintainPersonalGpu,
  personalAttemptKey,
  type PersonalEnv,
  type PersonalOptions,
} from './personal';
import {
  createPersonalSnapshot,
  checkPersonalSnapshot,
  PersonalSnapshotSchema,
} from './personal-snapshot';
import { personalHeadKey, personalReviewHead, personalRunId } from './personal-review';
import { sourceRevocationKey, runDeletionKey } from './retention';

export const cloudSource = z.enum(['highreso_public', 'rebro_public']);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const instant = z.iso.datetime();
const bytesHash = async (value: ArrayBuffer | Uint8Array<ArrayBuffer>) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', value)))
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');
export const CloudManifestSchema = z
  .object({
    version: z.literal('personal-cloud-backup-v1'),
    source_id: cloudSource,
    contract_hash: digest,
    snapshot_hash: digest,
    created_at: instant,
    expires_at: instant,
    complete: z.literal(true),
    bytes: z.number().int().min(1).max(524288),
    chunks: z
      .array(
        z
          .object({ key: z.string(), sha256: digest, bytes: z.number().int().min(1).max(131072) })
          .strict(),
      )
      .min(1)
      .max(4),
  })
  .strict();
export const CloudControlSchema = z
  .object({
    version: z.literal('personal-cloud-control-v1'),
    source_id: cloudSource,
    contract_hash: digest,
    checked_at: instant,
    sequence: z.number().int().min(0),
    review_hash: digest,
    storage_state: z.enum(['continuing', 'unknown']),
    storage_ends_at: instant.nullable(),
    review_after: instant,
    analysis_until: instant,
    denied: z.boolean(),
    latest_manifest: z.string().nullable(),
    records: z.record(z.string(), z.string().max(16384)),
  })
  .strict()
  .refine(
    (v) =>
      Object.keys(v.records).length <= 10 && new TextEncoder().encode(stable(v)).length <= 131072,
    'personal_control_size',
  );
export const cloudRoot = (source: string) =>
  'personal-research/backups/' + cloudSource.parse(source) + '/';
export const cloudControlKey = (source: string) =>
  'personal-research/control/' + cloudSource.parse(source) + '/current.json';

// Source-specific capability projection; PUBLIC_DB is never passed into personal code.
export function cloudPersonalEnv(
  base: { PRIVATE_DB: D1Database; EVIDENCE: R2Bucket; ENVIRONMENT: PersonalEnv['ENVIRONMENT'] },
  c: PersonalCloudContract,
  binding: CloudPersonalBinding,
): PersonalEnv {
  const source = cloudSource.parse(c.config.source.source_id),
    bucket = base.EVIDENCE;
  const map = (key: string) => {
    if (key.includes('..') || key.includes('\\')) throw new Error('personal_key_invalid');
    if (key.startsWith('research-control/'))
      return 'personal-research/control/' + source + '/' + key;
    if (key.startsWith('research/personal/' + source + '/'))
      return (
        'personal-research/evidence/' +
        source +
        '/' +
        key.slice(('research/personal/' + source + '/').length)
      );
    throw new Error('personal_key_forbidden');
  };
  const routed = new Proxy(bucket, {
    get(_target, property) {
      if (['get', 'put', 'head'].includes(String(property)))
        return (key: string, ...args: unknown[]) =>
          Reflect.apply(Reflect.get(bucket, property), bucket, [map(key), ...args]);
      if (property === 'delete')
        return async (keys: string | string[]) => {
          for (const key of typeof keys === 'string' ? [keys] : keys) {
            if (key.startsWith('research-control/'))
              throw new Error('personal_control_delete_forbidden');
            await bucket.delete(map(key));
          }
        };
      throw new Error('personal_bucket_operation_forbidden');
    },
  });
  return {
    PRIVATE_DB: base.PRIVATE_DB,
    EVIDENCE: routed,
    ENVIRONMENT: base.ENVIRONMENT,
    PERSONAL_STORE_ID: c.decision.retention.store_id,
    PERSONAL_CLOUD: binding,
  };
}
async function readJSON(bucket: R2Bucket, key: string, max = 16384) {
  const o = await bucket.get(key);
  if (!o) return null;
  if (o.size > max) throw new Error('personal_export_size');
  return o.text();
}
// Current authority is refreshed independently of backup generation; never restored from a snapshot.
export async function syncCloudControl(
  env: PersonalEnv,
  bucket: R2Bucket,
  c: PersonalCloudContract,
  at: string,
  manifest?: string,
) {
  const { contract_hash } = await inspectPersonalAuthority(env, c, at, 'maintain');
  const current = await personalReviewHead(env, c, true);
  if (!current) throw new Error('personal_current_review_missing');
  const run = await personalRunId(c),
    prefix = c.config.source.source_id + '/' + c.decision.exception_id;
  const keys = [
    personalHeadKey(c),
    personalAttemptKey(c),
    'research-control/personal-captures/' + prefix + '.json',
    sourceRevocationKey(c.config.source.source_id),
    runDeletionKey(c.config.source.source_id, run),
    'research-control/personal-cloud-first/' + c.config.source.source_id + '.json',
  ];
  if (current.head.sequence)
    keys.push(
      'research-control/personal-reviews/' + prefix + '/' + current.head.review_hash + '.json',
    );
  const records: Record<string, string> = {};
  for (const key of keys) {
    const text = await readJSON(env.EVIDENCE, key);
    if (text !== null) records[key] = text;
  }
  const key = cloudControlKey(c.config.source.source_id),
    prior = await bucket.get(key);
  if (prior && prior.size > 131072) throw new Error('personal_control_size');
  const old = prior ? CloudControlSchema.parse(await prior.json()) : null;
  if (
    old &&
    (old.contract_hash !== contract_hash ||
      old.sequence > current.head.sequence ||
      old.checked_at > at)
  )
    throw new Error('personal_control_conflict');
  let latest = manifest ?? old?.latest_manifest ?? null;
  if (latest) {
    const raw = await readJSON(bucket, latest);
    const m = raw ? CloudManifestSchema.parse(JSON.parse(raw)) : null;
    if (!m || m.expires_at <= at) latest = null;
    else {
      const mk = 'research-control/personal-backups/' + prefix + '/' + m.snapshot_hash + '.json';
      const value = await readJSON(env.EVIDENCE, mk);
      if (!value) throw new Error('personal_backup_manifest_missing');
      records[mk] = value;
    }
  }
  const body = CloudControlSchema.parse({
    version: 'personal-cloud-control-v1',
    source_id: c.config.source.source_id,
    contract_hash,
    checked_at: at,
    sequence: current.head.sequence,
    review_hash: current.head.review_hash,
    storage_state: current.head.storage_state,
    storage_ends_at: current.head.storage_ends_at,
    review_after: current.head.review_after,
    analysis_until: current.head.analysis_until,
    denied:
      (old?.denied ?? false) ||
      !!records[keys[3]] ||
      !!records[keys[4]] ||
      !!(current.head.storage_ends_at && at >= current.head.storage_ends_at),
    latest_manifest: latest,
    records,
  });
  if (
    !(await bucket.put(key, stable(body), {
      onlyIf: prior ? { etagMatches: prior.etag } : { etagDoesNotMatch: '*' },
    }))
  )
    throw new Error('personal_control_conflict');
  return body;
}

// One <=128KiB chunk per call. A complete manifest is the sole NAS admission point.
export async function exportCloudPersonal(
  env: PersonalEnv,
  bucket: R2Bucket,
  input: unknown,
  opt: PersonalOptions = {},
) {
  const c = PersonalCloudSchema.parse(input),
    at = (opt.now ?? (() => new Date().toISOString()))();
  await inspectPersonalAuthority(env, c, at, 'maintain');
  const maintenance = await maintainPersonalGpu(env, c, opt);
  if (maintenance.state === 'no_run') return { state: 'no_run' };
  if (['purged', 'storage_unknown', 'leased'].includes(maintenance.state)) {
    if (maintenance.state !== 'leased') await syncCloudControl(env, bucket, c, at);
    return { state: maintenance.state };
  }
  const root =
      cloudRoot(c.config.source.source_id) + (await hash(stable(c))) + '/' + at.slice(0, 10) + '/',
    leaseKey = root + 'lease.json';
  const prior = await bucket.get(leaseKey);
  if (prior && prior.size > 1024) throw new Error('personal_lease_invalid');
  const old = prior
    ? z
        .object({ until: instant })
        .strict()
        .parse(await prior.json())
    : null;
  if (old && old.until > at) return { state: 'leased' };
  const lease = await bucket.put(
    leaseKey,
    stable({ until: new Date(Date.parse(at) + 300000).toISOString() }),
    {
      onlyIf: prior ? { etagMatches: prior.etag } : { etagDoesNotMatch: '*' },
      customMetadata: { expires_at: new Date(Date.parse(at) + 86400000).toISOString() },
    },
  );
  if (!lease) return { state: 'leased' };
  const guardLease = async () => {
    const now = (opt.now ?? (() => new Date().toISOString()))();
    if (
      now >= new Date(Date.parse(at) + 300000).toISOString() ||
      (await bucket.head(leaseKey))?.etag !== lease.etag
    )
      throw new Error('personal_export_lease_lost');
  };
  try {
    const draftKey = root + 'snapshot.json',
      saved = await readJSON(bucket, draftKey, 524288);
    const snapshot = saved
      ? PersonalSnapshotSchema.parse(JSON.parse(saved))
      : (await createPersonalSnapshot(env, c, opt)).snapshot;
    await checkPersonalSnapshot(env, c, snapshot, opt);
    const body = stable(snapshot),
      bytes = new TextEncoder().encode(body);
    await guardLease();
    if (
      !saved &&
      !(await bucket.put(draftKey, bytes, {
        onlyIf: { etagDoesNotMatch: '*' },
        customMetadata: { expires_at: snapshot.expires_at },
      }))
    )
      throw new Error('personal_export_conflict');
    const chunks = [];
    let wrote = false,
      pending = false;
    for (let offset = 0, index = 0; offset < bytes.length; offset += 131072, index++) {
      const part = bytes.slice(offset, offset + 131072),
        sha256 = await bytesHash(part),
        key = root + 'part-' + index + '.json';
      const obj = await bucket.get(key);
      if (obj) {
        if (obj.size !== part.length || (await bytesHash(await obj.arrayBuffer())) !== sha256)
          throw new Error('personal_chunk_conflict');
      } else if (!wrote) {
        await guardLease();
        if (
          !(await bucket.put(key, part, {
            onlyIf: { etagDoesNotMatch: '*' },
            customMetadata: { expires_at: snapshot.expires_at },
          }))
        )
          throw new Error('personal_export_conflict');
        wrote = true;
      } else pending = true;
      chunks.push({ key, sha256, bytes: part.length });
    }
    if (pending) return { state: 'partial' };
    await guardLease();
    await checkPersonalSnapshot(env, c, snapshot, opt);
    const manifest = CloudManifestSchema.parse({
      version: 'personal-cloud-backup-v1',
      source_id: c.config.source.source_id,
      contract_hash: snapshot.contract_hash,
      snapshot_hash: await hash(body),
      created_at: snapshot.created_at,
      expires_at: snapshot.expires_at,
      complete: true,
      bytes: bytes.length,
      chunks,
    });
    const key = root + 'manifest.json';
    const completed = await bucket.put(key, stable(manifest), {
      onlyIf: { etagDoesNotMatch: '*' },
      customMetadata: { expires_at: snapshot.expires_at },
    });
    if (!completed && (await readJSON(bucket, key)) !== stable(manifest))
      throw new Error('personal_export_conflict');
    await syncCloudControl(env, bucket, c, at, key);
    return { state: 'complete', manifest: key };
  } finally {
    await bucket.put(leaseKey, stable({ until: at }), {
      onlyIf: { etagMatches: lease.etag },
      customMetadata: { expires_at: new Date(Date.parse(at) + 86400000).toISOString() },
    });
  }
}

// Bounded, resumable R2 cleanup. No D1 history-age deletion or current-control TTL.
export async function cleanCloudPersonal(bucket: R2Bucket, source: string, at: string) {
  const prefix = cloudRoot(source),
    key = 'personal-research/control/' + cloudSource.parse(source) + '/cleanup.json';
  const checkpoint = await bucket.get(key);
  if (checkpoint && checkpoint.size > 8192) throw new Error('personal_cleanup_checkpoint_invalid');
  const state = checkpoint
    ? z
        .object({ cursor: z.string().max(4096).optional() })
        .strict()
        .parse(await checkpoint.json())
    : {};
  const currentText = await readJSON(bucket, cloudControlKey(source), 131072);
  const denied = currentText ? CloudControlSchema.parse(JSON.parse(currentText)).denied : false;
  const page = await bucket.list({
    prefix,
    limit: 20,
    cursor: state.cursor,
    include: ['customMetadata'],
  });
  let deleted = 0;
  for (const obj of page.objects)
    if (denied || (obj.customMetadata?.expires_at && obj.customMetadata.expires_at <= at)) {
      await bucket.delete(obj.key);
      deleted++;
    }
  if (
    !(await bucket.put(key, stable(page.truncated ? { cursor: page.cursor } : {}), {
      onlyIf: checkpoint ? { etagMatches: checkpoint.etag } : { etagDoesNotMatch: '*' },
    }))
  )
    throw new Error('personal_cleanup_conflict');
  return { deleted, more: page.truncated };
}
