import { AdminReport } from './admin-contract';
import { hash } from './util';
import { safeLogCode } from './telemetry';

// A transport-neutral, metadata-only input for a separately authorized agent.
// This function cannot fetch, start collection, write reports or invoke an LLM.
export async function operationsHandoff(input: unknown, logicalSlot: string, now: string) {
  const report = AdminReport.parse(input);
  const timestamp = Date.parse(now),
    slot = Date.parse(logicalSlot);
  if (
    !Number.isFinite(timestamp) ||
    !Number.isFinite(slot) ||
    new Date(slot).toISOString() !== logicalSlot ||
    slot % 60000 !== 0 ||
    slot > timestamp ||
    timestamp - slot > 86400000
  )
    throw new Error('current_logical_slot_required');
  if (report.resource !== 'runs') throw new Error('runs_report_required');
  const base = {
    schema_version: 'operations-handoff-v1',
    generated_at: now,
    as_of: report.as_of,
    logical_slot: logicalSlot,
    coverage: 'provided_runs_only',
    source_payload_included: false,
    agent_invoked: false,
    production_deploy_allowed: false,
    publication_allowed: false,
    // Reading every page is required before declaring that all sources were checked.
    more_pages: report.next_cursor !== null,
  } as const;
  const unavailable =
    report.state !== 'ready' ||
    !report.runs ||
    [report.as_of, report.fetched_at].some(
      (t) => Date.parse(t) > timestamp || timestamp - Date.parse(t) > 15 * 60000,
    );
  if (unavailable) return { ...base, state: 'refresh_required', items: [] };
  const items = [];
  for (const run of report.runs!) {
    if (run.logical_slot !== logicalSlot) continue;
    if (
      !/^[a-z0-9_-]{1,80}$/.test(run.source_id) ||
      !/^[a-f0-9]{64}$/.test(run.run_id) ||
      !/^[a-f0-9]{64}$/.test(run.canonical_run_id)
    )
      throw new Error('invalid_run_identity');
    const healthy =
      run.state === 'complete' &&
      run.publication.state === 'complete' &&
      run.quarantined_count === 0 &&
      run.checkpoints.every((c) => c.state === 'complete');
    if (healthy || run.state === 'policy_skipped') continue;
    const r = run.recovery;
    const current =
      run.run_id === run.canonical_run_id &&
      run.state !== 'unavailable_at_as_of' &&
      r?.state !== 'unavailable_at_as_of' &&
      (!r?.detected_at || r.detected_at <= report.as_of);
    const expired = !r?.evidence_expires_at || Date.parse(r.evidence_expires_at) <= timestamp;
    const canPropose =
      current &&
      r?.state === 'recorded' &&
      r.schema_drift === true &&
      r.evidence_hash !== null &&
      r.evidence_state === 'preserved' &&
      !expired &&
      r.remaining_human_action === 'review_repair_candidate' &&
      r.diagnostic_codes.length > 0 &&
      r.diagnostic_codes.every((c) => c === 'wrapper_changed');
    items.push({
      incident_key: await hash(run.source_id + '|' + logicalSlot),
      source_id: run.source_id,
      run_id: run.run_id,
      canonical_run_id: run.canonical_run_id,
      collection_status: [
        'complete',
        'failed',
        'missing',
        'partial',
        'quarantined',
        'running',
        'pending',
        'retry_wait',
        'in_progress',
        'deferred',
        'circuit_open',
        'unavailable_at_as_of',
      ].includes(run.state)
        ? run.state
        : 'unclassified',
      error_code: safeLogCode(run.error_code ?? undefined),
      publication_status: run.publication.state,
      detected_at: r?.detected_at ?? null,
      classification: r?.classification ?? null,
      diagnostic_codes: r?.diagnostic_codes ?? [],
      evidence_state:
        expired && r?.evidence_expires_at ? 'expired' : (r?.evidence_state ?? 'not_reported'),
      evidence_hash: r?.evidence_hash ?? null,
      evidence_expires_at: r?.evidence_expires_at ?? null,
      missing_observation: r?.missing_observation ?? null,
      repair_action: !current
        ? 'read_canonical_current_run'
        : canPropose
          ? 'prepare_code_patch_and_synthetic_tests'
          : 'investigate_metadata_and_report_blocker',
      evidence_reparse: canPropose
        ? 'requires_authorized_private_executor'
        : 'not_authorized_by_this_packet',
      remaining_human_action: r?.remaining_human_action ?? 'investigate_collection_or_publication',
      admin_path:
        '/#runs?' +
        new URLSearchParams({
          source: run.source_id,
          run: run.canonical_run_id,
          as_of: report.as_of,
        }),
    });
  }
  return { ...base, state: 'ready', items };
}
