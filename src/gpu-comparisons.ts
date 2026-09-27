import type { CollectorEnv, Source } from './schema';
import type { Snapshot } from './gpu-store';
import { type GPUStats, type MetricInput, saveGPUMetric } from './gpu-metrics';
import { stable, hash, D } from './util';
type Conditions = Record<string, unknown>;
const missing = (v: unknown) => v === null || v === undefined || v === 'unknown';
export function compareGPUConditions(
  a: Conditions,
  b: Conditions,
  kind: 'spot_difference' | 'generation_ratio' | 'jp_us',
) {
  const reasons: string[] = [];
  for (const key of [
    'sku',
    'form',
    'count',
    'contract',
    'minimum_term',
    'commitment',
    'minimum_gpu_count',
    'sharing',
    'includes',
    'network',
    'egress',
    'tax',
    'price_scope',
    'country',
    'region',
    'unit',
  ])
    if (missing(a[key]) || missing(b[key])) reasons.push('unknown_' + key);
  if (a.price_scope !== 'public' || b.price_scope !== 'public')
    reasons.push('non_public_price_scope');
  if (a.platform || b.platform || a.sale_unit === 'rack' || b.sale_unit === 'rack')
    reasons.push('system_product_not_comparable');
  const allowed =
    kind === 'spot_difference'
      ? ['contract', 'interruptible']
      : kind === 'generation_ratio'
        ? ['sku', 'model', 'vram']
        : ['country', 'region', 'currency', 'provider', 'tax_jurisdiction'];
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)]))
    if (!allowed.includes(key) && stable(a[key] ?? null) !== stable(b[key] ?? null))
      reasons.push('mismatched_' + key);
  if (
    kind === 'spot_difference' &&
    (![a.contract, b.contract].includes('spot') || ![a.contract, b.contract].includes('on_demand'))
  )
    reasons.push('requires_spot_and_on_demand');
  if (kind === 'generation_ratio' && (a.model === b.model || missing(a.vram) || missing(b.vram)))
    reasons.push('requires_distinct_identified_generations');
  if (
    kind === 'jp_us' &&
    (![a.country, b.country].includes('JP') ||
      ![a.country, b.country].includes('US') ||
      a.tax !== 'excluded' ||
      b.tax !== 'excluded')
  )
    reasons.push('requires_jp_us_tax_excluded');
  return [...new Set(reasons)].sort();
}
export async function buildComparisons(
  env: CollectorEnv,
  s: Source,
  snap: Snapshot,
  current: GPUStats,
  inputs: MetricInput[],
  now: string,
) {
  if (snap.dataset !== 'gpu_rental' || current.sample_count === 0) return;
  // A bounded daily cohort set; no market-wide inference. Both directions deduplicate by input IDs.
  const otherRows = await env.PRIVATE_DB.prepare(
    "SELECT d.value_json FROM derived_observations d WHERE d.dataset='gpu_rental' AND d.observation_id<>? AND json_extract(d.value_json,'$.kind')='cohort_summary' AND substr(d.observed_at,1,10)=? AND d.recorded_at<=? ORDER BY d.observation_id LIMIT 10",
  )
    .bind(current.metric_id, current.observed_at.slice(0, 10), now)
    .all<{ value_json: string }>();
  for (const row of otherRows.results) {
    const other = JSON.parse(row.value_json) as GPUStats;
    if (!other.sample_count) continue;
    const a = current.conditions as Conditions,
      b = other.conditions as Conditions;
    const kind =
      a.country !== b.country &&
      [a.country, b.country].includes('JP') &&
      [a.country, b.country].includes('US')
        ? 'jp_us'
        : a.contract !== b.contract && a.sku === b.sku
          ? 'spot_difference'
          : a.model !== b.model && a.country === b.country
            ? 'generation_ratio'
            : null;
    if (!kind) continue;
    const reasons = compareGPUConditions(a, b, kind),
      id = await hash(
        [current.metric_id, other.metric_id].sort().join('|') + '|' + kind + '|gpu-market-v1',
      );
    const otherInputs = await env.PRIVATE_DB.prepare(
      'SELECT input_snapshot_id AS snapshot_id,input_observation_id AS observation_id,source_id,policy_version FROM gpu_metric_lineage WHERE metric_id=?',
    )
      .bind(other.metric_id)
      .all<MetricInput>();
    const lineage = [...inputs, ...otherInputs.results];
    let value: string | null = null,
      fx: Record<string, unknown> | null = null;
    let numerator = current,
      denominator = other;
    if (kind === 'spot_difference' && a.contract !== 'spot') {
      numerator = other;
      denominator = current;
    }
    if (kind === 'jp_us' && a.country !== 'JP') {
      numerator = other;
      denominator = current;
    }
    if (!reasons.length) {
      if (kind === 'jp_us') {
        if (numerator.conditions.currency !== 'JPY' || denominator.conditions.currency !== 'USD')
          reasons.push('unsupported_currency_pair');
        const cutoff = [current.observed_at, other.observed_at].sort()[0];
        const rates = await env.PRIVATE_DB.prepare(
          "SELECT o.observation_id,o.source_id,o.policy_version,o.observed_at,o.recorded_at,f.quote_currency,f.rate_decimal,f.source_date FROM fx_observations f JOIN observations o USING(observation_id) JOIN sources s ON s.source_id=o.source_id AND s.policy_version=o.policy_version WHERE f.base_currency='EUR' AND f.quote_currency IN ('USD','JPY') AND o.quality_status='accepted' AND o.observed_at<=? AND o.recorded_at<=? AND s.suspended=0 AND s.enabled=1 AND json_extract(s.config_json,'$.policy.rights.internal_analysis')='allowed' AND json_extract(s.config_json,'$.policy.valid_from')<=? AND (json_extract(s.config_json,'$.policy.valid_until') IS NULL OR json_extract(s.config_json,'$.policy.valid_until')>?) AND f.source_date<=? AND f.source_date>=? ORDER BY f.source_date DESC,o.observed_at DESC,o.recorded_at DESC LIMIT 20",
        )
          .bind(
            cutoff,
            cutoff,
            now,
            now,
            cutoff.slice(0, 10),
            new Date(Date.parse(cutoff) - 4 * 86400000).toISOString().slice(0, 10),
          )
          .all<{
            observation_id: string;
            source_id: string;
            policy_version: string;
            observed_at: string;
            recorded_at: string;
            quote_currency: string;
            rate_decimal: string;
            source_date: string;
          }>();
        const usd = rates.results.find((r) => r.quote_currency === 'USD'),
          jpy = usd
            ? rates.results.find(
                (r) =>
                  r.quote_currency === 'JPY' &&
                  r.source_date === usd.source_date &&
                  r.source_id === usd.source_id &&
                  r.policy_version === usd.policy_version,
              )
            : null;
        if (!usd || !jpy) reasons.push('insufficient_fx_history');
        if (!reasons.length && usd && jpy) {
          const rate = new D(jpy.rate_decimal).div(usd.rate_decimal),
            converted = new D(numerator.median as string).div(rate).toFixed();
          fx = {
            original_amount: numerator.median,
            original_currency: 'JPY',
            converted_amount: converted,
            converted_currency: 'USD',
            usd_jpy_rate: rate.toFixed(),
            source_date: usd.source_date,
            fx_age_days: Math.floor(
              (Date.parse(cutoff.slice(0, 10)) - Date.parse(usd.source_date)) / 86400000,
            ),
            fx_carried_forward: usd.source_date < cutoff.slice(0, 10),
            fx_observation_ids: [usd.observation_id, jpy.observation_id],
            methodology: 'ecb-eur-cross-v1',
            cutoff,
          };
          lineage.push(
            ...[usd, jpy].map((r) => ({
              snapshot_id: null,
              observation_id: r.observation_id,
              source_id: r.source_id,
              policy_version: r.policy_version,
            })),
          );
          value = new D(denominator.median as string).gt(0)
            ? new D(converted).div(denominator.median as string).toFixed()
            : null;
        }
      } else
        value = new D(denominator.median as string).gt(0)
          ? new D(numerator.median as string).div(denominator.median as string).toFixed()
          : null;
      if (value === null && !reasons.length) reasons.push('zero_denominator');
    }
    await saveGPUMetric(
      env,
      s,
      snap,
      {
        ...current,
        metric_id: id,
        kind,
        cohort_key: id,
        status: reasons.length ? 'incomparable' : 'ok',
        ratio: value,
        numerator_metric_id: numerator.metric_id,
        denominator_metric_id: denominator.metric_id,
        numerator_conditions: numerator.conditions,
        denominator_conditions: denominator.conditions,
        comparison_exclusions: reasons,
        fx_conversion: fx,
        sample_count: Math.min(current.sample_count, other.sample_count),
        sample_counts: [current.sample_count, other.sample_count],
        scope: 'two_observed_cohorts_only',
        performance_adjusted: false,
        ratio_meaning:
          kind === 'spot_difference'
            ? 'spot_median_divided_by_on_demand_median'
            : kind === 'jp_us'
              ? 'jp_median_in_usd_divided_by_us_median'
              : 'quoted_generation_median_ratio',
      },
      lineage,
      now,
    );
  }
}
