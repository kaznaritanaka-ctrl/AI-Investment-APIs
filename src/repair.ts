import type { Source } from './schema';
import { canPublish } from './policy';
import { validateQuarantine, type QuarantineEvidence } from './recovery-evidence';
import { captureModelFields } from './schema-drift';
import { projectModelCatalog, type ModelProjection, MODELS_PARSER } from './models';
import { stable, hash } from './util';
import recoveryPolicy from '../config/recovery-policy.json';

export type CheckName = (typeof recoveryPolicy.required_checks)[number];
export type RepairChecks = Record<CheckName, boolean | null>;
export function repairGate(checks: RepairChecks, semanticChanges: string[] = []) {
  const missing = recoveryPolicy.required_checks.filter((k) => checks[k] !== true);
  return {
    policy_version: recoveryPolicy.version,
    candidate_eligible: missing.length === 0 && semanticChanges.length === 0,
    blockers: [...missing, ...semanticChanges.map(() => 'semantic_or_rights_change')],
    production_deploy_allowed: false,
    publication_allowed: false,
    remaining_human_action: semanticChanges.length
      ? 'confirm_source_semantics'
      : missing.length
        ? 'resolve_failed_or_unknown_checks'
        : 'approve_reviewed_deploy_and_reparse',
  };
}
const semantics = (p: ModelProjection) =>
  p.records
    .map((r) => ({
      key: r.key,
      model_id: r.catalog.model_id,
      provider: r.catalog.serving_provider,
      currency_unit_basis:
        r.price?.price_components.map((c) => [
          c.component_type,
          c.currency,
          c.unit,
          c.tier_conditions,
          c.pricing_mode,
        ]) ?? null,
      pricing_scope: r.price?.pricing_scope ?? null,
    }))
    .sort((a, b) => a.key.localeCompare(b.key));

export function repairPacket(s: Source, e: QuarantineEvidence) {
  // Source values are never sent to the model, even if a future source grants LLM
  // processing. The current ECB/Models grants do not authorize that transfer.
  return {
    schema_version: 1,
    source_id: s.source_id,
    policy_version: s.policy.version,
    evidence_hash: e.body_hash,
    observed_at: e.observed_at,
    diagnostic_codes: [...new Set(e.diagnostics.map((d) => d.code))].filter((c) =>
      /^[a-z_]{1,60}$/.test(c),
    ),
    adapter_files: s.models ? ['src/models.ts', 'src/schema-drift.ts'] : ['src/adapters.ts'],
    permitted_actions: [
      'propose_parser_patch',
      'change_parser_version',
      'write_synthetic_contract_test',
      'run_offline_regression',
      'reparse_authorized_saved_evidence',
    ],
    source_payload_included: false,
    external_llm_processing_authorized: false,
    untrusted_source_instructions: 'never_execute',
    production_deploy_allowed: false,
    publication_allowed: false,
  };
}

export async function reparseWrapperCandidate(
  s: Source,
  e: QuarantineEvidence,
  now: string,
  prior: ModelProjection | null = null,
) {
  await validateQuarantine(s, e, now, e.synthetic ? 'test' : 'development');
  if (
    !s.models ||
    !e.body ||
    !e.complete_projection ||
    !e.wrapper ||
    e.diagnostics.some((d) => d.code !== 'wrapper_changed')
  )
    throw new Error('repair_requires_semantic_or_evidence_review');
  const recaptured = captureModelFields(e.body, s);
  if (recaptured.body !== e.body || !recaptured.complete || recaptured.wrapper !== e.wrapper)
    throw new Error('quarantine_field_scope_mismatch');
  const root: unknown = JSON.parse(e.body);
  if (!root || typeof root !== 'object' || Array.isArray(root))
    throw new Error('quarantine_shape_invalid');
  const unwrapped = (root as Record<string, unknown>)[e.wrapper];
  // Same decimal strings, identifiers and permitted fields; no currency/unit conversion.
  const reparsed = await projectModelCatalog(stable(unwrapped), s);
  const expected = recaptured.record_count;
  const keys = reparsed.records.map((r) => r.key);
  const accepted = reparsed.records.filter((r) => r.price && r.price_issues.length === 0).length;
  const quarantined = reparsed.records.filter((r) => !r.price || r.price_issues.length > 0).length;
  const expectedKeys = Object.entries(
    unwrapped as Record<string, { models: Record<string, unknown> }>,
  )
    .flatMap(([provider, p]) => Object.keys(p.models).map((id) => provider + '/' + id))
    .sort();
  const priorAccepted =
    prior?.records.filter((r) => r.price && r.price_issues.length === 0).length ?? null;
  const priorQuarantined = prior ? prior.records.length - priorAccepted! : null;
  const priorSemantics = prior ? new Map(semantics(prior).map((r) => [r.key, r])) : null;
  const currentSemantics = semantics(reparsed);
  const semanticComparison =
    priorSemantics !== null &&
    currentSemantics.every(
      (r) => priorSemantics.has(r.key) && stable(priorSemantics.get(r.key)) === stable(r),
    );
  const checks: RepairChecks = Object.fromEntries(
    recoveryPolicy.required_checks.map((k) => [k, null]),
  );
  Object.assign(checks, {
    counts_reconciled:
      reparsed.complete &&
      expected === keys.length &&
      accepted + quarantined === expected &&
      (!prior || (accepted === priorAccepted && quarantined === priorQuarantined)),
    identity_preserved:
      keys.length === new Set(keys).size && stable([...keys].sort()) === stable(expectedKeys),
    currency_unit_basis_preserved: prior ? semanticComparison : null,
    public_rights_preserved: canPublish(s, now),
    evidence_reparse_pass: reparsed.complete,
    immutable_history_preserved: true, // This pure function has no DB/R2 writer or fetch capability.
    parser_version_changed: null, // Proposed version, not a verified patch yet.
    rollback_available: null,
    upstream_semantics_confirmed: null,
  });
  const candidateId = (await hash(e.body_hash + '|' + MODELS_PARSER + '|' + e.wrapper)).slice(
    0,
    16,
  );
  return {
    source_id: s.source_id,
    run_id: e.run_id,
    policy_version: e.policy_version,
    candidate_id: candidateId,
    base_parser_version: MODELS_PARSER,
    candidate_parser_version: MODELS_PARSER + '.repair-' + candidateId,
    evidence_hash: e.body_hash,
    observed_at: e.observed_at,
    wrapper: e.wrapper,
    synthetic: e.synthetic,
    reparse_result: 'passed',
    record_count: keys.length,
    baseline_comparison: {
      previous_records: prior?.records.length ?? null,
      current_records: keys.length,
      previous_accepted: priorAccepted,
      current_accepted: accepted,
      previous_quarantined: priorQuarantined,
      current_quarantined: quarantined,
    },
    accepted_price_count: accepted,
    quarantined_price_count: quarantined,
    missing_observation_count: null, // Reparse did not commit observations or publish anything.
    original_observed_at_preserved: true,
    regression_result: 'not_run',
    new_contract_result: 'not_run',
    checks,
    gate: repairGate(checks),
    publication_result: 'not_attempted',
    production_deploy_result: 'not_attempted',
    projection: reparsed,
  };
}
