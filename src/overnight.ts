import { incidentFromMetrics } from './recovery-evidence';
import { z } from 'zod';
import { repairGate } from './repair';

type SourceStatus = {
  source_id: string;
  run_id: string | null;
  collection: string;
  publication: string;
  publication_required?: boolean | null;
  observation_count: number | null;
  accepted_count: number | null;
  snapshot?: string;
  signals?: { key: string; condition: string; code: string }[];
};
// Publication always comes from DB evidence; a patch/reparse success cannot set it.
export function overnightSource(
  s: SourceStatus,
  metrics: unknown = null,
  recoveryCount: number | null = null,
) {
  const incident = s.run_id ? incidentFromMetrics(metrics, s.run_id, s.source_id) : null;
  const privateOnly = s.publication_required === false && s.publication === 'not_applicable';
  const captureComplete =
    s.collection === 'complete' &&
    (!s.snapshot || ['complete', 'not_applicable'].includes(s.snapshot));
  const complete = captureComplete && (s.publication === 'complete' || privateOnly);
  const disabled = s.collection === 'not_applicable';
  const pending = ['awaiting_start', 'in_progress'].includes(s.collection);
  const unknown = [s.collection, s.publication].some((v) => ['unknown', 'unavailable'].includes(v));
  const alerts = (s.signals ?? []).filter((x) => ['alert', 'unknown'].includes(x.condition));
  const missing = disabled || captureComplete ? false : s.collection === 'missing' ? true : null;
  const human =
    disabled || (complete && !alerts.length)
      ? 'none'
      : complete
        ? 'review_operational_alerts'
        : incident?.schema_drift
          ? incident.diagnostic_codes.some((c) =>
              [
                'semantics_changed',
                'pricing_basis_changed',
                'identifier_changed',
                'record_scope_changed',
                'unknown_pricing_field',
              ].includes(c),
            )
            ? 'confirm_source_semantics'
            : incident.evidence_state === 'preserved'
              ? 'review_repair_candidate'
              : 'evidence_unavailable_do_not_backfill'
          : pending
            ? 'none_yet'
            : unknown
              ? 'restore_read_access'
              : 'investigate_collection_or_publication';
  return {
    source_id: s.source_id,
    run_id: s.run_id,
    collection_status: s.collection,
    publication_status: s.publication,
    publication_required: s.publication_required ?? null,
    processing_complete: complete,
    schema_drift: incident ? incident.schema_drift : disabled ? false : 'not_reported',
    detected_at: incident?.detected_at ?? null,
    evidence_hash: incident?.evidence_hash ?? null,
    evidence_expires_at: incident?.expires_at ?? null,
    failure_classification: incident?.classification ?? null,
    diagnostic_codes: incident?.diagnostic_codes ?? [],
    evidence_state: incident?.evidence_state ?? 'not_reported',
    observed_at: incident?.observed_at ?? null,
    recovery_attempts: recoveryCount,
    recovery_result: complete
      ? incident
        ? 'completed_after_failure'
        : 'not_needed'
      : pending
        ? 'in_progress'
        : 'not_completed',
    repair_patch: 'not_reported',
    regression_result: 'not_reported',
    reparse_result: 'not_reported',
    observation_count: s.observation_count,
    accepted_count: s.accepted_count,
    quarantined_observation_count:
      s.observation_count !== null &&
      s.accepted_count !== null &&
      s.observation_count >= s.accepted_count
        ? s.observation_count - s.accepted_count
        : null,
    operational_alerts: alerts,
    missing_observation: missing,
    missing_observation_count: captureComplete ? 0 : null,
    missing_observation_scope: 'current_run_only',
    remaining_human_action: human,
    severity: disabled
      ? 'ok'
      : unknown
        ? 'unknown'
        : alerts.length
          ? 'action_required'
          : complete
            ? 'ok'
            : pending
              ? 'pending'
              : 'action_required',
    briefing: disabled
      ? '対象外'
      : complete
        ? privateOnly
          ? alerts.length
            ? '非公開の収集完了。品質・設定・権利の要確認事項あり'
            : '非公開の収集完了。公開は対象外'
          : alerts.length
            ? '収集・公開完了。品質・設定・権利の要確認事項あり'
            : '収集・公開完了'
        : pending
          ? '収集処理中。完了未確認'
          : unknown
            ? '取得状態を確認できない。0件扱いにはしない'
            : incident?.schema_drift
              ? 'schema driftを検出。公開は未完了。保存Evidenceと修正候補の審査が必要'
              : '収集または公開が未完了。原因の確認が必要',
  };
}

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const Receipt = z.object({
  name: z.enum(['check', 'regression', 'runtime', 'build', 'preflight']),
  exit_code: z.number().int().nullable(),
  started_at: z.iso.datetime(),
  finished_at: z.iso.datetime(),
  patch_sha256: digest,
  evidence_hash: digest,
});
const RepairResult = z.object({
  source_id: z.string(),
  run_id: digest,
  evidence_hash: digest,
  patch_sha256: digest,
  synthetic: z.boolean(),
  regression_result: z.enum(['passed', 'failed', 'not_run']),
  reparse_result: z.literal('passed_with_patched_parser'),
  public_data_written: z.literal(false),
  external_llm_called: z.literal(false),
  receipts: z.array(Receipt).max(5),
  checks: z.record(z.string(), z.boolean().nullable()),
});

// Local trusted runner receipts are kept separate from the authoritative DB
// report. No repair artifact, even a passing one, can claim collection/publication.
export function attachRepairResult(
  morning: ReturnType<typeof overnightSource>,
  input: unknown,
  now: string,
  allowSynthetic = false,
) {
  const parsed = RepairResult.safeParse(input);
  if (!parsed.success) return { ...morning, repair_evidence: 'invalid_or_blocked' };
  const r = parsed.data;
  if (
    (r.synthetic && !allowSynthetic) ||
    r.source_id !== morning.source_id ||
    r.run_id !== morning.run_id ||
    r.evidence_hash !== morning.evidence_hash ||
    !morning.evidence_expires_at ||
    morning.evidence_expires_at <= now
  )
    return { ...morning, repair_evidence: 'mismatched_or_expired' };
  const verified =
    r.receipts.length === 5 &&
    new Set(r.receipts.map((x) => x.name)).size === 5 &&
    r.receipts.every(
      (x) =>
        x.exit_code === 0 &&
        x.patch_sha256 === r.patch_sha256 &&
        x.evidence_hash === r.evidence_hash &&
        x.started_at <= x.finished_at &&
        x.finished_at <= now,
    );
  const regression =
    r.regression_result === 'passed' && verified
      ? 'passed'
      : r.regression_result === 'not_run'
        ? 'not_run'
        : 'failed_or_unverified';
  const gate = repairGate({
    ...r.checks,
    regression_pass: regression === 'passed',
    new_contract_pass: verified,
  });
  return {
    ...morning,
    repair_evidence: 'local_runner_receipts',
    repair_patch: 'generated',
    patch_sha256: r.patch_sha256,
    regression_result: regression,
    reparse_result: r.reparse_result,
    remaining_human_action: morning.processing_complete
      ? morning.remaining_human_action
      : morning.remaining_human_action === 'confirm_source_semantics'
        ? morning.remaining_human_action
        : verified && gate.candidate_eligible
          ? 'review_gate_and_approve_deploy'
          : 'resolve_failed_or_unknown_checks',
    repair_gate: gate,
    briefing: morning.processing_complete
      ? morning.briefing
      : verified
        ? '修正候補と回帰テスト・保存Evidence再解析まで完了。公開未完了、欠測解消は未確認。gateと本番反映の審査が必要'
        : '修正候補あり。検証または意味論判断が未完了。公開は停止中',
  };
}
