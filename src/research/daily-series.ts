import { D, hash, isoTime, stable } from '../util';
import { isPublicGpu } from './public-gpu-contract';
import { PublicGpuRecordSchema, type PublicGpuRecord } from './public-gpu-html';
import { compareDomesticGPU } from './domestic-gpu';
import { readResearchRun, type ResearchEnv } from './pipeline';
import { ResearchConfigSchema, type ResearchConfig } from './schema';
import { historyExpiry, type RetainedRun } from './retention';

// Adapted from PR #18. Rights/review/retention changes do not redefine prices.
// No aliasing across parser, source, scope, normalization or unit changes.
export function dailySeriesDefinition(config: ResearchConfig) {
  if (!isPublicGpu(config.adapter) || !('models' in config.scope))
    throw new Error('daily_series_scope');
  return {
    version: 'daily-comparison-v1',
    source_id: config.source.source_id,
    endpoint: config.source.endpoint,
    method_version: config.method_version,
    scope: {
      models: [...config.scope.models].sort(),
      gpu_counts: 'gpu_counts' in config.scope ? [...(config.scope.gpu_counts ?? [])].sort() : null,
    },
    normalization_version: 'domestic-gpu-normalization-v1',
    unit_definition:
      config.adapter === 'highreso_public'
        ? 'JPY:node_hour|month:instance:v1'
        : 'JPY:gpu:single_gpu:v1',
  };
}
type ReadOptions = Parameters<typeof readResearchRun>[3];
async function snapshot(env: ResearchEnv, config: ResearchConfig, runId: string, opt: ReadOptions) {
  // Reuse current rights, immutable deadlines, approved historical hashes and
  // external revocation/deletion checks before returning any private observation.
  const rows = (await readResearchRun(env, config, runId, opt)).results;
  const run = await env.PRIVATE_DB.prepare(
    "SELECT * FROM research_runs WHERE run_id=? AND source_id=? AND state='complete'",
  )
    .bind(runId, config.source.source_id)
    .first<
      RetainedRun & {
        scheduled_for: string;
        synthetic: number;
        observation_count: number;
      }
    >();
  // Empty snapshots are valid; distinguish them from missing/expired/hidden runs.
  // readResearchRun returns [] for expired runs, so inspect its captured deadlines too.
  if (!run || rows.length !== run.observation_count) throw new Error('daily_history_unavailable');
  const expiry = historyExpiry(config, run);
  if (expiry !== null && expiry <= (opt.now ?? (() => new Date().toISOString()))())
    throw new Error('daily_history_unavailable');
  const saved = await env.PRIVATE_DB.prepare(
    'SELECT config_json FROM research_config_versions WHERE config_hash=?',
  )
    .bind(run.config_hash)
    .first<{ config_json: string }>();
  if (!saved) throw new Error('daily_history_unavailable');
  const historical = ResearchConfigSchema.parse(JSON.parse(saved.config_json));
  if ((await hash(stable(historical))) !== run.config_hash)
    throw new Error('daily_config_conflict');
  const definition = dailySeriesDefinition(historical);
  return {
    run_id: run.run_id,
    config_hash: run.config_hash,
    scheduled_for: run.scheduled_for,
    recorded_at: run.recorded_at,
    synthetic: run.synthetic,
    series_key: await hash(stable(definition)),
    definition,
    rows,
  };
}

// Bounded private history only. No HTTP endpoint, PUBLIC_DB, raw export or LLM path.
export async function readPublicGpuHistory(
  env: ResearchEnv,
  config: ResearchConfig,
  window: { from: string; to: string; synthetic: boolean; limit?: number },
  opt: ReadOptions,
) {
  dailySeriesDefinition(config);
  const limit = window.limit ?? 31;
  if (
    !isoTime(window.from) ||
    !isoTime(window.to) ||
    window.from > window.to ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 31
  )
    throw new Error('daily_history_window');
  // Check authority even when no runs match the requested window.
  await readResearchRun(env, config, '', opt);
  const runs = await env.PRIVATE_DB.prepare(
    "SELECT run_id FROM research_runs WHERE source_id=? AND synthetic=? AND scheduled_for>=? AND scheduled_for<=? AND state='complete' ORDER BY scheduled_for DESC LIMIT ?",
  )
    .bind(config.source.source_id, Number(window.synthetic), window.from, window.to, limit + 1)
    .all<{ run_id: string }>();
  const snapshots = [];
  for (const run of runs.results.slice(0, limit)) {
    // A blocked historical config or deleted run fails closed; do not silently
    // claim complete coverage after dropping it from the result.
    snapshots.push(await snapshot(env, config, run.run_id, opt));
  }
  return {
    visibility: 'private_only' as const,
    source: {
      source_id: config.source.source_id,
      source_url: config.source.source_url,
      terms_url: config.source.terms_url,
      license_url: config.source.license_url,
      attribution_text: config.source.attribution_text,
      rights_checked_at: config.source.rights_checked_at,
      rights_evidence_ref: config.source.rights_evidence_ref,
    },
    truncated: runs.results.length > limit,
    snapshots,
  };
}
function quoteConditions(record: PublicGpuRecord) {
  // Compare the displayed quote only when every captured condition matches.
  const {
    observed_at,
    evidence_ref,
    policy_version,
    terms_version,
    synthetic,
    amount_decimal,
    missing_reason,
    ...offer
  } = record.offer;
  void observed_at;
  void evidence_ref;
  void policy_version;
  void terms_version;
  void synthetic;
  void amount_decimal;
  void missing_reason;
  return stable({ ...record, offer });
}
export async function comparePublicGpuRuns(
  env: ResearchEnv,
  config: ResearchConfig,
  beforeId: string,
  afterId: string,
  opt: ReadOptions,
) {
  const before = await snapshot(env, config, beforeId, opt),
    after = await snapshot(env, config, afterId, opt);
  if (
    before.series_key !== after.series_key ||
    before.synthetic !== after.synthetic ||
    before.scheduled_for >= after.scheduled_for
  )
    throw new Error('daily_series_mismatch');
  const seen = (rows: typeof before.rows) =>
    new Map(
      rows
        .filter((r) => r.change_kind !== 'not_seen')
        .map((r) => [
          String(r.record_key),
          PublicGpuRecordSchema.parse(JSON.parse(String(r.domain_json))),
        ]),
    );
  const a = seen(before.rows),
    b = seen(after.rows);
  const changes = [...new Set([...a.keys(), ...b.keys()])].sort().map((key) => {
    const old = a.get(key),
      current = b.get(key);
    const state = !current
      ? 'not_seen'
      : !old
        ? 'seen'
        : quoteConditions(old) !== quoteConditions(current)
          ? 'conditions_changed'
          : old.offer.amount_decimal === current.offer.amount_decimal
            ? 'unchanged'
            : 'reported_price_changed';
    const amount = old?.offer.amount_decimal,
      next = current?.offer.amount_decimal;
    const change_percent =
      state === 'reported_price_changed' &&
      amount != null &&
      next != null &&
      !new D(amount).isZero()
        ? new D(next).minus(amount).div(amount).times(100).toFixed()
        : null;
    return {
      record_key: key,
      state,
      change_percent,
      economic_comparison:
        old && current
          ? state === 'conditions_changed'
            ? { state: 'not_comparable', change_percent: null, warning: null }
            : compareDomesticGPU(old.offer, current.offer)
          : null,
    };
  });
  return {
    visibility: 'private_only' as const,
    series_key: before.series_key,
    changes,
    source: {
      source_url: config.source.source_url,
      license_url: config.source.license_url,
      terms_url: config.source.terms_url,
      attribution_text: config.source.attribution_text,
      rights_evidence_ref: config.source.rights_evidence_ref,
    },
  };
}
