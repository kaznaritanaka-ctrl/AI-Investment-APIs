import { isGPU } from './gpu';
import { collectModels } from './models-pipeline';
import { collectGPU } from './gpu-pipeline';
import type { CollectorEnv, Source, Evidence } from './schema';
import { canCollect, assertPersistenceAllowed } from './policy';
import { syncSource } from './publication';
import { fetchSource, FetchFailure, type NetworkOptions } from './network';
import { evidenceFromBody } from './adapters';
import { ingestEvidence, PARSER_VERSION } from './ingest';
import { hash, stable, errorCode, isoTime } from './util';
import { collectionIdentity } from './run-identity';
import type { SourceObserver } from './telemetry';
import {
  preserveRecoveryEvidence,
  recordRecoveryFailure,
  loadRecoveryEvidence,
  SchemaDriftFailure,
  type QuarantineEvidence,
} from './recovery-evidence';
import type { DriftStage } from './schema-drift';
export type RunResult = {
  source_id: string;
  run_id: string;
  state: string;
  reason?: string;
  observations?: number;
  accepted?: number;
  changes?: number;
  quarantined?: number;
  issues?: number;
  logical_slot?: string;
  run_kind?: 'collection';
  published?: number;
  publication_batches?: string[];
};
type State = {
  suspended: number;
  consecutive_failures: number;
  circuit_until: string | null;
  last_artifact_ref: string | null;
  last_success_at: string | null;
};
export type CollectOptions = {
  network?: NetworkOptions;
  now?: () => string;
  synthetic?: boolean;
  parser?: string;
  afterEvidenceSaved?: () => Promise<void>;
  savedOnly?: boolean;
  observer?: SourceObserver;
};
export async function collectSource(
  env: CollectorEnv,
  s: Source,
  scheduled: string,
  opt: CollectOptions = {},
): Promise<RunResult> {
  if (opt.observer)
    return opt.observer(s, scheduled, () =>
      collectSource(env, s, scheduled, { ...opt, observer: undefined }),
    );
  if (s.models) return collectModels(env, s, scheduled, opt);
  if (isGPU(s.dataset_type)) return collectGPU(env, s, scheduled, opt);
  const now = opt.now ?? (() => new Date().toISOString());
  let run = await hash(s.source_id + '|' + scheduled);
  let base: Pick<RunResult, 'source_id' | 'run_id' | 'logical_slot' | 'run_kind'> = {
    source_id: s.source_id,
    run_id: run,
  };
  if (!isoTime(scheduled) || scheduled > now())
    return { ...base, state: 'failed', reason: 'invalid_schedule' };
  if (opt.synthetic && env.ENVIRONMENT !== 'test')
    return { ...base, state: 'failed', reason: 'synthetic_data_blocked' };
  try {
    const identity = await collectionIdentity(env.PRIVATE_DB, s.source_id, scheduled);
    run = identity.run_id;
    scheduled = identity.storedSlot;
    base = {
      source_id: s.source_id,
      run_id: run,
      logical_slot: identity.slot,
      run_kind: identity.kind,
    };
    await syncSource(env, s, now());
    const sourceState = await env.PRIVATE_DB.prepare(
      'SELECT suspended,consecutive_failures,circuit_until,last_artifact_ref,last_success_at FROM sources WHERE source_id=?',
    )
      .bind(s.source_id)
      .first<State>();
    if (!canCollect(s, now()) || sourceState?.suspended) {
      await env.PRIVATE_DB.prepare(
        "INSERT OR IGNORE INTO collection_runs(run_id,source_id,scheduled_for,state,finished_at,error_code) VALUES (?,?,?,'policy_skipped',?,'policy_blocked')",
      )
        .bind(run, s.source_id, scheduled, now())
        .run();
      return { ...base, state: 'policy_skipped', reason: 'policy_blocked' };
    }
    if (
      sourceState?.circuit_until &&
      sourceState.circuit_until > now() &&
      !(await env.EVIDENCE.head('evidence/' + s.source_id + '/' + run + '.json'))
    ) {
      await env.PRIVATE_DB.prepare(
        "INSERT OR IGNORE INTO collection_runs(run_id,source_id,scheduled_for,state,finished_at,error_code) VALUES (?,?,?,'circuit_open',?,'source_backoff')",
      )
        .bind(run, s.source_id, scheduled, now())
        .run();
      return { ...base, state: 'circuit_open', reason: 'source_backoff' };
    }
    await env.PRIVATE_DB.prepare(
      "INSERT OR IGNORE INTO collection_runs(run_id,source_id,scheduled_for,state) VALUES (?,?,?,'pending')",
    )
      .bind(run, s.source_id, scheduled)
      .run();
    const existing = await env.PRIVATE_DB.prepare(
      'SELECT state,next_attempt_at,observation_count,accepted_count FROM collection_runs WHERE run_id=?',
    )
      .bind(run)
      .first<{
        state: string;
        next_attempt_at: string | null;
        observation_count: number;
        accepted_count: number;
      }>();
    if (existing?.state === 'complete' || existing?.state === 'quarantined')
      return {
        ...base,
        state: existing.state,
        observations: existing.observation_count,
        accepted: existing.accepted_count,
        reason: 'already_processed',
      };
    if (existing?.next_attempt_at && existing.next_attempt_at > now())
      return { ...base, state: 'deferred', reason: 'retry_after' };
    const lease = crypto.randomUUID();
    const claim = await env.PRIVATE_DB.prepare(
      "UPDATE collection_runs SET lease_token=?,lease_until=?,state='fetching',started_at=COALESCE(started_at,?) WHERE run_id=? AND state NOT IN ('complete','quarantined') AND (lease_until IS NULL OR lease_until<?)",
    )
      .bind(lease, new Date(Date.parse(now()) + 10 * 60000).toISOString(), now(), run, now())
      .run();
    if (!claim.meta.changes) return { ...base, state: 'in_progress' };
    const artifact = 'evidence/' + s.source_id + '/' + run + '.json';
    let recovery: QuarantineEvidence | null = null;
    let acquiredEvidence: Evidence | null = null;
    let recoveryStage: DriftStage = 'http';
    try {
      let saved = await env.EVIDENCE.get(artifact),
        evidence: Evidence;
      if (saved) evidence = await saved.json<Evidence>();
      else {
        if (env.SCHEMA_RECOVERY_ENABLED === 'true' && s.adapter === 'ecb') {
          recovery = await loadRecoveryEvidence(env, s, run, now(), true);
          if (recovery) throw new Error('quarantine_reparse_review_required');
        }
        if (opt.savedOnly) throw new Error('saved_evidence_missing');
        let previous: Evidence | null = null;
        if (sourceState?.last_artifact_ref) {
          const raw = await env.EVIDENCE.get(sourceState.last_artifact_ref);
          if (raw) {
            const candidate = await raw.json<Evidence>();
            if (candidate.source_policy_version === s.policy.version) previous = candidate;
          }
        }
        const response = await fetchSource(s, {
          ...opt.network,
          now,
          validators: previous
            ? { etag: previous.etag, last_modified: previous.last_modified }
            : undefined,
          onBody:
            env.SCHEMA_RECOVERY_ENABLED === 'true' && s.adapter === 'ecb'
              ? async (body) => {
                  recoveryStage = 'private_store';
                  recovery = await preserveRecoveryEvidence(
                    env,
                    s,
                    run,
                    body.text,
                    body.observed_at,
                    now(),
                    !!opt.synthetic,
                  );
                  recoveryStage = 'body';
                }
              : undefined,
          onAttempt: async (a) => {
            await env.PRIVATE_DB.prepare(
              'INSERT INTO fetch_attempts(run_id,attempt,started_at,status,code,duration_ms) VALUES (?,?,?,?,?,?)',
            )
              .bind(run, a.attempt, a.started_at, a.status, a.code, a.duration_ms)
              .run();
          },
        });
        if (response.status === 304) {
          if (!previous) throw new Error('revalidation_without_evidence');
          evidence = {
            ...previous,
            observed_at: response.observed_at,
            response_status: 304,
            source_policy_version: s.policy.version,
            synthetic: !!opt.synthetic,
          };
        } else {
          recoveryStage = 'body';
          if (env.SCHEMA_RECOVERY_ENABLED === 'true' && s.adapter === 'ecb') {
            recovery = await loadRecoveryEvidence(env, s, run, now());
            if (recovery?.diagnostics.some((d) => d.severity === 'block'))
              throw new SchemaDriftFailure();
          }
          recoveryStage = 'projection';
          evidence = await evidenceFromBody(
            s,
            response.text,
            response.observed_at,
            response.status,
            response.headers,
            !!opt.synthetic,
          );
        }
        // Authorization is checked again after acquisition, before persistence.
        recoveryStage = 'private_store';
        await assertPersistenceAllowed(env, s, now());
        await env.EVIDENCE.put(artifact, stable(evidence), {
          onlyIf: { etagDoesNotMatch: '*' },
          httpMetadata: { contentType: 'application/json' },
        });
        saved = await env.EVIDENCE.get(artifact);
        if (!saved) throw new Error('evidence_write_failed');
        evidence = await saved.json<Evidence>();
        await opt.afterEvidenceSaved?.();
      }
      acquiredEvidence = evidence;
      const expires = new Date(
        Date.parse(evidence.observed_at) +
          Math.min(s.policy.retention_days, s.policy.retention_limit_days ?? Infinity) * 86400000,
      ).toISOString();
      if (expires <= now()) throw new Error('evidence_retention_expired');
      await env.PRIVATE_DB.batch([
        env.PRIVATE_DB.prepare(
          'INSERT OR IGNORE INTO raw_artifacts(artifact_ref,source_id,run_id,observed_at,payload_hash,evidence_hash,bytes,expires_at) VALUES (?,?,?,?,?,?,?,?)',
        ).bind(
          artifact,
          s.source_id,
          run,
          evidence.observed_at,
          evidence.payload_hash,
          evidence.evidence_hash,
          evidence.bytes,
          expires,
        ),
        env.PRIVATE_DB.prepare(
          "UPDATE collection_runs SET state='evidence_saved',artifact_ref=? WHERE run_id=? AND lease_token=?",
        ).bind(artifact, run, lease),
      ]);
      recoveryStage = 'parser';
      const result = await ingestEvidence(
        env,
        s,
        run,
        scheduled,
        artifact,
        evidence,
        now(),
        opt.parser ?? PARSER_VERSION,
        (stage) => {
          recoveryStage = stage;
        },
      );
      const state = result.quarantined || result.issues ? 'quarantined' : 'complete';
      await env.PRIVATE_DB.batch([
        env.PRIVATE_DB.prepare(
          "UPDATE collection_runs SET state=?,finished_at=?,observation_count=?,accepted_count=?,error_code=NULL,next_attempt_at=NULL,lease_token=NULL,lease_until=NULL,metrics_json=json_patch(COALESCE(metrics_json,'{}'),?) WHERE run_id=? AND lease_token=?",
        ).bind(state, now(), result.observations, result.accepted, stable(result), run, lease),
        env.PRIVATE_DB.prepare(
          'UPDATE sources SET consecutive_failures=0,circuit_until=NULL,last_success_at=?,last_artifact_ref=?,last_count=? WHERE source_id=?',
        ).bind(evidence.observed_at, artifact, result.observations, s.source_id),
      ]);
      return {
        ...base,
        state,
        observations: result.observations,
        accepted: result.accepted,
        changes: result.changes,
        quarantined: result.quarantined,
        issues: result.issues,
        publication_batches: [result.publication.batch],
      };
    } catch (error) {
      const code = errorCode(error),
        retry = error instanceof FetchFailure ? error.retry_at : null;
      try {
        if (!recovery && env.SCHEMA_RECOVERY_ENABLED === 'true')
          recovery = await loadRecoveryEvidence(env, s, run, now());
        if (s.adapter === 'ecb' && acquiredEvidence && recoveryStage === 'parser')
          recovery = await preserveRecoveryEvidence(
            env,
            s,
            run,
            acquiredEvidence.body,
            acquiredEvidence.observed_at,
            now(),
            acquiredEvidence.synthetic,
          );
        await recordRecoveryFailure(env, s, run, lease, now(), recoveryStage, code, recovery);
      } catch {
        /* Keep the ingestion failure even when diagnostics cannot be saved. */
      }
      const failures =
        (sourceState?.consecutive_failures ?? 0) + (existing?.state === 'failed' ? 0 : 1);
      // Count source runs, not individual HTTP attempts. Repeated bad runs open for 24h.
      await env.PRIVATE_DB.batch([
        env.PRIVATE_DB.prepare(
          "UPDATE collection_runs SET state='failed',finished_at=?,error_code=?,next_attempt_at=?,lease_token=NULL,lease_until=NULL WHERE run_id=? AND lease_token=?",
        ).bind(now(), code, retry, run, lease),
        env.PRIVATE_DB.prepare(
          'UPDATE sources SET consecutive_failures=?,circuit_until=? WHERE source_id=?',
        ).bind(
          failures,
          failures >= 2 ? new Date(Date.parse(now()) + 86400000).toISOString() : null,
          s.source_id,
        ),
      ]);
      return { ...base, state: 'failed', reason: code };
    }
  } catch (error) {
    return { ...base, state: 'failed', reason: errorCode(error) };
  }
}
export async function collectAll(
  env: CollectorEnv,
  sources: Source[],
  scheduled: string,
  opt: CollectOptions = {},
): Promise<RunResult[]> {
  const results: RunResult[] = [];
  for (const source of sources) results.push(await collectSource(env, source, scheduled, opt));
  return results;
}
