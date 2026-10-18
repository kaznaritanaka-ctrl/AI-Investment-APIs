import {
  personalReviewHead,
  initializePersonalReview,
  syncPersonalReviewAudit,
} from './personal-review';
import { z } from 'zod';
import { errorCode, hash, stable } from '../util';
import { FetchFailure } from '../network';
import { parsePublicGpu, PublicGpuPageSchema, gpuRecordFingerprint } from './public-gpu-html';
import { gpuReviewErrors, readReviewedPublicGpu } from './public-gpu-network';
import {
  assertNotRevoked,
  recordDeletion,
  deletionObligation,
  sourceRevocation,
  type RetainedRun,
} from './retention';
import {
  inspectPersonalContract,
  personalDeadlines,
  type PersonalContract,
} from './personal-contract';
import type { ResearchEnv } from './pipeline';

export type PersonalEnv = ResearchEnv & { PERSONAL_STORE_ID: string };
export type PersonalOptions = {
  allow_network?: boolean;
  fetcher?: typeof fetch;
  now?: () => string;
};
const authority = 'owner_personal_research_exception';
const captureSchema = z
  .object({
    version: z.literal('personal-gpu-projection-v1'),
    authority_kind: z.literal(authority),
    provider_permission: z.literal('unconfirmed'),
    contract_hash: z.string(),
    config_hash: z.string(),
    source_id: z.string(),
    source_policy_version: z.string(),
    terms_version: z.string(),
    method_version: z.string(),
    observed_at: z.iso.datetime(),
    synthetic: z.boolean(),
    payload_hash: z.string(),
    page: PublicGpuPageSchema,
  })
  .strict();
const attemptSchema = z
  .object({
    contract_hash: z.string(),
    run_id: z.string(),
    source_id: z.string(),
    started_at: z.iso.datetime(),
  })
  .strict();
export type PersonalRun = RetainedRun & {
  run_id: string;
  config_hash: string;
  recorded_at: string;
  synthetic: number;
  state: string;
  normalized_expires_at: string | null;
  evidence_expires_at: string;
  all_copies_expires_at: string | null;
  retention_snapshot_json: string;
  observation_count: number;
  http_page_attempts: number;
  lease_until: string | null;
  lease_token: string | null;
};
const prefix = (c: PersonalContract) => c.config.source.source_id + '/' + c.decision.exception_id;
export const personalAttemptKey = (c: PersonalContract) =>
  'research-control/personal-attempts/' + prefix(c) + '.json';
const collectionStopKey = (c: PersonalContract) =>
  'research-control/personal-stops/' + c.config.source.source_id + '.json';
const evidenceKey = (c: PersonalContract, runId: string) =>
  'research/personal/' + c.config.source.source_id + '/' + runId + '/0.json';
const manifestKey = (c: PersonalContract) =>
  'research-control/personal-captures/' + prefix(c) + '.json';
const runIdFor = (c: PersonalContract) =>
  hash(stable(['personal-gpu-v1', prefix(c), c.data_origin]));

function clock(env: PersonalEnv, opt: PersonalOptions) {
  if (env.ENVIRONMENT !== 'test' && env.ENVIRONMENT !== 'development')
    throw new Error('personal_production_forbidden');
  if (env.ENVIRONMENT !== 'test' && (opt.fetcher || opt.now))
    throw new Error('personal_synthetic_boundary');
  return opt.now ?? (() => new Date().toISOString());
}
export async function validatePersonalState(
  env: PersonalEnv,
  input: unknown,
  at: string,
  operation: 'collect' | 'read' | 'maintain',
) {
  const result = await inspectPersonalContract(input, at, env.ENVIRONMENT, 'maintain');
  if (result.contract.decision.retention.store_id !== env.PERSONAL_STORE_ID)
    throw new Error('personal_store_mismatch');
  const c = result.contract;
  if (c.version === 'personal-gpu-v1')
    return {
      ...(await inspectPersonalContract(input, at, env.ENVIRONMENT, operation)),
      current_review: null,
    };
  if ('PUBLIC_DB' in env) throw new Error('personal_public_binding_forbidden');
  const run = await runRow(env, await runIdFor(c));
  const current = await personalReviewHead(env, c, !!run);
  if (current && at < current.head.approved_at) throw new Error('personal_review_not_effective');
  if (operation !== 'maintain') {
    const state = current?.head;
    if (state?.storage_state === 'unknown') throw new Error('personal_storage_review_required');
    if (state?.storage_ends_at && at >= state.storage_ends_at)
      throw new Error('personal_storage_expired');
    if (at >= (state?.analysis_until ?? c.decision.analysis_until))
      throw new Error('personal_analysis_expired');
    if (at >= (state?.review_after ?? c.decision.terms.review_after))
      throw new Error('personal_terms_review_required');
    if (
      operation === 'collect' &&
      (at < c.decision.acquisition_from || at >= c.decision.acquisition_until)
    )
      throw new Error('personal_acquisition_window_closed');
  }
  return { ...result, current_review: current?.head ?? null };
}
async function runRow(env: PersonalEnv, runId: string) {
  return env.PRIVATE_DB.prepare('SELECT * FROM research_runs WHERE run_id=?')
    .bind(runId)
    .first<PersonalRun>();
}
async function attempt(env: PersonalEnv, c: PersonalContract, digest: string, runId: string) {
  const object = await env.EVIDENCE.get(personalAttemptKey(c));
  if (!object) return null;
  if (object.size > 16384) throw new Error('personal_attempt_invalid');
  const row = attemptSchema.parse(await object.json());
  if (
    row.contract_hash !== digest ||
    row.run_id !== runId ||
    row.source_id !== c.config.source.source_id
  )
    throw new Error('personal_attempt_contract_changed');
  return row;
}
async function current(
  env: PersonalEnv,
  c: PersonalContract,
  digest: string,
  runId: string,
  at: string,
  operation: 'collect' | 'read',
) {
  await validatePersonalState(env, c, at, operation);
  await assertNotRevoked(env, c.config.source.source_id, runId);
  const row = await env.PRIVATE_DB.prepare(
    'SELECT config_hash,suspended FROM research_sources WHERE source_id=?',
  )
    .bind(c.config.source.source_id)
    .first<{ config_hash: string; suspended: number }>();
  if (row?.config_hash !== digest || row.suspended)
    throw new Error('personal_current_contract_changed');
  if (operation === 'collect' && (await env.EVIDENCE.head(collectionStopKey(c))))
    throw new Error('personal_collection_stopped');
  if (operation === 'read') {
    const stopped = await env.EVIDENCE.get(collectionStopKey(c));
    if (
      stopped &&
      (stopped.size > 16384 ||
        (await stopped.json<{ read_blocked?: boolean }>()).read_blocked !== false)
    )
      throw new Error('personal_read_review_required');
  }
}
export function verifyPersonalRun(c: PersonalContract, digest: string, r: PersonalRun) {
  const deadlines = personalDeadlines(c, r.recorded_at);
  if (
    r.config_hash !== digest ||
    r.synthetic !== Number(c.data_origin === 'synthetic') ||
    r.normalized_expires_at !== deadlines.normalized ||
    r.evidence_expires_at !== deadlines.evidence ||
    r.all_copies_expires_at !== deadlines.all_copies ||
    r.retention_snapshot_json !==
      stable({
        version:
          c.version === 'personal-gpu-v1' ? 'personal-retention-v1' : 'personal-retention-v2',
        authority_kind: authority,
        contract_hash: digest,
        ...c.decision.retention,
      })
  )
    throw new Error('personal_captured_contract_mismatch');
}

// Dedicated local entrypoint. The ordinary ResearchConfig/rights gates are never bypassed.
export async function collectPersonalGpu(
  env: PersonalEnv,
  input: unknown,
  opt: PersonalOptions = {},
) {
  const now = clock(env, opt),
    at = now();
  await validatePersonalState(env, input, at, 'maintain');
  await maintainPersonalGpu(env, input, opt);
  const { contract: c, contract_hash: digest } = await validatePersonalState(
    env,
    input,
    at,
    'collect',
  );
  if (!opt.allow_network) throw new Error('personal_network_opt_in_required');
  if (env.ENVIRONMENT === 'test' && !opt.fetcher)
    throw new Error('personal_fixture_fetcher_required');
  const sourceId = c.config.source.source_id,
    runId = await runIdFor(c);
  await assertNotRevoked(env, sourceId, runId);
  if (await env.EVIDENCE.head(collectionStopKey(c))) throw new Error('personal_collection_stopped');
  const priorAttempt = await attempt(env, c, digest, runId);
  const existing = await runRow(env, runId);
  const capturedAt = priorAttempt?.started_at ?? existing?.recorded_at ?? at;
  if (
    capturedAt < c.decision.acquisition_from ||
    capturedAt >= c.decision.acquisition_until ||
    (existing && existing.recorded_at !== capturedAt)
  )
    throw new Error('personal_capture_time_mismatch');
  const deadlines = personalDeadlines(c, capturedAt);
  if (deadlines.normalized !== null && at >= deadlines.normalized)
    throw new Error('personal_storage_expired');
  if (!existing && !priorAttempt) await initializePersonalReview(env, c);
  else await personalReviewHead(env, c, true);
  await env.PRIVATE_DB.batch([
    env.PRIVATE_DB.prepare(
      'INSERT OR IGNORE INTO research_sources(source_id,policy_version,config_hash) VALUES (?,?,?)',
    ).bind(sourceId, c.config.source.policy.version, digest),
    env.PRIVATE_DB.prepare(
      'INSERT OR IGNORE INTO research_personal_contracts(contract_hash,source_id,exception_id,config_hash,contract_json) VALUES (?,?,?,?,?)',
    ).bind(digest, sourceId, c.decision.exception_id, c.config_sha256, stable(c)),
  ]);
  await current(env, c, digest, runId, now(), 'collect');
  const registered = await env.PRIVATE_DB.prepare(
    'SELECT contract_hash FROM research_personal_contracts WHERE source_id=? AND exception_id=?',
  )
    .bind(sourceId, c.decision.exception_id)
    .first<{ contract_hash: string }>();
  if (registered?.contract_hash !== digest) throw new Error('personal_contract_reused');
  await env.PRIVATE_DB.batch([
    env.PRIVATE_DB.prepare(
      "INSERT OR IGNORE INTO research_runs(run_id,source_id,config_hash,query_hash,policy_version,terms_version,scheduled_for,recorded_at,synthetic,state,next_page,evidence_expires_at,normalized_expires_at,all_copies_expires_at,retention_snapshot_json,normalized_mode) VALUES (?,?,?,?,?,?,?,?,?,'collecting',0,?,?,?,?,?)",
    ).bind(
      runId,
      sourceId,
      digest,
      await hash(stable(c.config.scope)),
      c.config.source.policy.version,
      c.decision.terms.version,
      capturedAt,
      capturedAt,
      Number(c.data_origin === 'synthetic'),
      deadlines.evidence,
      deadlines.normalized,
      deadlines.all_copies,
      stable({
        version:
          c.version === 'personal-gpu-v1' ? 'personal-retention-v1' : 'personal-retention-v2',
        authority_kind: authority,
        contract_hash: digest,
        ...c.decision.retention,
      }),
      c.version === 'personal-gpu-v2' ? 'owner_continuing' : 'fixed_days',
    ),
    env.PRIVATE_DB.prepare(
      'INSERT OR IGNORE INTO research_personal_runs(run_id,contract_hash) VALUES (?,?)',
    ).bind(runId, digest),
  ]);
  const r = await runRow(env, runId);
  if (!r) throw new Error('personal_daily_limit');
  verifyPersonalRun(c, digest, r);
  if (r.state === 'complete') {
    if (!priorAttempt) throw new Error('personal_attempt_missing');
    return {
      run_id: runId,
      state: 'complete',
      observation_count: r.observation_count,
      reused: true,
    };
  }
  if (r.state === 'purged' || r.state === 'purging') throw new Error('personal_history_deleted');
  if (Date.parse(at) - Date.parse(capturedAt) > 21600000 || at < capturedAt)
    throw new Error('personal_capture_window_expired');
  const lease = crypto.randomUUID();
  const locked = await env.PRIVATE_DB.prepare(
    "UPDATE research_runs SET lease_token=?,lease_until=? WHERE run_id=? AND state IN ('collecting','partial') AND (lease_until IS NULL OR lease_until<=?)",
  )
    .bind(lease, new Date(Date.parse(at) + 300000).toISOString(), runId, at)
    .run();
  if (!locked.meta.changes)
    return { run_id: runId, state: 'leased', observation_count: 0, reused: true };
  const guard = async () => {
    await current(env, c, digest, runId, now(), 'collect');
    if (
      !(await env.PRIVATE_DB.prepare(
        'SELECT 1 FROM research_runs WHERE run_id=? AND lease_token=? AND lease_until>?',
      )
        .bind(runId, lease, now())
        .first())
    )
      throw new Error('personal_lease_lost');
  };
  const key = evidenceKey(c, runId);
  try {
    await guard();
    let stored = await env.EVIDENCE.get(key),
      encoded: string;
    if (stored) {
      if (!priorAttempt) throw new Error('personal_attempt_missing');
      if (stored.size > 131072) throw new Error('research_evidence_too_large');
      encoded = await stored.text();
    } else {
      if (priorAttempt || r.http_page_attempts > 0) throw new Error('personal_attempt_consumed');
      const reserved = await env.EVIDENCE.put(
        personalAttemptKey(c),
        stable({
          contract_hash: digest,
          run_id: runId,
          source_id: sourceId,
          started_at: capturedAt,
        }),
        { onlyIf: { etagDoesNotMatch: '*' } },
      );
      if (!reserved) throw new Error('personal_attempt_consumed');
      const fetcher: typeof fetch = async (url, init) => {
        await guard();
        const budget = await env.PRIVATE_DB.prepare(
          'UPDATE research_runs SET http_page_attempts=http_page_attempts+1 WHERE run_id=? AND lease_token=? AND lease_until>? AND http_page_attempts<3',
        )
          .bind(runId, lease, now())
          .run();
        if (!budget.meta.changes) throw new FetchFailure('research_request_budget_exhausted');
        return (opt.fetcher ?? fetch)(url, init);
      };
      const response = await readReviewedPublicGpu(c.config, c.decision.terms, { fetcher, now });
      if (response.status !== 200) throw new Error('research_unexpected_status');
      const page = await parsePublicGpu(
        c.config,
        response.text,
        response.observed_at,
        c.data_origin === 'synthetic',
      );
      encoded = stable(
        captureSchema.parse({
          version: 'personal-gpu-projection-v1',
          authority_kind: authority,
          provider_permission: 'unconfirmed',
          contract_hash: digest,
          config_hash: c.config_sha256,
          source_id: sourceId,
          source_policy_version: c.config.source.policy.version,
          terms_version: c.decision.terms.version,
          method_version: c.config.method_version,
          observed_at: response.observed_at,
          synthetic: c.data_origin === 'synthetic',
          payload_hash: await hash(response.text),
          page,
        }),
      );
      if (new TextEncoder().encode(encoded).length > 131072)
        throw new Error('research_evidence_too_large');
      await guard();
      const evidenceHash = await hash(encoded);
      if (
        !(await env.EVIDENCE.put(
          manifestKey(c),
          stable({ contract_hash: digest, evidence_hash: evidenceHash }),
          { onlyIf: { etagDoesNotMatch: '*' } },
        ))
      )
        throw new Error('personal_capture_conflict');
      if (!(await env.EVIDENCE.put(key, encoded, { onlyIf: { etagDoesNotMatch: '*' } })))
        throw new Error('personal_capture_conflict');
    }
    const manifest = await env.EVIDENCE.get(manifestKey(c));
    if (!manifest || manifest.size > 16384) throw new Error('personal_capture_manifest_missing');
    const captured = await manifest.json<{ contract_hash: string; evidence_hash: string }>();
    if (captured.contract_hash !== digest || captured.evidence_hash !== (await hash(encoded)))
      throw new Error('personal_capture_hash_mismatch');
    const e = captureSchema.parse(JSON.parse(encoded));
    if (
      e.contract_hash !== digest ||
      e.config_hash !== c.config_sha256 ||
      e.source_id !== sourceId ||
      e.source_policy_version !== c.config.source.policy.version ||
      e.terms_version !== c.decision.terms.version ||
      e.method_version !== c.config.method_version ||
      e.synthetic !== (c.data_origin === 'synthetic') ||
      e.observed_at < capturedAt ||
      e.observed_at > now() ||
      now() >= deadlines.evidence
    )
      throw new Error('personal_capture_mismatch');
    const statements: D1PreparedStatement[] = [];
    for (const record of e.page.records) {
      const fingerprint = await gpuRecordFingerprint(record);
      statements.push(
        env.PRIVATE_DB.prepare(
          "INSERT OR IGNORE INTO research_gpu_observations(observation_id,run_id,page_number,record_key,source_url,method_version,observed_at,recorded_at,record_hash,previous_observation_id,change_kind,domain_json) SELECT ?,?,0,?,?,?,?,?,?,NULL,'first_seen',? WHERE EXISTS(SELECT 1 FROM research_runs WHERE run_id=? AND lease_token=? AND lease_until>?)",
        ).bind(
          await hash(stable([runId, record.record_key, fingerprint])),
          runId,
          record.record_key,
          c.config.source.source_url,
          c.config.method_version,
          e.observed_at,
          now(),
          fingerprint,
          stable(record),
          runId,
          lease,
          now(),
        ),
      );
    }
    for (let i = 0; i < statements.length; i += 20) {
      await guard();
      await env.PRIVATE_DB.batch(statements.slice(i, i + 20));
    }
    const count = await env.PRIVATE_DB.prepare(
      'SELECT COUNT(*) n FROM research_gpu_observations WHERE run_id=?',
    )
      .bind(runId)
      .first<{ n: number }>();
    if (count?.n !== e.page.records.length) throw new Error('research_checkpoint_mismatch');
    await guard();
    await env.PRIVATE_DB.batch([
      env.PRIVATE_DB.prepare(
        "INSERT OR IGNORE INTO research_pages(run_id,page_number,evidence_key,evidence_hash,observed_at,evidence_expires_at,reported_total,received_count,coverage) SELECT ?,0,?,?,?,?,?,?,'complete' WHERE EXISTS(SELECT 1 FROM research_runs WHERE run_id=? AND lease_token=? AND lease_until>?)",
      ).bind(
        runId,
        key,
        await hash(encoded),
        e.observed_at,
        deadlines.evidence,
        e.page.reported_total,
        e.page.records.length,
        runId,
        lease,
        now(),
      ),
      env.PRIVATE_DB.prepare(
        "UPDATE research_runs SET state='complete',next_page=NULL,observation_count=?,last_error=NULL,lease_token=NULL,lease_until=NULL WHERE run_id=? AND lease_token=? AND lease_until>?",
      ).bind(e.page.records.length, runId, lease, now()),
    ]);
    if ((await runRow(env, runId))?.state !== 'complete') throw new Error('personal_lease_lost');
    return {
      run_id: runId,
      state: 'complete',
      observation_count: e.page.records.length,
      reused: false,
    };
  } catch (error) {
    const reason = error instanceof z.ZodError ? 'public_gpu_schema_invalid' : errorCode(error);
    if (error instanceof FetchFailure || (gpuReviewErrors as readonly string[]).includes(reason))
      await env.EVIDENCE.put(
        collectionStopKey(c),
        stable({
          reason,
          at: now(),
          retry_at: error instanceof FetchFailure ? error.retry_at : null,
          read_blocked: (gpuReviewErrors as readonly string[]).includes(reason),
        }),
        { onlyIf: { etagDoesNotMatch: '*' } },
      );
    await env.PRIVATE_DB.prepare(
      "UPDATE research_runs SET state='partial',last_error=?,lease_token=NULL,lease_until=NULL WHERE run_id=? AND lease_token=?",
    )
      .bind(reason, runId, lease)
      .run();
    throw new Error(reason);
  }
}

export async function maintainPersonalGpu(
  env: PersonalEnv,
  input: unknown,
  opt: PersonalOptions = {},
) {
  const now = clock(env, opt),
    at = now();
  const {
    contract: c,
    contract_hash: digest,
    current_review,
  } = await validatePersonalState(env, input, at, 'maintain');
  const runId = await runIdFor(c),
    r = await runRow(env, runId);
  if (!r) {
    if (c.version === 'personal-gpu-v2') {
      const revoked = await sourceRevocation(env, c.config.source.source_id);
      const deletion = await deletionObligation(env, {
        source_id: c.config.source.source_id,
        run_id: runId,
      });
      const deadline = [
        revoked?.revoked_at,
        deletion?.all_copies_delete_by,
        current_review?.storage_ends_at,
      ]
        .filter((v): v is string => typeof v === 'string')
        .sort()[0];
      if (revoked || deletion || (deadline && at >= deadline)) {
        await recordDeletion(
          env,
          c.config.source.source_id,
          runId,
          at,
          revoked ? 'revoked' : 'expired',
          {
            basis_refs: [c.decision.owner_execution_approval_ref],
            all_copies_delete_by: deadline ?? at,
          },
        );
        await env.EVIDENCE.delete(evidenceKey(c, runId));
        return { state: 'purged', remaining: 0, deadline_missed: !!deadline && at > deadline };
      }
    }
    return { state: 'no_run', remaining: 0 };
  }
  verifyPersonalRun(c, digest, r);
  const sourceId = c.config.source.source_id;
  const revoked = await sourceRevocation(env, sourceId);
  const deleted = await deletionObligation(env, r);
  const deadline =
    [
      r.all_copies_expires_at,
      current_review?.storage_ends_at,
      revoked?.revoked_at,
      deleted?.all_copies_delete_by,
    ]
      .filter((v): v is string => typeof v === 'string')
      .sort()[0] ?? null;
  const expired = deadline !== null && at >= deadline;
  if (r.lease_until && r.lease_until > at) return { state: 'leased', remaining: null };
  if (c.version === 'personal-gpu-v2') await syncPersonalReviewAudit(env, c);
  if (revoked || deleted || expired || r.state === 'purged' || r.state === 'purging') {
    await recordDeletion(env, sourceId, runId, at, revoked ? 'revoked' : 'expired', {
      basis_refs: [c.decision.owner_execution_approval_ref],
      all_copies_delete_by: deadline,
    });
    const locked = await env.PRIVATE_DB.prepare(
      "UPDATE research_runs SET state='purging',next_page=NULL WHERE run_id=? AND (lease_until IS NULL OR lease_until<=?)",
    )
      .bind(runId, at)
      .run();
    if (!locked.meta.changes) return { state: 'leased', remaining: null };
    await env.EVIDENCE.delete(evidenceKey(c, runId));
    // At most 48 observations: bounded SQL, no unbounded transaction or payload scan.
    for (let batch = 0; batch < 3; batch++)
      await env.PRIVATE_DB.prepare(
        'DELETE FROM research_gpu_observations WHERE observation_id IN (SELECT observation_id FROM research_gpu_observations WHERE run_id=? LIMIT 20)',
      )
        .bind(runId)
        .run();
    const left = await env.PRIVATE_DB.prepare(
      'SELECT COUNT(*) n FROM research_gpu_observations WHERE run_id=?',
    )
      .bind(runId)
      .first<{ n: number }>();
    if (left?.n) throw new Error('personal_retention_incomplete');
    await env.PRIVATE_DB.batch([
      env.PRIVATE_DB.prepare('DELETE FROM research_pages WHERE run_id=?').bind(runId),
      env.PRIVATE_DB.prepare(
        "UPDATE research_runs SET state='purged',deleted_at=COALESCE(deleted_at,?),evidence_purged_at=?,backup_residual_until=CASE WHEN deleted_at IS NULL THEN ? ELSE backup_residual_until END WHERE run_id=?",
      ).bind(
        at,
        at,
        c.version === 'personal-gpu-v2'
          ? new Date(
              Date.parse(at) + c.decision.retention.backup.retention_days * 86400000,
            ).toISOString()
          : null,
        runId,
      ),
    ]);
    return {
      state: 'purged',
      remaining: 0,
      storage: 'owner_exception_ended',
      provider_permission: 'unconfirmed',
      deadline_missed: deadline !== null && at > deadline,
    };
  }
  if (at >= r.evidence_expires_at) {
    await env.EVIDENCE.delete(evidenceKey(c, runId));
    await env.PRIVATE_DB.batch([
      env.PRIVATE_DB.prepare('UPDATE research_pages SET evidence_deleted_at=? WHERE run_id=?').bind(
        at,
        runId,
      ),
      env.PRIVATE_DB.prepare('UPDATE research_runs SET evidence_purged_at=? WHERE run_id=?').bind(
        at,
        runId,
      ),
    ]);
  }
  return {
    state:
      current_review?.storage_state === 'unknown'
        ? 'storage_unknown'
        : at >= (current_review?.review_after ?? c.decision.terms.review_after) ||
            at >= (current_review?.analysis_until ?? c.decision.analysis_until)
          ? 'review_due'
          : 'retained',
    remaining: r.observation_count,
    storage: 'owner_exception',
    provider_permission: 'unconfirmed',
  };
}

export async function readPersonalGpu(env: PersonalEnv, input: unknown, opt: PersonalOptions = {}) {
  const now = clock(env, opt);
  await maintainPersonalGpu(env, input, opt);
  const { contract: c, contract_hash: digest } = await validatePersonalState(
    env,
    input,
    now(),
    'read',
  );
  const runId = await runIdFor(c);
  await current(env, c, digest, runId, now(), 'read');
  const reservation = await attempt(env, c, digest, runId);
  if (!reservation) throw new Error('personal_attempt_missing');
  const r = await runRow(env, runId);
  if (!r || r.state !== 'complete')
    return { results: [], authority_kind: authority, provider_permission: 'unconfirmed' };
  verifyPersonalRun(c, digest, r);
  if (reservation.started_at !== r.recorded_at) throw new Error('personal_capture_time_mismatch');
  const rows = await env.PRIVATE_DB.prepare(
    'SELECT * FROM research_gpu_observations WHERE run_id=? ORDER BY record_key LIMIT 48',
  )
    .bind(runId)
    .all();
  return { ...rows, authority_kind: authority, provider_permission: 'unconfirmed' };
}

export async function stopPersonalCollection(
  env: PersonalEnv,
  input: unknown,
  basisRef: string,
  opt: PersonalOptions = {},
) {
  const now = clock(env, opt);
  const { contract: c } = await validatePersonalState(env, input, now(), 'maintain');
  if (!basisRef.trim() || basisRef.length > 500) throw new Error('personal_stop_basis_required');
  await env.EVIDENCE.put(
    collectionStopKey(c),
    stable({
      reason: 'owner_stopped_collection',
      at: now(),
      basis_ref: basisRef,
      read_blocked: false,
    }),
    { onlyIf: { etagDoesNotMatch: '*' } },
  );
}

export async function revokePersonalUse(
  env: PersonalEnv,
  input: unknown,
  basisRef: string,
  opt: PersonalOptions = {},
) {
  const now = clock(env, opt);
  const { contract: c } = await validatePersonalState(env, input, now(), 'maintain');
  if (!basisRef.trim() || basisRef.length > 500) throw new Error('personal_stop_basis_required');
  await recordDeletion(env, c.config.source.source_id, await runIdFor(c), now(), 'revoked', {
    basis_refs: [basisRef],
    all_copies_delete_by: now(),
  });
  return maintainPersonalGpu(env, c, opt);
}

export async function collectPersonalGpuSources(
  env: PersonalEnv,
  inputs: unknown[],
  options: (input: unknown) => PersonalOptions,
) {
  const results = [];
  for (const input of inputs) {
    try {
      results.push(await collectPersonalGpu(env, input, options(input)));
    } catch (error) {
      results.push({ state: 'blocked', reason: errorCode(error) });
    }
  }
  return results;
}
