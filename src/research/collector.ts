import highreso from '../../config/proposals/research/highreso_public.json';
import rebro from '../../config/proposals/research/rebro_public.json';
import type { CollectorEnv } from '../schema';
import { dailyCollectionSlot } from '../run-identity';
import { emitLog, safeLogCode } from '../telemetry';
import { errorCode, hash, stable } from '../util';
import { collectPublicGpuDay } from './public-gpu';
import { purgeResearchEvidence, reconcileResearchRun, type ResearchEnv } from './pipeline';
import { ResearchConfigSchema, type ResearchConfig } from './schema';
import { assertResearchConfigExecution } from './execution';
import { requestResearchDeletion, revokeResearchSource, sourceRevocation } from './retention';

const privateGpuConfigs = [highreso, rebro];
const requiredMigrations = [
  '0007_private_research.sql',
  '0008_research_retention.sql',
  '0009_research_retention_states.sql',
  '0014_research_assessments_append_only.sql',
  '0015_private_gpu_daily.sql',
];
function logFailure(sourceId: string, phase: string, error: unknown) {
  emitLog({ source_id: sourceId, phase, error_code: safeLogCode(errorCode(error)) });
}

// Journal inspection only. No automatic migration, research data or R2 access.
async function assertResearchSchema(env: ResearchEnv) {
  try {
    const rows = await env.PRIVATE_DB.prepare(
      'SELECT name FROM d1_migrations WHERE name IN (?,?,?,?,?)',
    )
      .bind(...requiredMigrations)
      .all<{ name: string }>();
    if (!requiredMigrations.every((name) => rows.results.some((r) => r.name === name)))
      throw new Error('research_schema_unavailable');
  } catch {
    throw new Error('research_schema_unavailable');
  }
}

// One in three idle continuations belongs to research; all others keep the
// existing GPU retention budget. The two sources alternate on research turns.
export function privateGpuResearchTurn(env: CollectorEnv, scheduled: string) {
  const tick = Math.floor(Date.parse(scheduled) / 300000);
  if (env.PRIVATE_GPU_RESEARCH_ENABLED !== 'true' || !Number.isFinite(tick) || tick % 3 !== 1)
    return null;
  return Math.floor(tick / 3) % 2;
}

// Controls may only narrow use. Validate source ownership before creating a
// deletion marker; metadata survives DB restores and cannot be cleared here.
async function applyMaintenanceControls(env: ResearchEnv, config: ResearchConfig, now: string) {
  const sourceId = config.source.source_id;
  const control = config.maintenance;
  let failed = false;
  if (control?.revoke_at && control.revoke_at <= now) {
    try {
      await revokeResearchSource(env, sourceId, control.revoke_at);
    } catch (error) {
      logFailure(sourceId, 'research_control', error);
      failed = true;
    }
  }
  for (const request of control?.delete_requests ?? []) {
    if (request.requested_at > now) continue;
    try {
      const row = await env.PRIVATE_DB.prepare('SELECT source_id FROM research_runs WHERE run_id=?')
        .bind(request.run_id)
        .first<{ source_id: string }>();
      if (row?.source_id !== sourceId) throw new Error('research_deletion_scope_invalid');
      await requestResearchDeletion(env, request.run_id, request.requested_at, {
        basis_ref: request.basis_ref,
        all_copies_delete_by: request.all_copies_delete_by,
      });
    } catch (error) {
      logFailure(sourceId, 'research_control', error);
      failed = true;
    }
  }
  return !failed;
}

// One reconciled run (20 observations), plus at most five expired evidence runs.
// Alternate urgent and circular scans, including after failure: a broken run must
// be retried without starving other runs or independently restored R2 evidence.
export async function maintainPrivateGpuResearch(
  env: ResearchEnv,
  config: ResearchConfig,
  now: string,
) {
  assertResearchConfigExecution(env, config);
  const sourceId = config.source.source_id;
  let failed = !(await applyMaintenanceControls(env, config, now));
  try {
    await purgeResearchEvidence(env, now, sourceId);
  } catch (error) {
    logFailure(sourceId, 'research_evidence_maintenance', error);
    failed = true;
  }
  const cursorKey = 'research-control/maintenance/' + sourceId + '.json';
  const cursorObject = await env.EVIDENCE.get(cursorKey);
  if (cursorObject && cursorObject.size > 1024) throw new Error('research_cursor_invalid');
  const body = cursorObject ? await cursorObject.text() : '';
  let cursor = '',
    wasUrgent = false;
  if (/^[a-f0-9]{64}$/.test(body))
    cursor = body; // Legacy metadata, no data migration.
  else if (body) {
    try {
      const saved = JSON.parse(body);
      if (!/^[a-f0-9]{64}$/.test(saved.run_id) || typeof saved.urgent !== 'boolean')
        throw new Error();
      cursor = saved.run_id;
      wasUrgent = saved.urgent;
    } catch {
      throw new Error('research_cursor_invalid');
    }
  }
  const revoked = await sourceRevocation(env, sourceId);
  const urgent = wasUrgent
    ? null
    : await env.PRIVATE_DB.prepare(
        "SELECT run_id,config_hash FROM research_runs WHERE source_id=? AND (lease_until IS NULL OR lease_until<=?) AND (state='purging' OR (state<>'purged' AND (?=1 OR normalized_expires_at<=? OR run_id IN (" +
          (config.maintenance?.delete_requests.length
            ? config.maintenance.delete_requests.map(() => '?').join(',')
            : 'NULL') +
          ')))) ORDER BY (run_id>?) DESC,run_id LIMIT 1',
      )
        .bind(
          sourceId,
          now,
          Number(revoked !== null),
          now,
          ...(config.maintenance?.delete_requests.map((r) => r.run_id) ?? []),
          cursor,
        )
        .first<{ run_id: string; config_hash: string }>();
  const run =
    urgent ??
    (await env.PRIVATE_DB.prepare(
      'SELECT run_id,config_hash FROM research_runs WHERE source_id=? AND (lease_until IS NULL OR lease_until<=?) ORDER BY (run_id>?) DESC,run_id LIMIT 1',
    )
      .bind(sourceId, now, cursor)
      .first<{ run_id: string; config_hash: string }>());
  if (run) {
    try {
      // Immutable captured config owns retention. The current bundled config may
      // be disabled, unapproved or a new hash; none of those extends old deadlines.
      const version = await env.PRIVATE_DB.prepare(
        'SELECT config_json FROM research_config_versions WHERE source_id=? AND config_hash=?',
      )
        .bind(sourceId, run.config_hash)
        .first<{ config_json: string }>();
      let saved: ResearchConfig;
      try {
        saved = ResearchConfigSchema.parse(JSON.parse(version?.config_json ?? 'null'));
        if (
          saved.source.source_id !== sourceId ||
          saved.adapter !== config.adapter ||
          (await hash(stable(saved))) !== run.config_hash
        )
          throw new Error();
      } catch {
        throw new Error('research_config_version_invalid');
      }
      await reconcileResearchRun(env, saved, run.run_id, now, saved.terms.version);
    } catch (error) {
      logFailure(sourceId, 'research_run_maintenance', error);
      failed = true;
    } finally {
      await env.EVIDENCE.put(cursorKey, stable({ run_id: run.run_id, urgent: urgent !== null }));
    }
  }
  // Block acquisition for this invocation, but the next turn keeps scanning.
  return !failed;
}

// Source failures never propagate into normal collection, health or retention.
export async function runPrivateGpuResearch(env: CollectorEnv, scheduled: string, now: string) {
  const turn = privateGpuResearchTurn(env, scheduled);
  if (turn === null) return;
  const sourceId = privateGpuConfigs[turn].source.source_id;
  try {
    await assertResearchSchema(env);
    const config = ResearchConfigSchema.parse(privateGpuConfigs[turn]);
    if (!(await maintainPrivateGpuResearch(env, config, now))) return;
    if (
      !config.source.enabled ||
      config.maintenance?.collection_stopped ||
      config.maintenance?.revoke_at
    ) {
      logFailure(sourceId, 'research_acquisition', new Error('research_collection_stopped'));
      return;
    }
    const slot = dailyCollectionSlot(env.COLLECTION_CRON, Date.parse(scheduled));
    const results = await collectPublicGpuDay(env, [config], slot, (c) => ({
      current_terms_version: c.terms.version,
      allow_network: true,
      now: () => new Date().toISOString(),
    }));
    for (const result of results)
      if (result.reason) logFailure(sourceId, 'research_acquisition', new Error(result.reason));
  } catch (error) {
    logFailure(sourceId, 'research_maintenance_or_acquisition', error);
  }
}
