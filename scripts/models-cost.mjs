import { readFileSync, writeFileSync } from 'node:fs';
const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const runtime = read('work/runtime-models-report.json'),
  profiles = read('work/models-benchmark-report.json');
const scenarios = [];
// Local baseline footprints include SQLite indexes. Additional component size and 30-day costs are estimates.
for (const n of [50, 250, 1000])
  for (const components of [3, 64]) {
    const measured = runtime.measurements.find((x) => x.models === n);
    const parse = profiles.measurements.find(
      (x) => x.models === n && x.unselected_padding_bytes === 0,
    );
    const extraComponentBytes = n * (components - 3) * 300,
      extraIndexFactor = 1.5;
    const privateDaily =
      measured.database_growth_bytes.private + extraComponentBytes * extraIndexFactor;
    const publicDaily =
      measured.database_growth_bytes.public + extraComponentBytes * extraIndexFactor;
    const evidenceDaily = parse.projection_bytes + extraComponentBytes;
    const archiveDaily = privateDaily; // Uncompressed full observations/events; conservative local footprint proxy.
    const r2GB = (evidenceDaily * 90 + archiveDaily * 365) / 1e9;
    const writesDay = measured.rows_written_with_metadata * 2; // Include steady-state deletion allowance.
    const readRowsMonth = measured.rows_read_with_metadata * 30 * 2;
    const r2A = measured.r2_put * 30,
      r2B = measured.r2_get * 30;
    const invocations = 2 + Math.ceil(n / 25) + Math.ceil(n / 50) + Math.ceil(n / 25) + 2;
    for (const days of [30, 365, 1095]) {
      const privateGB = (privateDaily * days) / 1e9,
        publicGB = (publicDaily * days) / 1e9,
        dbGB = privateGB + publicGB;
      const storageMonth = dbGB * 0.75 + r2GB * 0.015;
      const operationsMonth =
        (writesDay * 30) / 1e6 +
        (readRowsMonth / 1e6) * 0.001 +
        (r2A / 1e6) * 4.5 +
        (r2B / 1e6) * 0.36;
      scenarios.push({
        models: n,
        components_per_model: components,
        history_days: days,
        model_observations: n * days,
        price_observations: n * days,
        domain_rows: 2 * n * days,
        price_components_in_typed_JSON: n * components * days,
        public_observation_copies: 2 * n * days,
        baseline_events_assumed: n * days,
        private_GB: privateGB,
        public_GB: publicGB,
        r2_steady_state_GB: r2GB,
        private_exceeds_paid_10GB: privateGB > 10,
        public_exceeds_paid_10GB: publicGB > 10,
        monthly_new_db_GB: ((privateDaily + publicDaily) * 30) / 1e9,
        annual_new_db_GB: ((privateDaily + publicDaily) * 365) / 1e9,
        required_daily_slots_with_retention_and_full_turnover: invocations,
        existing_slots: 72,
        capacity_ok: invocations <= 72,
        estimated_D1_written_rows_month: writesDay * 30,
        estimated_D1_read_rows_month: readRowsMonth,
        R2_class_A_month: r2A,
        R2_class_B_month: r2B,
        monthly_USD_before_shared_allowances_and_rounding: 5 + storageMonth + operationsMonth,
        annual_USD_at_this_steady_state_before_shared_allowances_and_rounding:
          12 * (5 + storageMonth + operationsMonth),
        monthly_USD_with_other_account_usage_zero:
          5 +
          Math.max(0, dbGB - 5) * 0.75 +
          Math.max(0, r2GB - 10) * 0.015 +
          Math.max(0, writesDay * 30 - 50e6) / 1e6 +
          (Math.max(0, readRowsMonth - 25e9) / 1e6) * 0.001 +
          (Math.max(0, r2A - 1e6) / 1e6) * 4.5 +
          (Math.max(0, r2B - 10e6) / 1e6) * 0.36,
      });
    }
  }
const report = {
  estimate_only: true,
  price_review_date: '2026-09-30 JST',
  currency: 'USD',
  assumptions: {
    daily_snapshots: 1,
    evidence_days: 90,
    archive_days: 365,
    normalized_days_proposal: 1095,
    backup_days_proposal: 30,
    components_store: 'Typed JSON in one ai_api_prices domain row; no per-component SQL row',
    extra_component_bytes_assumed: 300,
    extra_component_index_overhead_factor: 1.5,
    measured_baseline_includes_indexes: true,
    worker_subscription_month: 5,
    cloud_cpu_measured: false,
    source_HTTP_success_per_day: 1,
    finite_fetch_attempts: 3,
    retry_and_schema_change_reserve: 'Not priced; requires headroom and monitoring',
    daily_manual_work: 0,
    LLM_calls: 0,
  },
  sources: [
    'https://developers.cloudflare.com/workers/platform/pricing/',
    'https://developers.cloudflare.com/d1/platform/pricing/',
    'https://developers.cloudflare.com/d1/platform/limits/',
    'https://developers.cloudflare.com/r2/pricing/',
  ],
  excluded: [
    'Public API traffic and its D1 reads',
    'Cloudflare billed CPU',
    'Existing account usage',
    'Additional metadata/price change events beyond one event/model/day',
    'Billing-unit rounding and tax',
    'Daily growing query scans and backup physical storage',
  ],
  notes: [
    'Annual amount is 12x the stated end-state month, not a simulated first-year invoice.',
    'D1 reads/writes use a synthetic one-day baseline times two, not a guarantee for a 3-year database.',
    'No plan purchase or production capacity measurement has occurred.',
  ],
  scenarios,
};
writeFileSync('work/models-cost-report.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
