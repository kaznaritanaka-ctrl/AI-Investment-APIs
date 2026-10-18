import { z } from 'zod';
import { hash, stable } from '../util';
import { PublicGpuRecordSchema, gpuRecordFingerprint } from './public-gpu-html';
import { assertNotRevoked } from './retention';
import { personalRunId, personalReviewHead, syncPersonalReviewAudit } from './personal-review';
import {
  validatePersonalState,
  verifyPersonalRun,
  maintainPersonalGpu,
  personalAttemptKey,
  type PersonalEnv,
  type PersonalOptions,
  type PersonalRun,
} from './personal';
import type { PersonalContract, PersonalV2Contract } from './personal-contract';

const columns = {
  research_sources: 'source_id,policy_version,config_hash,suspended',
  research_personal_contracts: 'contract_hash,source_id,exception_id,config_hash,contract_json',
  research_runs:
    'run_id,source_id,config_hash,query_hash,policy_version,terms_version,scheduled_for,recorded_at,synthetic,state,next_page,observation_count,http_page_attempts,last_error,retry_at,lease_token,lease_until,evidence_expires_at,evidence_purged_at,normalized_expires_at,retention_snapshot_json,all_copies_expires_at,deleted_at,backup_residual_until,normalized_mode',
  research_personal_runs: 'run_id,contract_hash',
  research_gpu_observations:
    'observation_id,run_id,page_number,record_key,source_url,method_version,observed_at,recorded_at,record_hash,previous_observation_id,change_kind,domain_json',
} as const;
type Table = keyof typeof columns;
const row = z.record(z.string(), z.union([z.string().max(131072), z.number().finite(), z.null()]));
export const PersonalSnapshotSchema = z
  .object({
    version: z.literal('personal-snapshot-v1'),
    contract_hash: z.string().regex(/^[a-f0-9]{64}$/),
    run_id: z.string().regex(/^[a-f0-9]{64}$/),
    store_id: z.string(),
    data_origin: z.enum(['synthetic', 'live']),
    created_at: z.iso.datetime(),
    expires_at: z.iso.datetime(),
    review_hash: z.string(),
    tables: z
      .object({
        research_sources: z.array(row).length(1),
        research_personal_contracts: z.array(row).length(1),
        research_runs: z.array(row).length(1),
        research_personal_runs: z.array(row).length(1),
        research_gpu_observations: z.array(row).max(48),
      })
      .strict(),
  })
  .strict();
export type PersonalSnapshot = z.infer<typeof PersonalSnapshotSchema>;
const manifestKey = (c: PersonalContract, digest: string) =>
  'research-control/personal-backups/' +
  c.config.source.source_id +
  '/' +
  c.decision.exception_id +
  '/' +
  digest +
  '.json';
export async function personalBackupManifest(
  env: PersonalEnv,
  c: PersonalV2Contract,
  digest: string,
) {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('personal_backup_id_invalid');
  const obj = await env.EVIDENCE.get(manifestKey(c, digest));
  if (!obj || obj.size > 8192) throw new Error('personal_backup_manifest_missing');
  const m = z
    .object({
      contract_hash: z.string(),
      run_id: z.string(),
      snapshot_hash: z.string(),
      created_at: z.iso.datetime(),
      expires_at: z.iso.datetime(),
    })
    .strict()
    .parse(await obj.json());
  if (
    m.contract_hash !== (await hash(stable(c))) ||
    m.run_id !== (await personalRunId(c)) ||
    m.snapshot_hash !== digest ||
    m.expires_at <= m.created_at ||
    Date.parse(m.expires_at) - Date.parse(m.created_at) >
      c.decision.retention.backup.retention_days * 86400000
  )
    throw new Error('personal_backup_manifest_invalid');
  return m;
}
function nowFor(env: PersonalEnv, opt: PersonalOptions) {
  if (env.ENVIRONMENT !== 'test' && (opt.now || opt.fetcher))
    throw new Error('personal_synthetic_boundary');
  return (opt.now ?? (() => new Date().toISOString()))();
}
async function copyAuthority(env: PersonalEnv, input: unknown, at: string) {
  const validated = await validatePersonalState(env, input, at, 'maintain');
  const c = validated.contract;
  if (c.version !== 'personal-gpu-v2') throw new Error('personal_backup_v2_required');
  const head = (await personalReviewHead(env, c, true))!;
  if (head.head.storage_state !== 'continuing') throw new Error('personal_storage_review_required');
  if (head.head.storage_ends_at && at >= head.head.storage_ends_at)
    throw new Error('personal_storage_expired');
  await assertNotRevoked(env, c.config.source.source_id, await personalRunId(c));
  return { c, digest: validated.contract_hash, head };
}
async function validateSnapshot(c: PersonalV2Contract, s: PersonalSnapshot) {
  if (
    s.contract_hash !== (await hash(stable(c))) ||
    s.run_id !== (await personalRunId(c)) ||
    s.store_id !== c.decision.retention.store_id ||
    s.data_origin !== c.data_origin ||
    s.created_at >= s.expires_at ||
    Date.parse(s.expires_at) - Date.parse(s.created_at) >
      c.decision.retention.backup.retention_days * 86400000
  )
    throw new Error('personal_snapshot_scope_invalid');
  for (const table of Object.keys(columns) as Table[])
    for (const r of s.tables[table])
      if (Object.keys(r).sort().join(',') !== columns[table].split(',').sort().join(','))
        throw new Error('personal_snapshot_columns_invalid');
  const run = s.tables.research_runs[0] as unknown as PersonalRun;
  verifyPersonalRun(c, s.contract_hash, run);
  const rawRun = s.tables.research_runs[0];
  if (
    run.run_id !== s.run_id ||
    rawRun.source_id !== c.config.source.source_id ||
    rawRun.policy_version !== c.config.source.policy.version ||
    rawRun.terms_version !== c.decision.terms.version ||
    rawRun.query_hash !== (await hash(stable(c.config.scope))) ||
    rawRun.normalized_mode !== 'owner_continuing' ||
    run.state !== 'complete' ||
    run.observation_count !== s.tables.research_gpu_observations.length ||
    run.lease_token ||
    run.lease_until ||
    run.recorded_at > s.created_at
  )
    throw new Error('personal_snapshot_incomplete');
  const source = s.tables.research_sources[0],
    contract = s.tables.research_personal_contracts[0],
    link = s.tables.research_personal_runs[0];
  if (
    source.source_id !== c.config.source.source_id ||
    source.config_hash !== s.contract_hash ||
    source.suspended !== 0 ||
    contract.contract_hash !== s.contract_hash ||
    contract.source_id !== source.source_id ||
    contract.exception_id !== c.decision.exception_id ||
    contract.config_hash !== c.config_sha256 ||
    contract.contract_json !== stable(c) ||
    link.contract_hash !== s.contract_hash ||
    link.run_id !== s.run_id
  )
    throw new Error('personal_snapshot_scope_invalid');
  const ids = new Set();
  for (const r of s.tables.research_gpu_observations) {
    const domain = PublicGpuRecordSchema.parse(JSON.parse(String(r.domain_json)));
    if (
      r.run_id !== s.run_id ||
      r.source_url !== c.config.source.source_url ||
      r.method_version !== c.config.method_version ||
      r.record_key !== domain.record_key ||
      r.record_hash !== (await gpuRecordFingerprint(domain)) ||
      r.observation_id !== (await hash(stable([s.run_id, r.record_key, r.record_hash]))) ||
      r.change_kind !== 'first_seen' ||
      r.previous_observation_id !== null ||
      r.page_number !== 0 ||
      String(r.observed_at) < run.recorded_at ||
      String(r.recorded_at) > s.created_at ||
      ids.has(r.observation_id)
    )
      throw new Error('personal_snapshot_record_invalid');
    ids.add(r.observation_id);
  }
}

// Only the initial <=48 normalized observations and their provenance. No raw/short evidence,
// SQL program, public tables, key material or old control state enters a backup.
export async function createPersonalSnapshot(
  env: PersonalEnv,
  input: unknown,
  opt: PersonalOptions = {},
) {
  const at = nowFor(env, opt);
  await maintainPersonalGpu(env, input, opt);
  const { c, digest, head } = await copyAuthority(env, input, at),
    runId = await personalRunId(c),
    lease = crypto.randomUUID();
  const locked = await env.PRIVATE_DB.prepare(
    "UPDATE research_runs SET lease_token=?,lease_until=? WHERE run_id=? AND state='complete' AND (lease_until IS NULL OR lease_until<=?)",
  )
    .bind(lease, new Date(Date.parse(at) + 300000).toISOString(), runId, at)
    .run();
  if (!locked.meta.changes) throw new Error('personal_snapshot_not_ready');
  try {
    const tables = {} as PersonalSnapshot['tables'];
    const names = Object.keys(columns) as Table[];
    const batch = await env.PRIVATE_DB.batch(
      names.map((table) =>
        env.PRIVATE_DB.prepare(
          `SELECT ${columns[table]} FROM ${table} WHERE ${table === 'research_sources' ? 'source_id' : table === 'research_personal_contracts' ? 'contract_hash' : 'run_id'}=? ORDER BY 1 LIMIT 49`,
        ).bind(
          table === 'research_sources'
            ? c.config.source.source_id
            : table === 'research_personal_contracts'
              ? digest
              : runId,
        ),
      ),
    );
    names.forEach((name, i) => {
      tables[name] = batch[i].results as PersonalSnapshot['tables'][Table];
    });
    tables.research_runs[0].lease_token = null;
    tables.research_runs[0].lease_until = null;
    const s = PersonalSnapshotSchema.parse({
      version: 'personal-snapshot-v1',
      contract_hash: digest,
      run_id: runId,
      store_id: c.decision.retention.store_id,
      data_origin: c.data_origin,
      created_at: at,
      expires_at: new Date(
        Date.parse(at) + c.decision.retention.backup.retention_days * 86400000,
      ).toISOString(),
      review_hash: head.head.review_hash,
      tables,
    });
    await validateSnapshot(c, s);
    const body = stable(s);
    if (new TextEncoder().encode(body).length > 524288)
      throw new Error('personal_snapshot_too_large');
    const latest = await copyAuthority(env, c, nowFor(env, opt));
    if (latest.head.etag !== head.etag) throw new Error('personal_review_conflict');
    const snapshotHash = await hash(body);
    await env.EVIDENCE.put(
      manifestKey(c, snapshotHash),
      stable({
        contract_hash: digest,
        run_id: runId,
        snapshot_hash: snapshotHash,
        created_at: s.created_at,
        expires_at: s.expires_at,
      }),
      { onlyIf: { etagDoesNotMatch: '*' } },
    );
    return { snapshot: s, snapshot_hash: snapshotHash };
  } finally {
    await env.PRIVATE_DB.prepare(
      'UPDATE research_runs SET lease_token=NULL,lease_until=NULL WHERE run_id=? AND lease_token=?',
    )
      .bind(runId, lease)
      .run();
  }
}

export async function checkPersonalSnapshot(
  env: PersonalEnv,
  input: unknown,
  payload: unknown,
  opt: PersonalOptions = {},
) {
  const at = nowFor(env, opt),
    { c } = await copyAuthority(env, input, at),
    s = PersonalSnapshotSchema.parse(payload);
  await validateSnapshot(c, s);
  if (at < s.created_at || at >= s.expires_at) throw new Error('personal_backup_expired');
  const digest = await hash(stable(s)),
    manifest = await env.EVIDENCE.get(manifestKey(c, digest));
  if (!manifest || manifest.size > 8192) throw new Error('personal_backup_manifest_missing');
  const m = await manifest.json<{
    snapshot_hash: string;
    contract_hash: string;
    run_id: string;
    created_at: string;
    expires_at: string;
  }>();
  if (
    m.snapshot_hash !== digest ||
    m.contract_hash !== s.contract_hash ||
    m.run_id !== s.run_id ||
    m.created_at !== s.created_at ||
    m.expires_at !== s.expires_at
  )
    throw new Error('personal_backup_manifest_invalid');
  const reservation = await env.EVIDENCE.get(personalAttemptKey(c));
  if (!reservation || reservation.size > 8192) throw new Error('personal_attempt_missing');
  const r = await reservation.json<{ contract_hash: string; run_id: string; started_at: string }>();
  if (
    r.contract_hash !== s.contract_hash ||
    r.run_id !== s.run_id ||
    r.started_at !== s.tables.research_runs[0].recorded_at
  )
    throw new Error('personal_capture_time_mismatch');
  return { c, s, digest };
}

// Destination must be a fresh staging database. Preserve the current CONTROL store.
// Partial imports stay unreadable; retry uses a new empty staging database, never deletes a live DB.
export async function restorePersonalSnapshot(
  env: PersonalEnv,
  input: unknown,
  payload: unknown,
  opt: PersonalOptions = {},
) {
  const { c, s, digest } = await checkPersonalSnapshot(env, input, payload, opt);
  for (const table of Object.keys(columns) as Table[])
    if (await env.PRIVATE_DB.prepare(`SELECT 1 FROM ${table} LIMIT 1`).first())
      throw new Error('personal_restore_destination_not_empty');
  const tables = structuredClone(s.tables);
  tables.research_runs[0].state = 'partial';
  tables.research_runs[0].evidence_purged_at = nowFor(env, opt);
  for (const table of Object.keys(columns) as Table[]) {
    const names = columns[table].split(',');
    for (let offset = 0; offset < tables[table].length; offset += 20) {
      await checkPersonalSnapshot(env, c, s, opt);
      await env.PRIVATE_DB.batch(
        tables[table]
          .slice(offset, offset + 20)
          .map((row) =>
            env.PRIVATE_DB.prepare(
              `INSERT INTO ${table}(${columns[table]}) VALUES (${names.map(() => '?').join(',')})`,
            ).bind(...names.map((name) => row[name])),
          ),
      );
    }
  }
  await checkPersonalSnapshot(env, c, s, opt);
  await syncPersonalReviewAudit(env, c);
  await env.PRIVATE_DB.prepare(
    "UPDATE research_runs SET state='complete' WHERE run_id=? AND state='partial'",
  )
    .bind(s.run_id)
    .run();
  await maintainPersonalGpu(env, c, opt);
  return {
    state: 'restored',
    snapshot_hash: digest,
    observation_count: s.tables.research_gpu_observations.length,
    short_evidence_restored: false,
  };
}
