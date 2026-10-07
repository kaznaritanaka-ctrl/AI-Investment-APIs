import type { RunDTO, RunRecoveryDTO } from './admin-contract';
import { RunRecovery } from './admin-contract';
import { incidentFromMetrics } from './recovery-evidence';
import { overnightSource } from './overnight';

// Share the morning assessment with the checker; browsing never reparses evidence.
export function runRecovery(
  run: RunDTO,
  metrics: unknown,
  now: string,
  asOf = now,
): RunRecoveryDTO {
  const incident = incidentFromMetrics(metrics, run.run_id, run.source_id);
  const historical =
    run.state === 'unavailable_at_as_of' || !!(incident && incident.detected_at > asOf);
  const recorded = historical ? null : incident;
  const pending = ['pending', 'running', 'leased', 'retry_wait'].includes(run.state);
  const morning = overnightSource(
    {
      source_id: run.source_id,
      run_id: run.run_id,
      collection: historical
        ? 'unknown'
        : pending
          ? 'in_progress'
          : run.state === 'policy_skipped'
            ? 'not_applicable'
            : run.state,
      publication: historical ? 'unknown' : run.publication.state,
      observation_count: run.observation_count,
      accepted_count: run.accepted_count,
      snapshot: run.checkpoints.every((c) => c.state === 'complete') ? 'complete' : 'partial',
      signals:
        run.quarantined_count && run.quarantined_count > 0
          ? [
              {
                key: run.source_id + ':quality',
                condition: 'alert',
                code: 'quarantined_observations',
              },
            ]
          : [],
    },
    recorded ? JSON.stringify({ recovery: recorded }) : null,
    run.recovery_count,
  );
  const expired =
    recorded?.expires_at !== null &&
    recorded?.expires_at !== undefined &&
    recorded.expires_at <= now;
  return RunRecovery.parse({
    state: historical ? 'unavailable_at_as_of' : recorded ? 'recorded' : 'not_reported',
    detected_at: recorded?.detected_at ?? null,
    classification: recorded?.classification ?? null,
    stage: recorded?.stage ?? null,
    schema_drift: recorded?.schema_drift ?? null,
    diagnostic_codes: recorded?.diagnostic_codes ?? [],
    evidence_state: expired ? 'expired' : (recorded?.evidence_state ?? 'not_reported'),
    evidence_hash: recorded?.evidence_hash ?? null,
    evidence_expires_at: recorded?.expires_at ?? null,
    recovery_result: morning.recovery_result,
    agent_status: 'not_reported',
    repair_patch: 'not_reported',
    regression_result: 'not_reported',
    reparse_result: 'not_reported',
    missing_observation: morning.missing_observation,
    missing_observation_count: morning.missing_observation_count,
    missing_observation_scope: 'current_run_only',
    remaining_human_action: historical
      ? 'review_historical_state'
      : expired && morning.remaining_human_action === 'review_repair_candidate'
        ? 'evidence_unavailable_do_not_backfill'
        : morning.remaining_human_action,
    briefing: historical
      ? '指定時点の診断を確認できません'
      : expired && morning.publication_status !== 'complete'
        ? '復旧用Evidenceは期限切れ。過去の値による補完は行わず、残る欠測と対応を確認'
        : morning.briefing,
  });
}
