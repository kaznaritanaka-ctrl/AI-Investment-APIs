import { z } from 'zod';
import { hash, isoTime, stable } from '../util';
import {
  assertResearchAllowed,
  assertResearchRetentionReviewed,
  ResearchConfigSchema,
  StorageReviewHoldSchema,
  type ResearchConfig,
} from './schema';
import type { ResearchEnv } from './pipeline';

export const plusDays = (at: string, days: number) =>
  new Date(Date.parse(at) + days * 86400000).toISOString();
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const sourceIdSchema = z.string().regex(/^[a-z0-9_-]+$/);
function localOnly(env: ResearchEnv) {
  if (env.ENVIRONMENT === 'production') throw new Error('research_production_not_integrated');
}

const LegacyRetentionSnapshotSchema = z
  .object({
    version: z.literal('research-retention-v1'),
    strategy: z.literal('d1_history'),
    evidence_days: z.number().int().positive(),
    archive_days: z.literal(0),
    normalized_days: z.number().int().positive().max(3650),
    backup_days: z.number().int().positive().max(30),
    time_travel_days: z.union([z.literal(7), z.literal(30)]),
    retention_limit_days: z.number().int().positive().nullable(),
    approval_ref: z.string().min(1),
    lifecycle_review_ref: z.string().min(1),
  })
  .strict();
const CurrentRetentionSnapshotSchema = LegacyRetentionSnapshotSchema.extend({
  version: z.literal('research-retention-v2'),
  normalized_mode: z.enum(['fixed_days', 'until_revoked']),
  normalized_days: z.number().int().positive().max(3650).nullable(),
  ongoing_storage: z
    .object({ basis_ref: z.string().min(1), owner_approval_ref: z.string().min(1) })
    .strict()
    .nullable(),
  storage_review_hold: StorageReviewHoldSchema.nullable(),
  storage_valid_until: z.iso.datetime().nullable(),
}).superRefine((r, c) => {
  if (
    r.normalized_mode === 'fixed_days'
      ? r.normalized_days === null
      : r.normalized_days !== null ||
        !r.ongoing_storage ||
        r.storage_valid_until !== null ||
        r.retention_limit_days !== null
  )
    c.addIssue({ code: 'custom', message: 'invalid_retention_mode' });
});
export const RetentionSnapshotSchema = z.union([
  CurrentRetentionSnapshotSchema,
  LegacyRetentionSnapshotSchema,
]);

export function retentionSnapshot(config: ResearchConfig) {
  const r = config.retention;
  return CurrentRetentionSnapshotSchema.parse({
    version: 'research-retention-v2',
    strategy: r.strategy,
    evidence_days: r.evidence_days,
    archive_days: r.archive_days,
    normalized_days: r.normalized_days,
    normalized_mode: r.normalized_mode,
    ongoing_storage: r.ongoing_storage,
    storage_review_hold: r.storage_review_hold,
    storage_valid_until: config.source.policy.valid_until,
    backup_days: r.backup_days,
    time_travel_days: r.time_travel_days,
    retention_limit_days: config.source.policy.retention_limit_days,
    approval_ref: r.reviewed_ref,
    lifecycle_review_ref: r.lifecycle_review_ref,
  });
}

export type RetainedRun = {
  run_id: string;
  source_id: string;
  config_hash: string;
  recorded_at: string;
  state: string;
  evidence_expires_at: string;
  evidence_purged_at: string | null;
  normalized_mode: 'fixed_days' | 'until_revoked';
  normalized_expires_at: string | null;
  all_copies_expires_at: string | null;
  retention_snapshot_json: string | null;
  lease_until: string | null;
};

// Historical rows are not subject to a current-observation freshness threshold.
// Current permission may shorten their use, but can never extend the captured deadline.
export function capturedRetention(run: RetainedRun) {
  if (!run.retention_snapshot_json) throw new Error('historical_retention_unreviewed');
  const captured = RetentionSnapshotSchema.parse(JSON.parse(run.retention_snapshot_json));
  const mode =
    captured.version === 'research-retention-v1' ? 'fixed_days' : captured.normalized_mode;
  if (
    mode !== run.normalized_mode ||
    (mode === 'fixed_days' && (!run.normalized_expires_at || !run.all_copies_expires_at))
  )
    throw new Error('historical_retention_unreviewed');
  return captured;
}
const earliest = (dates: (string | null)[]): string | null =>
  dates.filter((d): d is string => d !== null).sort()[0] ?? null;
export function historyExpiry(config: ResearchConfig, run: RetainedRun): string | null {
  const captured = capturedRetention(run);
  const current = config.retention;
  assertResearchRetentionReviewed(config);
  if (current.time_travel_days === null || current.time_travel_days > captured.backup_days)
    throw new Error('historical_backup_review_required');
  const deadlines = [
    run.normalized_expires_at,
    captured.normalized_days === null ? null : plusDays(run.recorded_at, captured.normalized_days),
    current.normalized_mode === 'fixed_days'
      ? plusDays(run.recorded_at, current.normalized_days!)
      : null,
    run.all_copies_expires_at === null
      ? null
      : plusDays(run.all_copies_expires_at, -current.time_travel_days),
    captured.version === 'research-retention-v2' ? captured.storage_valid_until : null,
    config.source.policy.valid_until,
  ];
  const limit = config.source.policy.retention_limit_days;
  if (limit !== null) deadlines.push(plusDays(run.recorded_at, limit - current.backup_days));
  return earliest(deadlines);
}

export function allCopiesExpiry(config: ResearchConfig, run: RetainedRun): string | null {
  const captured = run.retention_snapshot_json
    ? RetentionSnapshotSchema.safeParse(JSON.parse(run.retention_snapshot_json))
    : null;
  const deadlines = [
    run.all_copies_expires_at,
    captured?.success &&
    captured.data.version === 'research-retention-v2' &&
    captured.data.storage_valid_until
      ? plusDays(captured.data.storage_valid_until, captured.data.backup_days)
      : null,
    config.retention.normalized_mode === 'fixed_days' && config.retention.normalized_days !== null
      ? plusDays(run.recorded_at, config.retention.normalized_days + config.retention.backup_days)
      : null,
    config.source.policy.valid_until === null
      ? null
      : plusDays(config.source.policy.valid_until, config.retention.backup_days),
  ];
  if (config.source.policy.retention_limit_days !== null)
    deadlines.push(plusDays(run.recorded_at, config.source.policy.retention_limit_days));
  return earliest(deadlines);
}

export type RetentionDecision = {
  state:
    | 'active'
    | 'review_due'
    | 'collection_stopped'
    | 'rights_unknown'
    | 'retention_expired'
    | 'delete_required';
  reasons: string[];
  storage: 'allowed' | 'review_hold' | 'unknown' | 'prohibited';
  collection_allowed: boolean;
  read_allowed: boolean;
  normalized_deadline: string | null;
  all_copies_deadline: string | null;
  review_deadline: string | null;
  basis_refs: string[];
  next_action: 'retain' | 'review_terms' | 'review_rights' | 'delete';
};
export function assessResearchRetention(
  config: ResearchConfig,
  run: RetainedRun,
  now: string,
  currentTerms: string,
  historyApproved: boolean,
): RetentionDecision {
  const p = config.source.policy,
    r = config.retention;
  const d: RetentionDecision = {
    state: 'active',
    reasons: [],
    storage: 'allowed',
    collection_allowed: false,
    read_allowed: false,
    normalized_deadline: run.normalized_expires_at,
    all_copies_deadline: allCopiesExpiry(config, run),
    review_deadline: null,
    basis_refs: [...p.evidence_refs, ...(r.reviewed_ref ? [r.reviewed_ref] : [])],
    next_action: 'retain',
  };
  let captured: ReturnType<typeof capturedRetention> | null = null;
  let reviewed = true;
  try {
    captured = capturedRetention(run);
    d.normalized_deadline = historyExpiry(config, run);
  } catch {
    reviewed = false;
    d.reasons.push('retention_contract_review_required');
  }
  const remove = (state: 'delete_required' | 'retention_expired', reason: string) => {
    d.state = state;
    d.storage = 'prohibited';
    d.next_action = 'delete';
    d.reasons.push(reason);
    return d;
  };
  // Explicit storage end and captured deadlines are not internal review reminders.
  if (p.rights.private_storage === 'denied' || p.rights.private_storage === 'expired') {
    d.all_copies_deadline = earliest([
      d.all_copies_deadline,
      plusDays(now, Math.min(r.backup_days, captured?.backup_days ?? r.backup_days)),
    ]);
    return remove('delete_required', 'storage_right_ended');
  }
  if (p.valid_until !== null && now >= p.valid_until)
    return remove('delete_required', 'storage_grant_ended');
  if (
    captured?.version === 'research-retention-v2' &&
    captured.storage_valid_until &&
    now >= captured.storage_valid_until
  )
    return remove('delete_required', 'captured_storage_grant_ended');
  if (d.normalized_deadline !== null && now >= d.normalized_deadline)
    return remove('retention_expired', 'normalized_deadline_reached');
  const termsChanged = config.terms.version !== currentTerms || p.evidence_version !== currentTerms;
  const storageUnknown =
    !reviewed || p.rights.private_storage !== 'allowed' || now < p.valid_from || termsChanged;
  if (storageUnknown) {
    d.state = 'rights_unknown';
    d.next_action = 'review_rights';
    d.reasons.push('storage_basis_requires_review');
    const hold =
      captured?.version === 'research-retention-v2' ? captured.storage_review_hold : null;
    if (!hold) {
      // No storage exception was granted. Escalate immediately; keep known deletion
      // deadlines, but never invent a grace period or an unlimited storage permission.
      d.storage = 'unknown';
      d.review_deadline = now;
      d.reasons.push('storage_review_hold_unavailable');
      return d;
    }
    // Only a previously approved finite storage-only hold is usable. An unknown right is not a grant.
    const deadline = earliest([
      hold.all_copies_delete_by,
      r.storage_review_hold?.all_copies_delete_by ?? null,
      d.all_copies_deadline,
    ]);
    d.storage = 'review_hold';
    d.all_copies_deadline = deadline;
    d.review_deadline = deadline === null ? null : plusDays(deadline, -r.backup_days);
    d.basis_refs.push(hold.basis_ref, hold.owner_approval_ref);
    if (d.review_deadline !== null && now >= d.review_deadline)
      return remove('delete_required', 'approved_storage_review_hold_ended');
    return d;
  }
  if (
    !historyApproved ||
    !config.owner_approval_ref ||
    !config.wire_contract_review_ref ||
    p.rights.internal_analysis !== 'allowed'
  ) {
    d.state = 'rights_unknown';
    d.next_action = 'review_rights';
    d.reasons.push('analysis_or_historical_scope_unconfirmed');
    return d;
  }
  if (now < config.terms.checked_at || now >= config.terms.review_after) {
    d.state = 'review_due';
    d.next_action = 'review_terms';
    d.review_deadline = config.terms.review_after;
    d.reasons.push('periodic_terms_review_due');
    return d;
  }
  d.read_allowed = true;
  if (!config.source.enabled || p.rights.automated_collection !== 'allowed') {
    d.state = 'collection_stopped';
    d.reasons.push('new_collection_stopped');
  } else d.collection_allowed = true;
  return d;
}

export async function auditRetentionDecision(
  env: ResearchEnv,
  config: ResearchConfig,
  run: RetainedRun,
  now: string,
  currentTerms: string,
  decision: RetentionDecision,
) {
  localOnly(env);
  const decisionJson = stable({
    ...decision,
    current_rights: {
      collection: config.source.policy.rights.automated_collection,
      storage: config.source.policy.rights.private_storage,
      analysis: config.source.policy.rights.internal_analysis,
    },
    current_terms_version: currentTerms,
    evidence_status: run.evidence_purged_at
      ? 'deleted'
      : run.evidence_expires_at <= now
        ? 'expired'
        : 'within_retention_unverified',
    revalidation:
      run.evidence_purged_at || run.evidence_expires_at <= now
        ? 'unavailable'
        : 'requires_projection_check',
  });
  const digest = await hash(stable(config));
  await env.PRIVATE_DB.prepare(
    'INSERT OR IGNORE INTO research_retention_assessments(assessment_id,run_id,assessed_at,config_hash,state,decision_json) VALUES (?,?,?,?,?,?)',
  )
    .bind(
      await hash(stable([run.run_id, now, digest, decisionJson])),
      run.run_id,
      now,
      digest,
      decision.state,
      decisionJson,
    )
    .run();
}

// These metadata-only markers live outside the evidence lifecycle prefix and D1 Time Travel.
// A D1 rollback must never resurrect a revoked source or deleted run.
const controlPrefix = 'research-control/';
export function sourceRevocationKey(sourceId: string) {
  return controlPrefix + 'revocations/' + sourceIdSchema.parse(sourceId) + '.json';
}
export function runDeletionKey(sourceId: string, runId: string) {
  return (
    controlPrefix +
    'deletions/' +
    sourceIdSchema.parse(sourceId) +
    '/' +
    digestSchema.parse(runId) +
    '.json'
  );
}
export async function assertNotRevoked(env: ResearchEnv, sourceId: string, runId?: string) {
  localOnly(env);
  if (await env.EVIDENCE.head(sourceRevocationKey(sourceId)))
    throw new Error('research_source_revoked');
  if (runId && (await env.EVIDENCE.head(runDeletionKey(sourceId, runId))))
    throw new Error('research_run_deleted');
}
const DeletionMarkerSchema = z.object({
  source_id: sourceIdSchema,
  run_id: digestSchema,
  deleted_from: z.iso.datetime(),
  reason: z.string().min(1).max(80).optional(),
  all_copies_delete_by: z.iso.datetime().nullable().optional(),
  basis_refs: z.array(z.string().min(1)).optional(),
});
export async function recordDeletion(
  env: ResearchEnv,
  sourceId: string,
  runId: string,
  at: string,
  reason:
    | 'expired'
    | 'revoked'
    | 'storage_right_ended'
    | 'storage_review_hold_ended'
    | 'explicit_delete_request',
  obligation?: { basis_refs: string[]; all_copies_delete_by: string | null },
) {
  localOnly(env);
  if (!isoTime(at)) throw new Error('invalid_retention_time');
  const key = runDeletionKey(sourceId, runId);
  const existing = await env.EVIDENCE.get(key);
  if (existing && existing.size > 16384) throw new Error('invalid_deletion_marker');
  const prior = existing ? DeletionMarkerSchema.parse(await existing.json()) : null;
  if (prior && (prior.source_id !== sourceId || prior.run_id !== runId))
    throw new Error('invalid_deletion_marker');
  if (
    prior &&
    (!obligation?.all_copies_delete_by ||
      (prior.all_copies_delete_by && prior.all_copies_delete_by <= obligation.all_copies_delete_by))
  )
    return;
  // A later request can only tighten the deadline, never remove the deny record or
  // reset its original timestamp. A CAS conflict must be retried, not reported as saved.
  const saved = await env.EVIDENCE.put(
    key,
    stable({
      version: 1,
      source_id: sourceId,
      run_id: runId,
      deleted_from: prior?.deleted_from ?? at,
      reason: prior?.reason ?? reason,
      ...obligation,
      basis_refs: [...new Set([...(prior?.basis_refs ?? []), ...(obligation?.basis_refs ?? [])])],
    }),
    {
      onlyIf: existing ? { etagMatches: existing.etag } : { etagDoesNotMatch: '*' },
      httpMetadata: { contentType: 'application/json' },
    },
  );
  if (!saved) throw new Error('research_deletion_marker_conflict');
}
export async function requestResearchDeletion(
  env: ResearchEnv,
  runId: string,
  at: string,
  request: { basis_ref: string; all_copies_delete_by: string },
) {
  localOnly(env);
  const approved = z
    .object({ basis_ref: z.string().trim().min(1), all_copies_delete_by: z.iso.datetime() })
    .strict()
    .parse(request);
  const run = await env.PRIVATE_DB.prepare('SELECT source_id FROM research_runs WHERE run_id=?')
    .bind(runId)
    .first<{ source_id: string }>();
  if (!run) throw new Error('research_run_missing');
  await recordDeletion(env, run.source_id, runId, at, 'explicit_delete_request', {
    basis_refs: [approved.basis_ref],
    all_copies_delete_by: approved.all_copies_delete_by,
  });
}

export async function deletionObligation(
  env: ResearchEnv,
  run: Pick<RetainedRun, 'source_id' | 'run_id'>,
) {
  localOnly(env);
  const body = await env.EVIDENCE.get(runDeletionKey(run.source_id, run.run_id));
  if (!body) return null;
  if (body.size > 16384) throw new Error('invalid_deletion_marker');
  const marker = DeletionMarkerSchema.parse(await body.json());
  if (marker.source_id !== run.source_id || marker.run_id !== run.run_id)
    throw new Error('invalid_deletion_marker');
  return marker;
}
export async function sourceRevocation(env: ResearchEnv, sourceId: string) {
  localOnly(env);
  const body = await env.EVIDENCE.get(sourceRevocationKey(sourceId));
  if (!body) return null;
  if (body.size > 16384) throw new Error('invalid_revocation_marker');
  const marker = z
    .object({ source_id: sourceIdSchema, revoked_at: z.iso.datetime() })
    .parse(await body.json());
  if (marker.source_id !== sourceId) throw new Error('invalid_revocation_marker');
  return marker;
}
export async function revokeResearchSource(env: ResearchEnv, sourceId: string, at: string) {
  localOnly(env);
  if (!isoTime(at)) throw new Error('invalid_retention_time');
  // Persist the external deny record first. Suspend the current DB even if R2 fails,
  // but propagate the failure: restore protection is incomplete until the marker is saved.
  try {
    await env.EVIDENCE.put(
      sourceRevocationKey(sourceId),
      stable({ version: 1, source_id: sourceId, revoked_at: at }),
      {
        onlyIf: { etagDoesNotMatch: '*' },
        httpMetadata: { contentType: 'application/json' },
      },
    );
  } finally {
    await env.PRIVATE_DB.prepare('UPDATE research_sources SET suspended=1 WHERE source_id=?')
      .bind(sourceId)
      .run();
  }
}

export async function saveResearchConfigVersion(
  env: ResearchEnv,
  config: ResearchConfig,
  digest: string,
  now: string,
) {
  localOnly(env);
  await env.PRIVATE_DB.prepare(
    'INSERT OR IGNORE INTO research_config_versions(config_hash,source_id,policy_version,registered_at,config_json) VALUES (?,?,?,?,?)',
  )
    .bind(digest, config.source.source_id, config.source.policy.version, now, stable(config))
    .run();
  const saved = await env.PRIVATE_DB.prepare(
    'SELECT config_hash FROM research_config_versions WHERE source_id=? AND policy_version=?',
  )
    .bind(config.source.source_id, config.source.policy.version)
    .first<{ config_hash: string }>();
  if (saved?.config_hash !== digest) throw new Error('research_policy_version_reused');
}

// Explicit local policy renewal. No active grants, production entrypoint or schedule is added.
export async function adoptReviewedResearchConfig(
  env: ResearchEnv,
  config: ResearchConfig,
  expectedCurrentHash: string,
  now: string,
  currentTerms: string,
) {
  localOnly(env);
  if (config.source.enabled) assertResearchAllowed(config, now, currentTerms);
  else {
    // Disabled policy assessments may record uncertainty/denial without granting data use.
    ResearchConfigSchema.parse(config);
    if (!isoTime(now) || !config.owner_approval_ref) throw new Error('research_review_required');
  }
  await assertNotRevoked(env, config.source.source_id);
  const old = await env.PRIVATE_DB.prepare(
    'SELECT config_hash,policy_version,suspended FROM research_sources WHERE source_id=?',
  )
    .bind(config.source.source_id)
    .first<{ config_hash: string; policy_version: string; suspended: number }>();
  if (
    !old ||
    old.suspended ||
    old.config_hash !== expectedCurrentHash ||
    old.policy_version === config.source.policy.version
  )
    throw new Error('research_policy_changed');
  for (const approval of config.history_access) {
    const row = await env.PRIVATE_DB.prepare(
      'SELECT source_id,config_json FROM research_config_versions WHERE config_hash=?',
    )
      .bind(approval.config_hash)
      .first<{ source_id: string; config_json: string }>();
    if (!row || row.source_id !== config.source.source_id)
      throw new Error('research_history_scope_unreviewed');
    const prior = ResearchConfigSchema.parse(JSON.parse(row.config_json));
    if (
      prior.adapter !== config.adapter ||
      stable(prior.scope) !== stable(config.scope) ||
      prior.source.source_url !== config.source.source_url ||
      prior.method_version !== config.method_version ||
      !prior.source.policy.fields.every((field) => config.source.policy.fields.includes(field))
    )
      throw new Error('research_history_scope_unreviewed');
  }
  const digest = await hash(stable(config));
  await saveResearchConfigVersion(env, config, digest, now);
  const result = await env.PRIVATE_DB.prepare(
    'UPDATE research_sources SET policy_version=?,config_hash=? WHERE source_id=? AND config_hash=? AND suspended=0',
  )
    .bind(config.source.policy.version, digest, config.source.source_id, expectedCurrentHash)
    .run();
  if (!result.meta.changes) throw new Error('research_policy_changed');
  return digest;
}
