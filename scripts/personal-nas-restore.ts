import { CloudControlSchema } from '../src/research/personal-cloud';
import { PersonalCloudSchema } from '../src/research/personal-contract';
import { PersonalSnapshotSchema, restorePersonalSnapshot } from '../src/research/personal-snapshot';
import { hash, stable } from '../src/util';
import { personalLocalEnv } from './personal-local-env';
import type { PersonalEnv } from '../src/research/personal';
import { mkdir } from 'node:fs/promises';
import { checkedLocalPath } from './personal-vault';

// Fresh local D1 only; persistence requires an explicitly selected, nonexistent staging path.
// No R2 write, remote SQL or primary DB overwrite.
export async function verifyNasRestore(
  payload: unknown,
  controlInput: unknown,
  at: string,
  destination?: string,
) {
  const snapshot = PersonalSnapshotSchema.parse(payload),
    control = CloudControlSchema.parse(controlInput);
  const contract = PersonalCloudSchema.parse(
    JSON.parse(String(snapshot.tables.research_personal_contracts[0].contract_json)),
  );
  if (
    snapshot.contract_hash !== control.contract_hash ||
    control.source_id !== contract.config.source.source_id ||
    (await hash(stable(contract))) !== control.contract_hash ||
    control.denied ||
    control.storage_state !== 'continuing' ||
    (control.storage_ends_at && control.storage_ends_at <= at) ||
    control.checked_at > at ||
    Date.parse(at) - Date.parse(control.checked_at) > 48 * 3600000
  )
    throw new Error('nas_current_authority_required');
  if (destination) {
    await checkedLocalPath(destination);
    await mkdir(destination, { recursive: false, mode: 0o700 });
  }
  const local = await personalLocalEnv(contract.decision.retention.store_id, 'test', destination);
  const objects = new Map(Object.entries(control.records));
  const bucket = {
    get: async (key: string) => {
      const text = objects.get(key);
      return text === undefined
        ? null
        : {
            size: new TextEncoder().encode(text).length,
            etag: await hash(text),
            text: async () => text,
            json: async () => JSON.parse(text),
          };
    },
    head: async (key: string) =>
      objects.has(key) ? { etag: await hash(objects.get(key)!) } : null,
    delete: async (key: string) => {
      if (!key.startsWith('research/personal/')) throw new Error('nas_control_write_forbidden');
    },
  } as unknown as R2Bucket;
  try {
    const env: PersonalEnv = {
      ...local.env,
      EVIDENCE: bucket,
      ENVIRONMENT: contract.data_origin === 'synthetic' ? 'test' : 'production',
      PERSONAL_CLOUD: {
        contract_hash: control.contract_hash,
        account_id: contract.cloud.account_id,
        private_database_id: contract.cloud.private_database_id,
        bucket: contract.cloud.bucket,
      },
    };
    const result = await restorePersonalSnapshot(
      env,
      contract,
      snapshot,
      contract.data_origin === 'synthetic' ? { now: () => at } : {},
    );
    const integrity = await env.PRIVATE_DB.prepare('PRAGMA quick_check').all();
    const foreign = await env.PRIVATE_DB.prepare('PRAGMA foreign_key_check').all();
    if (JSON.stringify(integrity.results) !== '[{"quick_check":"ok"}]' || foreign.results.length)
      throw new Error('nas_restore_integrity_failed');
    let immutable = false;
    try {
      await env.PRIVATE_DB.prepare("UPDATE research_gpu_observations SET domain_json='{}'").run();
    } catch {
      immutable = true;
    }
    if (result.observation_count && !immutable) throw new Error('nas_restore_immutable_failed');
    return {
      state: destination ? 'restored_staging' : 'verified',
      observation_count: result.observation_count,
      checked_at: at,
      remote_writes: false,
      short_evidence_restored: false,
    };
  } finally {
    await local.mf.dispose();
  }
}
