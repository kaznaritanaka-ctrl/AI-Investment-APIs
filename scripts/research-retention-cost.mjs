// Offline planning model, not a bill, measured capacity, permission, or source observation.
// Rates checked 2026-10-16: developers.cloudflare.com/{d1/platform,r2}/pricing/.
const assumptions = {
  sources: 2,
  rows_per_source_day: 50,
  d1_bytes_per_row_including_index_estimate: 2048,
  d1_metadata_bytes_per_run_estimate: 2048,
  r2_history_bytes_per_row_estimate: 1024,
  hot_days_hypothetical_r2_design: 90,
  d1_usd_per_gb_month_above_allowance: 0.75,
  r2_standard_usd_per_gb_month_above_allowance: 0.015,
  gb_bytes: 1e9,
};
const n = assumptions,
  perDay = n.sources * n.rows_per_source_day;
function estimate(years) {
  const days = years * 365;
  let d1 = 0,
    hybridD1 = 0,
    hybridR2 = 0,
    d1Cost = 0,
    hybridD1Cost = 0,
    hybridR2Cost = 0;
  for (let day = 1; day <= days; day++) {
    const meta = n.sources * day * n.d1_metadata_bytes_per_run_estimate;
    d1 = perDay * day * n.d1_bytes_per_row_including_index_estimate + meta;
    hybridD1 =
      perDay *
        Math.min(day, n.hot_days_hypothetical_r2_design) *
        n.d1_bytes_per_row_including_index_estimate +
      meta;
    hybridR2 =
      perDay *
      Math.max(0, day - n.hot_days_hypothetical_r2_design) *
      n.r2_history_bytes_per_row_estimate;
    // 365 days = 12 months for this planning approximation, no free-tier deduction.
    d1Cost += ((d1 / n.gb_bytes) * n.d1_usd_per_gb_month_above_allowance * 12) / 365;
    hybridD1Cost += ((hybridD1 / n.gb_bytes) * n.d1_usd_per_gb_month_above_allowance * 12) / 365;
    hybridR2Cost +=
      ((hybridR2 / n.gb_bytes) * n.r2_standard_usd_per_gb_month_above_allowance * 12) / 365;
  }
  return {
    years,
    days,
    observation_rows: days * perDay,
    runs: days * n.sources,
    d1_all_mb: d1 / 1e6,
    d1_all_storage_usd_gross_unrounded_cumulative: d1Cost,
    d1_all_storage_usd_gross_end_year_annualized: (d1 / n.gb_bytes) * 0.75 * 12,
    hypothetical_hybrid_d1_mb: hybridD1 / 1e6,
    hypothetical_hybrid_r2_mb: hybridR2 / 1e6,
    hypothetical_hybrid_storage_usd_gross_unrounded_cumulative: hybridD1Cost + hybridR2Cost,
    hypothetical_hybrid_storage_usd_gross_end_year_annualized:
      ((hybridD1 / n.gb_bytes) * 0.75 + (hybridR2 / n.gb_bytes) * 0.015) * 12,
    hypothetical_archive_objects: Math.max(0, days - 90) * n.sources,
  };
}
console.log(
  JSON.stringify(
    {
      status: 'planning_only_live_0',
      assumptions,
      exclusions: [
        'provider/feed fees unknown',
        'existing account usage unknown',
        'Workers base/CPU',
        'query and index writes',
        'shared evidence/control objects',
        'R2 billing-unit rounding',
      ],
      scenarios: [estimate(3), estimate(5)],
    },
    null,
    2,
  ),
);
