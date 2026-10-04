import type { CollectorEnv, Source } from './schema';
import { canCollect, canPublish } from './policy';
import { collectionIdentity, dailyCollectionSlot } from './run-identity';
import { runDTO } from './admin-read';
import type { RunDTO } from './admin-contract';
import { isoTime, stable } from './util';
import { overnightSource } from './overnight';

export type Condition = 'alert' | 'clear' | 'pending' | 'unknown' | 'not_applicable';
export type Signal = { key: string; condition: Condition; code: string };
export type Quality = { count: number; reasons: Record<string, number> };
export type SourceEvidence = {
  run: RunDTO | null;
  completeCapture: boolean | null;
  quality: Quality | null;
  previousQuality: Quality | null;
  sourceDate: string | null;
};
// Configured Models capture window is six hours; progress is normally five-minute
// checkpoints. Twenty minutes permits four missed checkpoints without interpreting
// the 03:47 watchdog as the final publication deadline (observed completion ~03:56).
export const operationsTiming = {
  startGraceMinutes: 10,
  progressGraceMinutes: 20,
  modelsDeadlineMinutes: 360,
};
const age = (now: string, stamp: string) => (Date.parse(now) - Date.parse(stamp)) / 60000;

export function evaluateSource(s: Source, slot: string, now: string, e: SourceEvidence) {
  const signals: Signal[] = [];
  const add = (facet: string, condition: Condition, code: string) =>
    signals.push({ key: s.source_id + ':' + facet, condition, code });
  const elapsed = age(now, slot),
    run = e.run;
  let collection: string = 'unknown',
    snapshot: string = 'unknown',
    publication: string = 'unknown';
  if (!s.enabled) {
    collection = snapshot = publication = 'not_applicable';
    add('collection', 'not_applicable', 'source_disabled');
  } else if (!canCollect(s, now)) {
    collection = snapshot = publication = 'policy_stopped';
    add('policy', 'alert', 'collection_policy_stopped');
  } else {
    add('policy', 'clear', 'collection_policy_allowed');
    if (!run) {
      collection = elapsed <= operationsTiming.startGraceMinutes ? 'awaiting_start' : 'missing';
      add('collection', collection === 'missing' ? 'alert' : 'pending', collection);
    } else if (
      run.state === 'complete' &&
      run.finished_at &&
      run.observation_count !== null &&
      run.accepted_count !== null
    ) {
      collection = 'complete';
      add('collection', 'clear', 'observations_complete');
    } else if (run.state === 'policy_skipped') {
      collection = 'policy_stopped';
      add('collection', 'alert', 'unexpected_policy_stop');
    } else if (['pending', 'processing', 'in_progress', 'deferred'].includes(run.state)) {
      const progress = run.last_progress_at ?? run.started_at ?? slot;
      const overdue =
        elapsed >
        (s.models ? operationsTiming.modelsDeadlineMinutes : operationsTiming.startGraceMinutes);
      const stalled =
        elapsed > operationsTiming.startGraceMinutes &&
        age(now, progress) > operationsTiming.progressGraceMinutes;
      collection = overdue ? 'deadline_exceeded' : stalled ? 'progress_stalled' : 'in_progress';
      add('collection', overdue || stalled ? 'alert' : 'pending', collection);
    } else {
      collection = ['failed', 'missing', 'partial', 'quarantined'].includes(run.state)
        ? run.state
        : 'unknown';
      add('collection', collection === 'unknown' ? 'unknown' : 'alert', 'run_' + collection);
    }
    snapshot = !s.models
      ? 'not_applicable'
      : collection === 'complete' &&
          e.completeCapture === true &&
          run?.checkpoints.some((c) => c.kind === 'models' && c.state === 'complete')
        ? 'complete'
        : collection === 'in_progress'
          ? 'in_progress'
          : 'incomplete';
    if (s.models)
      add(
        'snapshot',
        snapshot === 'complete' ? 'clear' : collection === 'complete' ? 'alert' : 'pending',
        'snapshot_' + snapshot,
      );
    if (!canPublish(s, now)) {
      publication = 'policy_stopped';
      add('publication', 'not_applicable', 'publication_not_permitted');
    } else if (collection !== 'complete' || (s.models && snapshot !== 'complete')) {
      publication = 'awaiting_collection';
      add('publication', 'pending', publication);
    } else {
      publication = run?.publication.state ?? 'unknown';
      const p = run?.publication;
      const coherent =
        p?.state === 'complete' &&
        p.original_count === run?.accepted_count &&
        p.visible_count === (p.original_count ?? 0) + (p.derived_count ?? 0);
      if (p?.state === 'complete' && !coherent) publication = 'count_mismatch';
      add(
        'publication',
        coherent ? 'clear' : publication === 'unavailable' ? 'unknown' : 'alert',
        'publication_' + publication,
      );
    }
  }
  const q = e.quality,
    previous = e.previousQuality;
  const newCodes =
    q && previous ? Object.keys(q.reasons).filter((c) => !(c in previous.reasons)) : [];
  const increasedCodes =
    q && previous
      ? Object.keys(q.reasons).filter((c) => q.reasons[c] > (previous.reasons[c] ?? 0))
      : [];
  const delta = q && previous ? q.count - previous.count : null;
  const qualityState = !s.models
    ? 'not_applicable'
    : collection !== 'complete'
      ? 'pending'
      : !q
        ? 'unknown'
        : q.count === 0
          ? 'clear'
          : !previous ||
              !Object.keys(q.reasons).length ||
              Object.keys(q.reasons).length >= 40 ||
              'unclassified' in q.reasons
            ? 'unknown'
            : increasedCodes.length || (delta ?? 0) > 0
              ? 'alert'
              : 'clear';
  if (s.models)
    add(
      'quality',
      qualityState,
      qualityState === 'alert'
        ? 'quarantine_changed'
        : qualityState === 'clear' && q?.count
          ? 'quarantine_unchanged'
          : 'quality_' + qualityState,
    );
  const days = s.policy.valid_until
    ? (Date.parse(s.policy.valid_until) - Date.parse(now)) / 86400000
    : null;
  if (s.enabled)
    add(
      'review',
      days !== null && days <= 30 ? 'alert' : 'clear',
      days !== null && days <= 0
        ? 'internal_policy_review_expired'
        : days !== null && days <= 7
          ? 'internal_policy_review_within_7_days'
          : days !== null && days <= 30
            ? 'internal_policy_review_within_30_days'
            : 'internal_policy_review_current',
    );
  return {
    source_id: s.source_id,
    logical_slot: slot,
    run_id: run?.run_id ?? null,
    collection,
    snapshot,
    publication,
    observation_count: run?.observation_count ?? null,
    accepted_count: run?.accepted_count ?? null,
    quality: {
      state: qualityState,
      count: q?.count ?? null,
      previous_count: previous?.count ?? null,
      delta,
      reasons: q?.reasons ?? null,
      new_codes: newCodes,
      increased_codes: increasedCodes,
    },
    source_date: e.sourceDate,
    source_calendar_evaluation: 'not_evaluated',
    signals,
  };
}

export function apiReachability(status: number | null) {
  return status === null
    ? 'connection_error'
    : status >= 200 && status < 300
      ? 'reachable'
      : [401, 403].includes(status)
        ? 'authentication_or_access_blocked'
        : status === 429
          ? 'rate_limited'
          : 'http_error';
}
export function monitorHeartbeat(
  now: string,
  lastCheck: string | null,
  expectedMinutes: number | null,
) {
  if (!lastCheck || !isoTime(lastCheck) || expectedMinutes === null || expectedMinutes <= 0)
    return 'unknown';
  const minutes = age(now, lastCheck);
  return minutes < 0 ? 'unknown' : minutes > expectedMinutes * 2 ? 'stale' : 'recent_receipt';
}

export async function readOperationalStatus(env: CollectorEnv, sources: Source[], now: string) {
  if (!isoTime(now)) throw new Error('invalid_check_time');
  const slot = dailyCollectionSlot(env.COLLECTION_CRON, Date.parse(now));
  const reports: ReturnType<typeof evaluateSource>[] = [];
  const overnight: ReturnType<typeof overnightSource>[] = [];
  for (const s of sources.filter((s) => ['ecb', 'models_dev'].includes(s.source_id))) {
    try {
      const configured = await env.PRIVATE_DB.prepare(
        'SELECT config_json=? AS matches,enabled,suspended FROM sources WHERE source_id=?',
      )
        .bind(stable(s), s.source_id)
        .first<{ matches: number; enabled: number; suspended: number }>();
      const identity = await collectionIdentity(env.PRIVATE_DB, s.source_id, slot);
      const row = identity.row
        ? await env.PRIVATE_DB.prepare(
            'SELECT run_id,source_id,scheduled_for,state,started_at,finished_at,last_progress_at,observation_count,accepted_count,error_code,recovery_count,next_attempt_at,metrics_json FROM collection_runs WHERE run_id=?',
          )
            .bind(identity.run_id)
            .first<Record<string, unknown>>()
        : null;
      const run = row ? await runDTO(env, row, now) : null;
      const snaps = await env.PRIVATE_DB.prepare(
        'SELECT snapshot_id,complete_capture,quarantined_count,scope_hash,policy_version,observed_at FROM model_snapshots WHERE run_id=? AND recorded_at<=? ORDER BY recorded_at DESC,snapshot_id DESC LIMIT 1',
      )
        .bind(identity.run_id, now)
        .all<{
          snapshot_id: string;
          complete_capture: number;
          quarantined_count: number;
          scope_hash: string;
          policy_version: string;
          observed_at: string;
        }>();
      const current = snaps.results[0];
      if (current) {
        const previous = await env.PRIVATE_DB.prepare(
          "SELECT snapshot_id,complete_capture,quarantined_count,scope_hash,policy_version,observed_at FROM model_snapshots WHERE source_id=? AND scope_hash=? AND policy_version=? AND state='complete' AND observed_at<? AND completed_at<=? ORDER BY observed_at DESC,completed_at DESC LIMIT 1",
        )
          .bind(s.source_id, current.scope_hash, current.policy_version, current.observed_at, now)
          .first<typeof current>();
        if (previous) snaps.results.push(previous);
      }
      const quality: Quality[] = [];
      for (const snap of snaps.results) {
        const reasons = await env.PRIVATE_DB.prepare(
          'SELECT j.value code,COUNT(*) n FROM model_snapshot_members m,json_each(m.price_issues_json) j WHERE m.snapshot_id=? AND m.price_eligible=0 GROUP BY j.value LIMIT 40',
        )
          .bind(snap.snapshot_id)
          .all<{ code: string; n: number }>();
        quality.push({
          count: snap.quarantined_count,
          reasons: Object.fromEntries(
            reasons.results.map((r) => [
              /^[a-z0-9_]{1,80}$/.test(r.code) ? r.code : 'unclassified',
              r.n,
            ]),
          ),
        });
      }
      const fx =
        s.dataset_type === 'fx' && row
          ? await env.PRIVATE_DB.prepare(
              'SELECT MAX(f.source_date) source_date FROM fx_observations f JOIN observations o USING(observation_id) WHERE o.run_id=?',
            )
              .bind(identity.run_id)
              .first<{ source_date: string | null }>()
          : null;
      reports.push(
        evaluateSource(s, slot, now, {
          run,
          completeCapture: snaps.results[0]?.complete_capture === 1,
          quality: quality[0] ?? null,
          previousQuality: quality[1] ?? null,
          sourceDate: fx?.source_date ?? null,
        }),
      );
      reports
        .at(-1)!
        .signals.push({ key: s.source_id + ':read', condition: 'clear', code: 'metadata_read_ok' });
      const morning = overnightSource(
        reports.at(-1)!,
        row?.metrics_json,
        typeof row?.recovery_count === 'number' ? row.recovery_count : null,
      );
      overnight.push(morning);
      if (morning.schema_drift === true && morning.publication_status !== 'complete')
        reports.at(-1)!.signals.push({
          key: s.source_id + ':schema_drift',
          condition: 'alert',
          code: 'schema_drift_detected',
        });
      reports.at(-1)!.signals.push({
        key: s.source_id + ':configuration',
        condition:
          configured?.matches === 1 &&
          !configured.suspended &&
          !!configured.enabled === s.enabled &&
          env.COLLECTION_ENABLED === 'true'
            ? 'clear'
            : 'alert',
        code:
          env.COLLECTION_ENABLED === 'false'
            ? 'collection_switch_disabled'
            : configured?.suspended
              ? 'source_suspended'
              : configured && !!configured.enabled !== s.enabled
                ? 'database_enabled_drifted'
                : configured?.matches === 1
                  ? 'configuration_matches'
                  : 'configuration_unverified_or_drifted',
      });
    } catch {
      reports.push({
        ...evaluateSource(s, slot, now, {
          run: null,
          completeCapture: null,
          quality: null,
          previousQuality: null,
          sourceDate: null,
        }),
        collection: 'unknown',
        snapshot: 'unknown',
        publication: 'unknown',
        signals: [{ key: s.source_id + ':read', condition: 'alert', code: 'metadata_unavailable' }],
      });
      overnight.push(overnightSource(reports.at(-1)!));
    }
  }
  let lastInvocation: string | null = null;
  let summaryState = 'unavailable';
  let handlerState = 'unavailable';
  let handlerCompletedAt: string | null = null;
  let declaredMonitor: number | null = null;
  try {
    lastInvocation =
      (
        await env.PRIVATE_DB.prepare('SELECT MAX(recorded_at) stamp FROM daily_summaries').first<{
          stamp: string | null;
        }>()
      )?.stamp ?? null;
    summaryState = lastInvocation ? 'recorded' : 'no_records';
  } catch {
    /* independent evidence unavailable */
  }
  try {
    const health = await env.PUBLIC_DB.prepare(
      'SELECT last_collector_completed_at,monitor_connected FROM public_health WHERE singleton=1',
    ).first<{ last_collector_completed_at: string | null; monitor_connected: number }>();
    handlerCompletedAt = health?.last_collector_completed_at ?? null;
    declaredMonitor = health?.monitor_connected ?? null;
    handlerState = handlerCompletedAt ? 'recorded' : 'no_records';
  } catch {
    /* Independent public metadata failure. */
  }
  return {
    checked_at: now,
    logical_slot: slot,
    api_reachability: 'not_checked',
    collector: {
      last_summary_at: lastInvocation,
      summary_state: summaryState,
      last_handler_completed_at: handlerCompletedAt,
      handler_state: handlerState,
      monitor_connected_declared: declaredMonitor,
      meaning: 'summary_recorded_not_proof_of_observation_or_handler_finish',
    },
    external_monitor: 'not_verified',
    overnight: {
      schema_version: 1,
      checked_at: now,
      logical_slot: slot,
      production_deploy_enabled: false,
      external_runner: 'not_verified',
      sources: [
        ...overnight,
        ...sources
          .filter((s) => !reports.some((r) => r.source_id === s.source_id))
          .map((s) =>
            overnightSource({
              source_id: s.source_id,
              run_id: null,
              collection: s.enabled ? 'unknown' : 'not_applicable',
              publication: s.enabled ? 'unknown' : 'not_applicable',
              observation_count: null,
              accepted_count: null,
            }),
          ),
      ],
    },
    sources: reports,
  };
}
