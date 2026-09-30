import type { CollectorEnv, Source, Evidence } from './schema';
import type { CollectOptions, RunResult } from './pipeline';
import { canCollect, assertPersistenceAllowed } from './policy';
import { syncSource } from './publication';
import { fetchGPURequest, FetchFailure } from './network';
import { gpuEvidenceFromBody } from './gpu-adapters';
import { ingestGPUPage, snapshot, publishCoverage, finalizeGPU, GPU_PARSER } from './gpu-store';
import { hash, stable, errorCode, isoTime } from './util';
import { finalizeGPUMetrics } from './gpu-metrics';
import { collectionIdentity } from './run-identity';
export async function collectGPU(
  env: CollectorEnv,
  s: Source,
  scheduled: string,
  opt: CollectOptions & { savedOnly?: boolean } = {},
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
  let lease: string | null = null,
    current: string | null = null;
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
    await env.PRIVATE_DB.prepare(
      "INSERT OR IGNORE INTO collection_runs(run_id,source_id,scheduled_for,state) VALUES (?,?,?,'pending')",
    )
      .bind(run, s.source_id, scheduled)
      .run();
    if (!canCollect(s, now())) {
      await env.PRIVATE_DB.prepare(
        "UPDATE collection_runs SET state='policy_skipped',error_code='policy_blocked' WHERE run_id=?",
      )
        .bind(run)
        .run();
      return { ...base, state: 'policy_skipped', reason: 'policy_blocked' };
    }
    await assertPersistenceAllowed(env, s, now());
    const state = await env.PRIVATE_DB.prepare(
      'SELECT state,next_attempt_at FROM collection_runs WHERE run_id=?',
    )
      .bind(run)
      .first<{ state: string; next_attempt_at: string | null }>();
    if (state?.state === 'complete')
      return { ...base, state: 'complete', reason: 'already_processed' };
    if (state?.next_attempt_at && state.next_attempt_at > now())
      return { ...base, state: 'deferred', reason: 'retry_after' };
    lease = crypto.randomUUID();
    const claim = await env.PRIVATE_DB.prepare(
      "UPDATE collection_runs SET lease_token=?,lease_until=?,state='fetching',started_at=COALESCE(started_at,?),last_progress_at=? WHERE run_id=? AND (lease_until IS NULL OR lease_until<?)",
    )
      .bind(lease, new Date(Date.parse(now()) + 10 * 60000).toISOString(), now(), now(), run, now())
      .run();
    if (!claim.meta.changes) return { ...base, state: 'in_progress' };
    if (!s.gpu) throw new Error('gpu_configuration_missing');
    let budget = s.gpu.pages_per_invocation;
    for (const partition of s.gpu.partitions) {
      const scope = {
        adapter: s.adapter,
        endpoint: s.endpoint,
        partition,
        classification_version: GPU_PARSER,
        page_size: s.gpu.page_size,
        region_map: s.gpu.region_map,
        market_scope: 'observed_search_only',
      };
      const scopeHash = await hash(stable(scope)),
        id = await hash(run + '|' + partition.id + '|' + scopeHash);
      current = id;
      await env.PRIVATE_DB.prepare(
        "INSERT OR IGNORE INTO gpu_snapshots(snapshot_id,run_id,source_id,policy_version,dataset,partition_id,scope_hash,scope_json,state,started_at,data_origin) VALUES (?,?,?,?,?,?,?,?,'collecting',?,?)",
      )
        .bind(
          id,
          run,
          s.source_id,
          s.policy.version,
          s.dataset_type,
          partition.id,
          scopeHash,
          stable(scope),
          now(),
          opt.synthetic ? 'synthetic' : 'live',
        )
        .run();
      let snap = await snapshot(env, id);
      if (snap.policy_version !== s.policy.version || snap.scope_hash !== scopeHash)
        throw new Error('snapshot_policy_changed');
      if (snap.state === 'quarantined' || snap.state === 'expired') continue;
      if (snap.state === 'complete') {
        if (snap.processing_stage === 'metrics' && budget > 0) {
          await finalizeGPUMetrics(env, s, snap, now());
          budget--;
        }
        // Retry a cross-store completion failure without re-fetching.
        await publishCoverage(env, s, snap, now());
        if (canCollect(s, now()))
          await env.PUBLIC_DB.prepare(
            "UPDATE publication_batches SET state='complete',completed_at=COALESCE(completed_at,?) WHERE batch_id=? AND state='staging'",
          )
            .bind(snap.completed_at, id)
            .run();
        continue;
      }
      if (budget <= 0) continue;
      if (Date.parse(now()) - Date.parse(scheduled) > s.gpu.snapshot_max_age_minutes * 60000) {
        await env.PRIVATE_DB.prepare(
          "UPDATE gpu_snapshots SET state='expired',reason='capture_window_expired' WHERE snapshot_id=?",
        )
          .bind(id)
          .run();
        await publishCoverage(env, s, await snapshot(env, id), now());
        continue;
      }
      await env.PRIVATE_DB.prepare(
        'UPDATE gpu_snapshots SET lease_token=?,lease_until=? WHERE snapshot_id=?',
      )
        .bind(lease, new Date(Date.parse(now()) + 10 * 60000).toISOString(), id)
        .run();
      if (snap.processing_stage === 'pages' && snap.next_page !== null) {
        const page = snap.next_page;
        if (page >= s.gpu.max_pages) throw new Error('partition_page_cap');
        const artifact = 'evidence/' + s.source_id + '/' + run + '/' + id + '/' + page + '.json';
        let saved = await env.EVIDENCE.get(artifact),
          evidence: Evidence;
        if (saved) evidence = await saved.json<Evidence>();
        else {
          if (opt.savedOnly) continue;
          const response = await fetchGPURequest(s, env, partition, page, scheduled, {
            ...opt.network,
            now,
            onAttempt: async (a) => {
              await env.PRIVATE_DB.prepare(
                'INSERT INTO fetch_attempts(run_id,attempt,started_at,status,code,duration_ms) VALUES (?,?,?,?,?,?)',
              )
                .bind(run, a.attempt, a.started_at, a.status, a.code, a.duration_ms)
                .run();
            },
          });
          evidence = await gpuEvidenceFromBody(
            s,
            partition,
            id,
            scopeHash,
            page,
            scheduled,
            response.text,
            response.observed_at,
            !!opt.synthetic,
          );
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
        if (evidence.gpu_page?.page_number !== page) throw new Error('gpu_page_mismatch');
        await env.PRIVATE_DB.prepare(
          'INSERT OR IGNORE INTO raw_artifacts(artifact_ref,source_id,run_id,observed_at,payload_hash,evidence_hash,bytes,expires_at) VALUES (?,?,?,?,?,?,?,?)',
        )
          .bind(
            artifact,
            s.source_id,
            run,
            evidence.observed_at,
            evidence.payload_hash,
            evidence.evidence_hash,
            evidence.bytes,
            new Date(
              Date.parse(evidence.observed_at) + s.gpu.retention.evidence_days! * 86400000,
            ).toISOString(),
          )
          .run();
        await ingestGPUPage(
          env,
          s,
          run,
          scheduled,
          artifact,
          evidence,
          now(),
          opt.parser ?? GPU_PARSER,
        );
        budget--;
        snap = await snapshot(env, id);
      }
      if (snap.processing_stage === 'lifecycle' && snap.state !== 'quarantined') {
        if (snap.reported_total !== null && snap.received_count !== snap.reported_total) {
          await env.PRIVATE_DB.prepare(
            "UPDATE gpu_snapshots SET state='quarantined',reason='reported_total_mismatch' WHERE snapshot_id=?",
          )
            .bind(id)
            .run();
        } else await finalizeGPU(env, s, snap, now());
      }
      await publishCoverage(env, s, await snapshot(env, id), now());
    }
    const counts = await env.PRIVATE_DB.prepare(
      "SELECT COUNT(*) AS n,SUM(CASE WHEN state='complete' AND processing_stage='done' THEN 1 ELSE 0 END) AS done,SUM(CASE WHEN state IN ('quarantined','expired') THEN 1 ELSE 0 END) AS stopped FROM gpu_snapshots WHERE run_id=?",
    )
      .bind(run)
      .first<{ n: number; done: number; stopped: number }>();
    const totals = await env.PRIVATE_DB.prepare(
      "SELECT COUNT(*) AS n,SUM(CASE WHEN quality_status='accepted' THEN 1 ELSE 0 END) AS accepted FROM observations WHERE run_id=?",
    )
      .bind(run)
      .first<{ n: number; accepted: number }>();
    const changeCount = await env.PRIVATE_DB.prepare(
      'SELECT COUNT(*) AS n FROM change_events c JOIN observations o ON o.observation_id=c.observation_id WHERE o.run_id=?',
    )
      .bind(run)
      .first<number>('n');
    const status =
      counts?.done === s.gpu.partitions.length
        ? 'complete'
        : counts && counts.done + counts.stopped === s.gpu.partitions.length
          ? 'partial'
          : 'pending';
    await env.PRIVATE_DB.prepare(
      'UPDATE collection_runs SET state=?,finished_at=?,observation_count=?,accepted_count=?,lease_token=NULL,lease_until=NULL,error_code=NULL,next_attempt_at=NULL WHERE run_id=? AND lease_token=?',
    )
      .bind(
        status,
        status === 'pending' ? null : now(),
        totals?.n ?? 0,
        totals?.accepted ?? 0,
        run,
        lease,
      )
      .run();
    if (status === 'complete')
      await env.PRIVATE_DB.prepare(
        'UPDATE sources SET consecutive_failures=0,circuit_until=NULL,last_success_at=?,last_count=? WHERE source_id=?',
      )
        .bind(now(), totals?.n ?? 0, s.source_id)
        .run();
    return {
      ...base,
      state: status,
      observations: totals?.n ?? 0,
      accepted: totals?.accepted ?? 0,
      quarantined: (totals?.n ?? 0) - (totals?.accepted ?? 0),
      changes: changeCount ?? 0,
      issues: counts?.stopped ?? 0,
    };
  } catch (error) {
    const code = errorCode(error),
      retry = error instanceof FetchFailure ? error.retry_at : null;
    if (lease) {
      await env.PRIVATE_DB.prepare(
        "UPDATE collection_runs SET state='failed',error_code=?,next_attempt_at=?,lease_token=NULL,lease_until=NULL WHERE run_id=? AND lease_token=?",
      )
        .bind(code, retry, run, lease)
        .run();
      if (current) {
        await env.PRIVATE_DB.prepare(
          "UPDATE gpu_snapshots SET state=CASE WHEN state='complete' THEN state ELSE 'partial' END,reason=?,next_attempt_at=? WHERE snapshot_id=?",
        )
          .bind(code, retry, current)
          .run();
        await publishCoverage(env, s, await snapshot(env, current), now());
      }
    }
    return { ...base, state: 'failed', reason: code };
  }
}
export async function queueGPURuns(
  env: CollectorEnv,
  sources: Source[],
  slot: string,
  now: string,
) {
  const results: RunResult[] = [];
  for (const s of sources.filter((s) => s.gpu)) {
    let run = await hash(s.source_id + '|' + slot);
    try {
      const identity = await collectionIdentity(env.PRIVATE_DB, s.source_id, slot);
      run = identity.run_id;
      await syncSource(env, s, now);
      const state = canCollect(s, now) ? 'pending' : 'policy_skipped';
      await env.PRIVATE_DB.prepare(
        'INSERT OR IGNORE INTO collection_runs(run_id,source_id,scheduled_for,state) VALUES (?,?,?,?)',
      )
        .bind(run, s.source_id, identity.storedSlot, state)
        .run();
      results.push({
        source_id: s.source_id,
        run_id: run,
        state: identity.row?.state ?? state,
        logical_slot: identity.slot,
        run_kind: identity.kind,
      });
    } catch (e) {
      results.push({ source_id: s.source_id, run_id: run, state: 'failed', reason: errorCode(e) });
    }
  }
  return results;
}
export async function resumeGPURuns(
  env: CollectorEnv,
  sources: Source[],
  now: string,
  savedOnly = false,
) {
  const runs = await env.PRIVATE_DB.prepare(
    "SELECT r.source_id,r.scheduled_for FROM collection_runs r JOIN sources s USING(source_id) WHERE json_extract(s.config_json,'$.gpu') IS NOT NULL AND r.state IN ('pending','fetching','failed') AND (r.next_attempt_at IS NULL OR r.next_attempt_at<=?) AND (r.lease_until IS NULL OR r.lease_until<?) ORDER BY r.last_progress_at ASC,r.scheduled_for DESC LIMIT 1",
  )
    .bind(now, now)
    .all<{ source_id: string; scheduled_for: string }>();
  const results: RunResult[] = [];
  for (const r of runs.results) {
    const s = sources.find((s) => s.source_id === r.source_id);
    if (s) results.push(await collectGPU(env, s, r.scheduled_for, { now: () => now, savedOnly }));
  }
  return results;
}
