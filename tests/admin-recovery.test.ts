import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Run, RunRecovery, type RunDTO } from '../src/admin-contract';
import { runRecovery } from '../src/admin-recovery';
import { operationsHandoff } from '../src/operations-handoff';
import { diagnosticCodes } from '../src/schema-drift';

const slot = '2026-10-05T18:17:00.000Z',
  now = '2026-10-05T18:22:00.000Z';
function run(): RunDTO {
  return Run.parse({
    run_id: 'a'.repeat(64),
    canonical_run_id: 'a'.repeat(64),
    source_id: 'models_dev',
    logical_slot: slot,
    scheduled_for: slot,
    state: 'failed',
    started_at: slot,
    finished_at: slot,
    last_progress_at: slot,
    observation_count: null,
    accepted_count: null,
    quarantined_count: null,
    error_code: 'schema_drift_detected',
    recovery_count: 1,
    next_attempt_at: null,
    publication: {
      state: 'not_published',
      original_count: 0,
      derived_count: 0,
      visible_count: 0,
      completed_at: null,
    },
    checkpoints: [],
    attempts: [],
    invocations: [],
    details_truncated: false,
  });
}
function incident(overrides = {}) {
  return {
    schema_version: 1,
    source_id: 'models_dev',
    run_id: 'a'.repeat(64),
    detected_at: slot,
    observed_at: slot,
    stage: 'projection',
    classification: 'schema_drift',
    schema_drift: true,
    evidence_state: 'preserved',
    evidence_ref: 'evidence/models_dev/' + 'a'.repeat(64) + '.quarantine.json',
    evidence_hash: 'b'.repeat(64),
    expires_at: '2026-10-06T18:17:00.000Z',
    diagnostic_codes: ['wrapper_changed'],
    repair_status: 'not_started',
    ...overrides,
  };
}
function report(r = run()) {
  return {
    schema_version: 'admin-read-v1',
    resource: 'runs',
    fetched_at: now,
    as_of: now,
    state: 'ready',
    issues: [],
    next_cursor: null,
    runs: [r],
  };
}
it('projects diagnostic metadata without paths, raw payloads, arbitrary errors or invented agent results', () => {
  const r = runRecovery(
    run(),
    JSON.stringify({
      recovery: incident(),
      raw: 'PRIVATE_SENTINEL',
      authorization: 'Bearer SECRET',
    }),
    now,
  );
  expect(r).toMatchObject({
    state: 'recorded',
    schema_drift: true,
    evidence_state: 'preserved',
    agent_status: 'not_reported',
    repair_patch: 'not_reported',
    missing_observation_count: null,
    remaining_human_action: 'review_repair_candidate',
  });
  expect(JSON.stringify(r)).not.toMatch(/PRIVATE_SENTINEL|Bearer|evidence\/|evidence_ref/);
  expect(RunRecovery.safeParse(r).success).toBe(true);
  expect(RunRecovery.shape.diagnostic_codes.element.options).toEqual(diagnosticCodes);
});
it.each([
  null,
  '{}',
  JSON.stringify({ recovery: incident({ run_id: 'c'.repeat(64) }) }),
  JSON.stringify({ recovery: incident({ source_id: 'ecb' }) }),
  JSON.stringify({ recovery: incident({ raw: 'SECRET' }) }),
])('keeps absent or invalid diagnostics unknown', (metrics) => {
  expect(runRecovery(run(), metrics, now)).toMatchObject({
    state: 'not_reported',
    schema_drift: null,
    evidence_state: 'not_reported',
    missing_observation_count: null,
  });
});
it('withholds future diagnostics and later mutable run state from historical reads', () => {
  for (const [r, data] of [
    [run(), incident({ detected_at: '2026-10-05T18:30:00.000Z' })],
    [{ ...run(), state: 'unavailable_at_as_of' }, incident()],
  ] as const) {
    expect(runRecovery(r, JSON.stringify({ recovery: data }), now)).toMatchObject({
      state: 'unavailable_at_as_of',
      diagnostic_codes: [],
      evidence_hash: null,
      schema_drift: null,
      missing_observation_count: null,
      remaining_human_action: 'review_historical_state',
    });
  }
});
it('distinguishes semantic decisions, expired evidence and real collection/publication recovery', () => {
  expect(
    runRecovery(
      run(),
      JSON.stringify({ recovery: incident({ diagnostic_codes: ['pricing_basis_changed'] }) }),
      now,
    ).remaining_human_action,
  ).toBe('confirm_source_semantics');
  expect(
    runRecovery(run(), JSON.stringify({ recovery: incident({ expires_at: now }) }), now),
  ).toMatchObject({
    evidence_state: 'expired',
    remaining_human_action: 'evidence_unavailable_do_not_backfill',
  });
  const recovered = run();
  Object.assign(recovered, {
    state: 'complete',
    observation_count: 5,
    accepted_count: 5,
    quarantined_count: 0,
  });
  recovered.publication.state = 'complete';
  expect(runRecovery(recovered, JSON.stringify({ recovery: incident() }), now)).toMatchObject({
    recovery_result: 'completed_after_failure',
    missing_observation_count: 0,
    agent_status: 'not_reported',
  });
  recovered.publication.state = 'held';
  expect(
    runRecovery(recovered, JSON.stringify({ recovery: incident() }), now).recovery_result,
  ).toBe('not_completed');
  recovered.publication.state = 'complete';
  recovered.quarantined_count = 1;
  expect(runRecovery(recovered, null, now).remaining_human_action).toBe(
    'review_operational_alerts',
  );
});
it('makes a current, metadata-only handoff and rejects stale, missing and incomplete reads', async () => {
  const r = run();
  r.recovery = runRecovery(r, JSON.stringify({ recovery: incident() }), now);
  const packet = await operationsHandoff(report(r), slot, now);
  expect(packet).toMatchObject({
    state: 'ready',
    source_payload_included: false,
    agent_invoked: false,
    production_deploy_allowed: false,
    publication_allowed: false,
    coverage: 'provided_runs_only',
  });
  expect(packet.items[0]).toMatchObject({
    repair_action: 'prepare_code_patch_and_synthetic_tests',
    evidence_reparse: 'requires_authorized_private_executor',
    missing_observation: null,
  });
  expect(packet.items[0].admin_path).toContain('as_of=');
  expect(await operationsHandoff({ ...report(r), state: 'partial' }, slot, now)).toMatchObject({
    state: 'refresh_required',
    items: [],
  });
  expect(
    await operationsHandoff({ ...report(r), as_of: '2026-10-05T18:00:00.000Z' }, slot, now),
  ).toMatchObject({ state: 'refresh_required', items: [] });
  expect(
    await operationsHandoff({ ...report(r), next_cursor: 'next-page' }, slot, now),
  ).toMatchObject({ more_pages: true });
  await expect(operationsHandoff(report(r), '2026-10-04T18:17:00.000Z', now)).rejects.toThrow(
    'current_logical_slot_required',
  );
});
it('does not propose automatic repair for expired, semantic, unverified or noncanonical records', async () => {
  for (const changes of [
    { expires_at: now },
    { diagnostic_codes: ['semantics_changed'] },
    { evidence_state: 'partial' },
    { evidence_hash: null },
  ]) {
    const r = run();
    r.recovery = runRecovery(r, JSON.stringify({ recovery: incident(changes) }), now);
    expect((await operationsHandoff(report(r), slot, now)).items[0].repair_action).toBe(
      'investigate_metadata_and_report_blocker',
    );
  }
  const legacy = run();
  legacy.canonical_run_id = 'd'.repeat(64);
  legacy.recovery = runRecovery(legacy, JSON.stringify({ recovery: incident() }), now);
  expect((await operationsHandoff(report(legacy), slot, now)).items[0].repair_action).toBe(
    'read_canonical_current_run',
  );
});
it('filters past slots and complete runs, redacts errors, and never treats an empty run list as all healthy', async () => {
  const r = run();
  r.error_code = 'SECRET from upstream';
  expect((await operationsHandoff(report(r), slot, now)).items[0].error_code).toBe(
    'operation_failed',
  );
  r.logical_slot = '2026-10-04T18:17:00.000Z';
  expect((await operationsHandoff(report(r), slot, now)).items).toEqual([]);
  const good = run();
  Object.assign(good, { state: 'complete', quarantined_count: 0 });
  good.publication.state = 'complete';
  expect(await operationsHandoff(report(good), slot, now)).toMatchObject({
    items: [],
    coverage: 'provided_runs_only',
  });
  expect(await operationsHandoff({ ...report(), runs: [] }, slot, now)).toMatchObject({
    items: [],
    coverage: 'provided_runs_only',
  });
  expect(readFileSync('scripts/operations-handoff.mjs', 'utf8')).not.toMatch(
    /fetch\(|child_process|\.run\(|deploy\s/,
  );
});
