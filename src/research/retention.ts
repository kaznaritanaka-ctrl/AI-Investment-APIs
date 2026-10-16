import { z } from 'zod';
import { hash, isoTime, stable } from '../util';
import {
  assertResearchAllowed,
  assertResearchHistoryAllowed,
  ResearchConfigSchema,
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

export const RetentionSnapshotSchema = z
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

export function retentionSnapshot(config: ResearchConfig) {
  const r = config.retention;
  return RetentionSnapshotSchema.parse({
    version: 'research-retention-v1',
    strategy: r.strategy,
    evidence_days: r.evidence_days,
    archive_days: r.archive_days,
    normalized_days: r.normalized_days,
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
  normalized_expires_at: string;
  all_copies_expires_at: string | null;
  retention_snapshot_json: string | null;
  lease_until: string | null;
};

// Historical rows are not subject to a current-observation freshness threshold.
// Current permission may shorten their use, but can never extend the captured deadline.
export function historyExpiry(config: ResearchConfig, run: RetainedRun): string {
  if (!run.retention_snapshot_json || !run.all_copies_expires_at)
    throw new Error('historical_retention_unreviewed');
  const captured = RetentionSnapshotSchema.parse(JSON.parse(run.retention_snapshot_json));
  const current = config.retention;
  if (
    current.normalized_days === null ||
    current.time_travel_days === null ||
    current.time_travel_days > captured.backup_days
  )
    throw new Error('historical_backup_review_required');
  const deadlines = [
    run.normalized_expires_at,
    plusDays(run.recorded_at, captured.normalized_days),
    plusDays(run.recorded_at, current.normalized_days),
    plusDays(run.all_copies_expires_at, -current.time_travel_days),
  ];
  const limit = config.source.policy.retention_limit_days;
  if (limit !== null) deadlines.push(plusDays(run.recorded_at, limit - current.backup_days));
  return deadlines.sort()[0];
}

export function allCopiesExpiry(config: ResearchConfig, run: RetainedRun): string | null {
  if (!run.all_copies_expires_at || config.retention.normalized_days === null) return null;
  const deadlines = [
    run.all_copies_expires_at,
    plusDays(run.recorded_at, config.retention.normalized_days + config.retention.backup_days),
  ];
  if (config.source.policy.retention_limit_days !== null)
    deadlines.push(plusDays(run.recorded_at, config.source.policy.retention_limit_days));
  return deadlines.sort()[0];
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
export async function recordDeletion(
  env: ResearchEnv,
  sourceId: string,
  runId: string,
  at: string,
  reason: 'expired' | 'revoked' | 'permission_lapsed',
) {
  localOnly(env);
  if (!isoTime(at)) throw new Error('invalid_retention_time');
  await env.EVIDENCE.put(
    runDeletionKey(sourceId, runId),
    stable({ version: 1, source_id: sourceId, run_id: runId, deleted_from: at, reason }),
    {
      onlyIf: { etagDoesNotMatch: '*' },
      httpMetadata: { contentType: 'application/json' },
    },
  );
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
  else assertResearchHistoryAllowed(config, now, currentTerms);
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
