import type { CollectorEnv, Source, Evidence } from './schema';
import type { CollectOptions, RunResult } from './pipeline';
import { syncSource } from './publication';
import { canCollect, assertPersistenceAllowed } from './policy';
import { fetchSource, FetchFailure } from './network';
import { modelEvidence, readModelEvidence, MODELS_PARSER } from './models';
import {
  initializeModelSnapshot,
  storeModelChunk,
  storeModelAbsence,
  finalizeModels,
  type ModelSnapshot,
} from './models-store';
import { hash, stable, errorCode, isoTime } from './util';
import { collectionIdentity } from './run-identity';
import { observe, type SourceObserver } from './telemetry';

export type ModelCollectOptions = CollectOptions & {
  savedOnly?: boolean;
  revision?: { snapshot_id: string; review_ref: string };
};
export async function collectModels(
  env: CollectorEnv,
  s: Source,
  scheduled: string,
  opt: ModelCollectOptions = {},
): Promise<RunResult> {
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
  const parser = opt.parser ?? MODELS_PARSER;
  let lease: string | null = null;
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
    const snapshotId = await hash(run + '|' + s.policy.version + '|' + parser);
    await syncSource(env, s, now());
    await env.PRIVATE_DB.prepare(
      "INSERT OR IGNORE INTO collection_runs(run_id,source_id,scheduled_for,state) VALUES(?,?,?,'pending')",
    )
      .bind(run, s.source_id, scheduled)
      .run();
    if (!canCollect(s, now())) {
      await env.PRIVATE_DB.prepare(
        "UPDATE collection_runs SET state='policy_skipped',error_code='policy_blocked' WHERE run_id=? AND state<>'complete'",
      )
        .bind(run)
        .run();
      return { ...base, state: 'policy_skipped', reason: 'policy_blocked' };
    }
    await assertPersistenceAllowed(env, s, now());
    const state = await env.PRIVATE_DB.prepare(
      'SELECT state,next_attempt_at,recovery_count FROM collection_runs WHERE run_id=?',
    )
      .bind(run)
      .first<{ state: string; next_attempt_at: string | null; recovery_count: number }>();
    let snap = await env.PRIVATE_DB.prepare('SELECT * FROM model_snapshots WHERE snapshot_id=?')
      .bind(snapshotId)
      .first<ModelSnapshot>();
    if (snap?.stage === 'done')
      return {
        ...base,
        state: snap.state,
        reason: 'already_processed',
        observations: snap.model_count + snap.price_count,
        quarantined: snap.quarantined_count,
      };
    if (state?.state === 'complete' && !opt.revision && !snap)
      return { ...base, state: 'complete', reason: 'already_processed' };
    if (state?.next_attempt_at && state.next_attempt_at > now())
      return { ...base, state: 'deferred', reason: 'retry_after' };
    if ((state?.recovery_count ?? 0) >= 3)
      return { ...base, state: 'failed', reason: 'recovery_exhausted' };
    lease = crypto.randomUUID();
    const claim = await env.PRIVATE_DB.prepare(
      "UPDATE collection_runs SET lease_token=?,lease_until=?,started_at=COALESCE(started_at,?),state='processing' WHERE run_id=? AND (lease_until IS NULL OR lease_until<?)",
    )
      .bind(lease, new Date(Date.parse(now()) + 10 * 60000).toISOString(), now(), run, now())
      .run();
    if (!claim.meta.changes) return { ...base, state: 'in_progress' };
    const artifact = 'evidence/' + s.source_id + '/' + run + '.json';
    const saved = await env.EVIDENCE.get(artifact);
    let evidence: Evidence;
    let revision: ModelSnapshot | null = null;
    if (opt.revision) {
      revision = await env.PRIVATE_DB.prepare(
        'SELECT * FROM model_snapshots WHERE snapshot_id=? AND run_id=? AND policy_version=?',
      )
        .bind(opt.revision.snapshot_id, run, s.policy.version)
        .first<ModelSnapshot>();
      if (
        !revision ||
        !opt.revision.review_ref ||
        revision.parser_version === parser ||
        !saved ||
        revision.state !== 'complete'
      )
        throw new Error('invalid_model_revision');
    } else if (parser !== MODELS_PARSER) throw new Error('model_revision_review_required');
    if (saved) evidence = await saved.json<Evidence>();
    else {
      if (opt.savedOnly) throw new Error('saved_evidence_missing');
      if (Date.parse(now()) - Date.parse(scheduled) > 6 * 3600000)
        throw new Error('capture_window_expired');
      const response = await fetchSource(s, {
        ...opt.network,
        now,
        onAttempt: async (a) => {
          await env.PRIVATE_DB.prepare(
            'INSERT INTO fetch_attempts(run_id,attempt,started_at,status,code,duration_ms) VALUES(?,?,?,?,?,?)',
          )
            .bind(run, a.attempt, a.started_at, a.status, a.code, a.duration_ms)
            .run();
        },
      });
      if (response.status !== 200) throw new Error('models_unexpected_status');
      evidence = await modelEvidence(s, response.text, response.observed_at, !!opt.synthetic);
      await assertPersistenceAllowed(env, s, now());
      await env.EVIDENCE.put(artifact, stable(evidence), {
        onlyIf: { etagDoesNotMatch: '*' },
        httpMetadata: { contentType: 'application/json' },
      });
      const canonical = await env.EVIDENCE.get(artifact);
      if (!canonical) throw new Error('evidence_write_failed');
      evidence = await canonical.json<Evidence>();
      await opt.afterEvidenceSaved?.();
    }
    if (evidence.synthetic && env.ENVIRONMENT !== 'test') throw new Error('synthetic_data_blocked');
    const expires = new Date(
      Date.parse(evidence.observed_at) + s.models!.retention.evidence_days * 86400000,
    ).toISOString();
    if (expires <= now() || evidence.observed_at > now())
      throw new Error('evidence_time_out_of_bounds');
    const projection = await readModelEvidence(s, evidence, revision?.scope_hash);
    if (!snap) {
      await env.PRIVATE_DB.prepare(
        'INSERT OR IGNORE INTO raw_artifacts(artifact_ref,source_id,run_id,observed_at,payload_hash,evidence_hash,bytes,expires_at) VALUES(?,?,?,?,?,?,?,?)',
      )
        .bind(
          artifact,
          s.source_id,
          run,
          evidence.observed_at,
          evidence.payload_hash,
          evidence.evidence_hash,
          evidence.bytes,
          expires,
        )
        .run();
      await initializeModelSnapshot(
        env,
        s,
        run,
        scheduled,
        artifact,
        evidence,
        projection,
        now(),
        parser,
        revision,
        opt.revision?.review_ref ?? null,
      );
      await env.PRIVATE_DB.prepare(
        'UPDATE collection_runs SET artifact_ref=? WHERE run_id=? AND lease_token=?',
      )
        .bind(artifact, run, lease)
        .run();
      // Intake is its own bounded step; never fetch the full catalog per model.
    } else if (snap.stage === 'ingest')
      await storeModelChunk(env, s, snap, evidence, projection, scheduled, now());
    else if (snap.stage === 'absence') await storeModelAbsence(env, s, snap, now());
    else if (snap.stage === 'finalize') {
      const final = await finalizeModels(env, s, snap, now());
      await env.PRIVATE_DB.batch([
        env.PRIVATE_DB.prepare(
          'UPDATE collection_runs SET state=?,finished_at=?,observation_count=?,accepted_count=?,error_code=?,metrics_json=?,last_progress_at=?,lease_token=NULL,lease_until=NULL WHERE run_id=? AND lease_token=?',
        ).bind(
          final.state,
          now(),
          final.model_count + final.price_count,
          final.model_count + final.accepted_prices,
          final.state === 'partial' ? 'catalog_partial' : null,
          stable({
            models: final.model_count,
            components: final.component_count,
            price_quarantined: final.quarantined_count,
            ...JSON.parse(final.metrics_json),
          }),
          now(),
          run,
          lease,
        ),
        env.PRIVATE_DB.prepare(
          'UPDATE sources SET last_success_at=CASE WHEN ? THEN ? ELSE last_success_at END,last_artifact_ref=?,last_count=?,consecutive_failures=0,circuit_until=NULL WHERE source_id=?',
        ).bind(
          final.state === 'complete' ? 1 : 0,
          evidence.observed_at,
          artifact,
          final.model_count,
          s.source_id,
        ),
      ]);
      return {
        ...base,
        state: final.state,
        observations: final.model_count + final.price_count,
        accepted: final.model_count + final.accepted_prices,
        quarantined: final.quarantined_count,
        issues: JSON.parse(final.issues_json).length,
        publication_batches: [snapshotId],
      };
    }
    await env.PRIVATE_DB.prepare(
      "UPDATE collection_runs SET state='pending',last_progress_at=?,error_code=NULL,next_attempt_at=NULL,lease_token=NULL,lease_until=NULL WHERE run_id=? AND lease_token=?",
    )
      .bind(now(), run, lease)
      .run();
    return { ...base, state: 'pending' };
  } catch (error) {
    const code = errorCode(error);
    if (lease)
      await env.PRIVATE_DB.prepare(
        "UPDATE collection_runs SET state='failed',error_code=?,next_attempt_at=?,recovery_count=recovery_count+1,last_progress_at=?,lease_token=NULL,lease_until=NULL WHERE run_id=? AND lease_token=?",
      )
        .bind(code, error instanceof FetchFailure ? error.retry_at : null, now(), run, lease)
        .run();
    return { ...base, state: 'failed', reason: code };
  }
}
export async function resumeModelRuns(
  env: CollectorEnv,
  sources: Source[],
  now: string,
  savedOnly = false,
  observer?: SourceObserver,
): Promise<RunResult[]> {
  const selected = sources.filter((s) => s.models && s.enabled);
  if (!selected.length) return [];
  const rows = await env.PRIVATE_DB.prepare(
    'SELECT source_id,scheduled_for FROM collection_runs WHERE source_id IN (' +
      selected.map(() => '?').join(',') +
      ") AND state IN ('pending','processing','failed') AND recovery_count<3 AND (lease_until IS NULL OR lease_until<?) AND (next_attempt_at IS NULL OR next_attempt_at<=?) ORDER BY COALESCE(last_progress_at,scheduled_for),scheduled_for LIMIT 1",
  )
    .bind(...selected.map((s) => s.source_id), now, now)
    .all<{ source_id: string; scheduled_for: string }>();
  const results: RunResult[] = [];
  for (const row of rows.results) {
    const revision = await env.PRIVATE_DB.prepare(
      "SELECT parser_version,revises_snapshot_id,review_ref FROM model_snapshots WHERE source_id=? AND run_id=(SELECT run_id FROM collection_runs WHERE source_id=? AND scheduled_for=?) AND stage<>'done' ORDER BY recorded_at DESC LIMIT 1",
    )
      .bind(row.source_id, row.source_id, row.scheduled_for)
      .first<{
        parser_version: string;
        revises_snapshot_id: string | null;
        review_ref: string | null;
      }>();
    results.push(
      await observe(
        observer,
        selected.find((s) => s.source_id === row.source_id)!,
        row.scheduled_for,
        () =>
          collectModels(
            env,
            selected.find((s) => s.source_id === row.source_id)!,
            row.scheduled_for,
            {
              now: () => now,
              savedOnly,
              ...(revision?.revises_snapshot_id
                ? {
                    parser: revision.parser_version,
                    revision: {
                      snapshot_id: revision.revises_snapshot_id,
                      review_ref: revision.review_ref!,
                    },
                  }
                : {}),
            },
          ),
      ),
    );
  }
  return results;
}
