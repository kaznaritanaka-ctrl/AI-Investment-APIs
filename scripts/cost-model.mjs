const n = (key, def) => {
  const i = process.argv.indexOf('--' + key);
  const v = i < 0 ? def : Number(process.argv[i + 1]);
  if (!Number.isFinite(v) || v < 0) throw new Error('Invalid ' + key);
  return v;
};
const gpu = process.argv.includes('--gpu');
const entities = n('entities', gpu ? 1000 : 4),
  runs = n('runs-per-day', 1),
  days = n('days', 365),
  bytes = n('bytes-per-observation', 3000),
  indexFactor = n('index-factor', 2.5),
  evidenceBytes = n('evidence-bytes-per-day', 6000),
  rawDays = n('raw-days', 365),
  archiveBytes = n('archive-bytes-per-day', 12000),
  archiveDays = n('archive-days', 365),
  sources = n('sources', 2),
  attempts = n('average-attempts', 1),
  apiRequests = n('api-requests-per-day', 1000),
  scanRows = n('rows-per-api-request', 50);
const pageSize = n('page-size', 50),
  cohorts = n('cohorts', gpu ? 10 : 0),
  pages = gpu ? Math.ceil(entities / pageSize) : sources;
const observations = entities * runs * days,
  r2GB = (evidenceBytes * rawDays + archiveBytes * archiveDays) / 1e9;
console.log(
  JSON.stringify(
    {
      estimate_only: true,
      scenario: gpu ? 'gpu_daily_observations' : 'phase1_fx_ai',
      pages_per_day: pages,
      estimated_resume_invocations: gpu ? pages + cohorts : 0,
      configured_resume_capacity: gpu ? 72 : null,
      capture_budget_warning:
        gpu && pages + cohorts > 72 ? 'partial_expected_at_default_capture_budget' : null,
      currency: 'USD',
      assumptions: {
        entities,
        runs,
        days,
        bytes,
        indexFactor,
        evidenceBytes,
        rawDays,
        archiveBytes,
        archiveDays,
        sources,
        attempts,
        apiRequests,
        scanRows,
      },
      observations,
      db_GB: (observations * bytes * indexFactor) / 1e9,
      r2_GB: r2GB,
      r2_standard_storage_monthly_before_free_allocation: r2GB * 0.015,
      source_http_requests_per_day: pages * runs * attempts,
      approx_d1_rows_written_per_day: entities * runs * (gpu ? 20 : 10) + pages * runs * 30,
      api_rows_read_per_day: apiRequests * scanRows,
      approximate_r2_class_A_per_month: pages * runs * 2 * 30,
      approximate_r2_class_B_per_month: pages * runs * 2 * 30,
      workers_plan_assumed: null,
      cloud_workers_cpu_measured: false,
      llm_calls: 0,
      llm_tokens: 0,
      excluded: [
        'Workers subscription / CPU',
        'Existing account usage',
        'Index write billing',
        'Webhook charges',
        'Billing-unit rounding',
      ],
      guaranteed_spend_cap: false,
    },
    null,
    2,
  ),
);
