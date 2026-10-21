import highreso from '../../config/proposals/research/highreso_public.json';
import rebro from '../../config/proposals/research/rebro_public.json';
import type { CollectorEnv } from '../schema';
import { dailyCollectionSlot } from '../run-identity';
import { collectPublicGpuDay } from './public-gpu';
import { purgeResearchEvidence, reconcileResearchRun, type ResearchEnv } from './pipeline';
import { ResearchConfigSchema, type ResearchConfig } from './schema';
import { assertResearchConfigExecution } from './execution';
import { sourceRevocation } from './retention';

const privateGpuConfigs = [highreso, rebro];

// One in three idle continuations belongs to research; all others keep the
// existing GPU retention budget. The two sources alternate on research turns.
export function privateGpuResearchTurn(env: CollectorEnv, scheduled: string) {
  const tick = Math.floor(Date.parse(scheduled) / 300000);
  if (env.PRIVATE_GPU_RESEARCH_ENABLED !== 'true' || !Number.isFinite(tick) || tick % 3 !== 1)
    return null;
  return Math.floor(tick / 3) % 2;
}

// One reconciled run (20 observations), plus at most five expired evidence runs.
// The cursor is metadata only, outside the evidence lifecycle. It also revisits
// purged rows, so independently restored R2 objects cannot remain resurrected.
export async function maintainPrivateGpuResearch(
  env: ResearchEnv,
  config: ResearchConfig,
  now: string,
) {
  assertResearchConfigExecution(env, config);
  const sourceId = config.source.source_id;
  await purgeResearchEvidence(env, now, sourceId);
  const cursorKey = 'research-control/maintenance/' + sourceId + '.json';
  const cursorObject = await env.EVIDENCE.get(cursorKey);
  if (cursorObject && cursorObject.size > 1024) throw new Error('research_cursor_invalid');
  const cursor = cursorObject ? await cursorObject.text() : '';
  if (cursor !== '' && !/^[a-f0-9]{64}$/.test(cursor)) throw new Error('research_cursor_invalid');
  // Revocation drains unpurged runs first; the cursor resumes restore checking
  // once those are gone. An interrupted purge always has priority.
  const revoked = await sourceRevocation(env, sourceId);
  const urgent = await env.PRIVATE_DB.prepare(
    "SELECT run_id FROM research_runs WHERE source_id=? AND (lease_until IS NULL OR lease_until<=?) AND (state='purging' OR (state<>'purged' AND (?=1 OR normalized_expires_at<=?))) ORDER BY normalized_expires_at,run_id LIMIT 1",
  )
    .bind(sourceId, now, Number(revoked !== null), now)
    .first<{ run_id: string }>();
  const run =
    urgent ??
    (await env.PRIVATE_DB.prepare(
      'SELECT run_id FROM research_runs WHERE source_id=? AND (lease_until IS NULL OR lease_until<=?) ORDER BY (run_id>?) DESC,run_id LIMIT 1',
    )
      .bind(sourceId, now, cursor)
      .first<{ run_id: string }>());
  if (!run) return;
  const result = await reconcileResearchRun(env, config, run.run_id, now, config.terms.version);
  if (result?.remaining === null || result?.remaining === 0)
    await env.EVIDENCE.put(cursorKey, run.run_id);
}

// Source failures never propagate into normal collection, health or retention.
// Keep maintenance independent of acquisition authority: revoked/expired grants
// must still be cleaned, while collection goes through assertResearchAuthority.
export async function runPrivateGpuResearch(env: CollectorEnv, scheduled: string, now: string) {
  const turn = privateGpuResearchTurn(env, scheduled);
  if (turn === null) return;
  let config: ResearchConfig;
  try {
    config = ResearchConfigSchema.parse(privateGpuConfigs[turn]);
    await maintainPrivateGpuResearch(env, config, now);
  } catch {
    // Cleanup failure must not reopen this source; existing Collector work proceeds.
    return;
  }
  try {
    const slot = dailyCollectionSlot(env.COLLECTION_CRON, Date.parse(scheduled));
    await collectPublicGpuDay(env, [config], slot, (c) => ({
      current_terms_version: c.terms.version,
      allow_network: true,
      now: () => new Date().toISOString(),
    }));
  } catch {
    // A configuration or scheduler failure is isolated from existing work too.
  }
}
