import type { CollectorEnv, Source, Evidence } from './schema';
import { GPURentalSchema, GPUSecondarySchema, gpuRecordKey, type GPUDomain } from './gpu';
import { assertPersistenceAllowed, canPublish } from './policy';
import { syncSource } from './publication';
import { hash, stable, isoTime } from './util';
import { snapshot, ingestGPUPage, finalizeGPU, publishCoverage, GPU_PARSER } from './gpu-store';
import { finalizeGPUMetrics } from './gpu-metrics';
// Offline administrative entry point: one saved page per call, no HTTP control route.
export async function correctGPUPage(
  env: CollectorEnv,
  s: Source,
  originalID: string,
  pageNumber: number,
  revision: { parser: string; review_ref: string; recorded_at: string },
  transform: (records: GPUDomain[]) => GPUDomain[],
) {
  if (
    !revision.review_ref ||
    revision.parser === GPU_PARSER ||
    !/^[a-zA-Z0-9._-]{1,80}$/.test(revision.parser) ||
    !isoTime(revision.recorded_at)
  )
    throw new Error('correction_review_required');
  const now = revision.recorded_at;
  await syncSource(env, s, now);
  await assertPersistenceAllowed(env, s, now);
  const original = await snapshot(env, originalID);
  if (original.source_id !== s.source_id || original.policy_version !== s.policy.version)
    throw new Error('correction_policy_mismatch');
  const page = await env.PRIVATE_DB.prepare(
    'SELECT artifact_ref FROM gpu_pages WHERE snapshot_id=? AND page_number=?',
  )
    .bind(originalID, pageNumber)
    .first<{ artifact_ref: string }>();
  if (!page) throw new Error('correction_evidence_missing');
  const saved = await env.EVIDENCE.get(page.artifact_ref);
  if (!saved) throw new Error('correction_evidence_expired');
  const evidence = await saved.json<Evidence>();
  if ((await hash(evidence.body)) !== evidence.evidence_hash)
    throw new Error('gpu_evidence_integrity');
  if (
    evidence.observed_at > now ||
    Date.parse(evidence.observed_at) + s.gpu!.retention.evidence_days! * 86400000 <= Date.parse(now)
  )
    throw new Error('evidence_time_invalid');
  const originals = JSON.parse(evidence.body).records as GPUDomain[],
    keys = originals.map(gpuRecordKey).sort();
  const records = transform(structuredClone(originals)).map((r) =>
    s.dataset_type === 'gpu_rental' ? GPURentalSchema.parse(r) : GPUSecondarySchema.parse(r),
  );
  if (stable(keys) !== stable(records.map(gpuRecordKey).sort()))
    throw new Error('correction_record_set_changed');
  const run = await hash(s.source_id + '|' + now),
    id = await hash(originalID + '|' + revision.parser + '|' + now),
    body = stable({ records }),
    evidenceHash = await hash(body);
  await env.PRIVATE_DB.prepare(
    "INSERT OR IGNORE INTO collection_runs(run_id,source_id,scheduled_for,state) VALUES (?,?,?,'correction_pending')",
  )
    .bind(run, s.source_id, now)
    .run();
  await env.PRIVATE_DB.prepare(
    "INSERT OR IGNORE INTO gpu_snapshots(snapshot_id,run_id,source_id,policy_version,dataset,partition_id,scope_hash,scope_json,state,started_at,data_origin,revises_snapshot_id,review_ref) VALUES (?,?,?,?,?,?,?,?,'collecting',?,?,?,?)",
  )
    .bind(
      id,
      run,
      s.source_id,
      s.policy.version,
      s.dataset_type,
      original.partition_id,
      original.scope_hash,
      original.scope_json,
      original.started_at,
      original.data_origin,
      originalID,
      revision.review_ref,
    )
    .run();
  const current = await snapshot(env, id);
  if (current.next_page !== pageNumber || current.state === 'complete') {
    const applied = await env.PRIVATE_DB.prepare(
      'SELECT evidence_hash FROM gpu_pages WHERE snapshot_id=? AND page_number=?',
    )
      .bind(id, pageNumber)
      .first<{ evidence_hash: string }>();
    if (!applied) throw new Error('correction_page_order');
    if (applied.evidence_hash !== evidenceHash) throw new Error('correction_version_mutated');
  } else {
    const corrected: Evidence = {
      ...evidence,
      body,
      evidence_hash: evidenceHash,
      gpu_page: { ...evidence.gpu_page!, snapshot_id: id },
    };
    const ref = 'evidence/' + s.source_id + '/' + run + '/' + id + '/' + pageNumber + '.json';
    await env.EVIDENCE.put(ref, stable(corrected), {
      onlyIf: { etagDoesNotMatch: '*' },
      httpMetadata: { contentType: 'application/json' },
    });
    const canonical = await env.EVIDENCE.get(ref);
    if (!canonical) throw new Error('evidence_write_failed');
    const replay = await canonical.json<Evidence>();
    if (replay.evidence_hash !== evidenceHash) throw new Error('correction_version_mutated');
    await env.PRIVATE_DB.prepare(
      'INSERT OR IGNORE INTO raw_artifacts(artifact_ref,source_id,run_id,observed_at,payload_hash,evidence_hash,bytes,expires_at) VALUES (?,?,?,?,?,?,?,?)',
    )
      .bind(
        ref,
        s.source_id,
        run,
        evidence.observed_at,
        evidence.payload_hash,
        evidenceHash,
        new TextEncoder().encode(body).length,
        new Date(
          Date.parse(evidence.observed_at) + s.gpu!.retention.evidence_days! * 86400000,
        ).toISOString(),
      )
      .run();
    await ingestGPUPage(env, s, run, now, ref, replay, now, revision.parser);
  }
  const state = await finishGPUCorrection(env, s, id, now);
  return {
    snapshot_id: id,
    recorded_at: now,
    original_observed_at: evidence.observed_at,
    revises_snapshot_id: originalID,
    state,
  };
}
export async function finishGPUCorrection(env: CollectorEnv, s: Source, id: string, now: string) {
  await assertPersistenceAllowed(env, s, now);
  let current = await snapshot(env, id);
  if (!current.revises_snapshot_id || current.source_id !== s.source_id)
    throw new Error('not_a_source_correction');
  if (
    current.next_page === null &&
    current.state !== 'complete' &&
    current.state !== 'quarantined' &&
    current.received_count === current.reported_total
  )
    await finalizeGPU(env, s, current, now);
  current = await snapshot(env, id);
  if (current.state === 'complete') {
    await publishCoverage(env, s, current, now);
    if (canPublish(s, now))
      await env.PUBLIC_DB.prepare(
        "UPDATE publication_batches SET state='complete',completed_at=COALESCE(completed_at,?) WHERE batch_id=? AND state='staging'",
      )
        .bind(current.completed_at, id)
        .run();
    await finalizeGPUMetrics(env, s, current, now);
    current = await snapshot(env, id);
  }
  const state = current.processing_stage === 'done' ? 'correction_complete' : 'correction_pending';
  await env.PRIVATE_DB.prepare('UPDATE collection_runs SET state=?,finished_at=? WHERE run_id=?')
    .bind(state, state === 'correction_complete' ? now : null, current.run_id)
    .run();
  return state;
}
