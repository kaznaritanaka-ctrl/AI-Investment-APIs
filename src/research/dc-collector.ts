import type { CollectorEnv } from '../schema';
import { emitLog, safeLogCode } from '../telemetry';
import { errorCode } from '../util';
import { dcCollectionSlot } from './dc-contract';
import { dcResearchConfigs } from './dc-sources';
import { collectResearchPage } from './pipeline';
import { maintainPrivateGpuResearch } from './collector';

export function dcTrackerTurn(
  env: Pick<CollectorEnv, 'DC_TRACKER_ENABLED' | 'COLLECTION_CRON'>,
  scheduled: string,
) {
  return (
    env.DC_TRACKER_ENABLED === 'true' &&
    env.COLLECTION_CRON === '17 18 * * *' &&
    dcCollectionSlot(scheduled) !== null
  );
}

export async function runDCTracker(env: CollectorEnv, scheduled: string, now: string) {
  const slot = dcCollectionSlot(scheduled);
  if (!slot || !dcTrackerTurn(env, slot)) return;
  // Do not add 0016 to the independent GPU gate or perform automatic migration.
  const required = [
    '0007_private_research.sql',
    '0008_research_retention.sql',
    '0009_research_retention_states.sql',
    '0014_research_assessments_append_only.sql',
    '0016_dc_tracker.sql',
  ];
  try {
    const rows = await env.PRIVATE_DB.prepare(
      'SELECT name FROM d1_migrations WHERE name IN (?,?,?,?,?)',
    )
      .bind(...required)
      .all<{ name: string }>();
    if (!required.every((name) => rows.results.some((r) => r.name === name)))
      throw new Error('dc_schema_unavailable');
  } catch {
    emitLog({ phase: 'dc_tracker', error_code: 'dc_schema_unavailable' });
    return;
  }
  // Sequential and source-isolated. Each run's durable request counter includes robots.
  for (const config of dcResearchConfigs) {
    try {
      if (!(await maintainPrivateGpuResearch(env, config, now))) continue;
      await collectResearchPage(env, config, { kind: 'dc_tracker' }, slot, {
        current_terms_version: config.terms.version,
        allow_network: true,
      });
    } catch (error) {
      emitLog({
        source_id: config.source.source_id,
        phase: 'dc_tracker',
        error_code: safeLogCode(errorCode(error)),
      });
    }
  }
}

// Existing idle continuation slots rotate one source's retention work, including disabled grants.
// Acquisition remains Monday-only. Read gates also hide expired history immediately.
export async function maintainDCTracker(env: CollectorEnv, scheduled: string, now: string) {
  const tick = Math.floor(Date.parse(scheduled) / 300000);
  if (env.DC_TRACKER_ENABLED !== 'true' || !Number.isFinite(tick) || tick % 3 !== 2) return;
  const config = dcResearchConfigs[Math.floor(tick / 3) % dcResearchConfigs.length];
  try {
    await maintainPrivateGpuResearch(env, config, now);
  } catch (error) {
    emitLog({
      source_id: config.source.source_id,
      phase: 'dc_maintenance',
      error_code: safeLogCode(errorCode(error)),
    });
  }
}
