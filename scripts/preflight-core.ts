export type Config = Record<string, any>;
export function inspectPreflight(
  deployment: Config,
  collector: Config,
  api: Config,
  sources: Config[],
  environment: Record<string, string | undefined> = {},
) {
  const errors: string[] = [],
    blockers: string[] = [],
    pending: string[] = [];
  const require = (v: unknown, code: string) => {
    if (!v) blockers.push(code);
  };
  const id = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{32}$/i.test(v) && !/^0+$/.test(v);
  const dbid = (v: unknown) =>
    typeof v === 'string' && /^[a-f0-9-]{36}$/i.test(v) && !/^00000000-/.test(v);
  if (
    api.d1_databases?.length !== 1 ||
    api.d1_databases[0].binding !== 'PUBLIC_DB' ||
    api.r2_buckets?.length ||
    api.services?.length ||
    api.secrets_store_secrets?.length ||
    api.triggers?.crons?.length
  )
    errors.push('public_worker_private_binding_or_trigger');
  if (Object.keys(api.vars ?? {}).some((k) => /SECRET|TOKEN|KEY|ACCOUNT|PRIVATE|EVIDENCE/.test(k)))
    errors.push('public_worker_secret_variable');
  if ([api, collector].some((c) => c.workers_dev !== false || c.preview_urls !== false))
    errors.push('unexpected_public_preview');
  if (collector.routes?.length) errors.push('collector_must_have_no_routes');
  if (deployment.deployment_controller !== 'manual_wrangler')
    errors.push('unsupported_deployment_controller');
  const expected = [
    collector.vars.COLLECTION_CRON,
    collector.vars.WATCHDOG_CRON,
    collector.vars.GPU_RESUME_CRON,
  ];
  if (expected.some((v) => typeof v !== 'string') || new Set(expected).size !== 3)
    errors.push('invalid_schedule_configuration');
  const crons = collector.triggers?.crons;
  if (['bootstrap', 'published'].includes(deployment.stage)) {
    if (!Array.isArray(crons) || crons.length || collector.vars.COLLECTION_ENABLED !== 'false')
      errors.push('bootstrap_cron_not_stopped');
    if (deployment.stage === 'bootstrap' && api.routes?.length)
      errors.push('bootstrap_public_route_present');
  } else if (deployment.stage === 'enabled') {
    if (
      JSON.stringify([...(crons ?? [])].sort()) !== JSON.stringify([...expected].sort()) ||
      collector.vars.COLLECTION_ENABLED !== 'true'
    )
      errors.push('enabled_schedule_mismatch');
    require(deployment.cron_enable_approval_ref, 'cron_owner_approval_missing');
  } else errors.push('invalid_deployment_stage');
  require(id(deployment.account_id), 'account_id_unconfigured');
  if (
    environment.CLOUDFLARE_ACCOUNT_ID &&
    environment.CLOUDFLARE_ACCOUNT_ID !== deployment.account_id
  )
    errors.push('environment_target_account_mismatch');
  for (const c of [collector, api])
    if (c.account_id && c.account_id !== deployment.account_id)
      errors.push('wrangler_target_account_mismatch');
  require(collector.account_id === deployment.account_id &&
    api.account_id === deployment.account_id &&
    id(deployment.account_id), 'wrangler_account_not_pinned');
  require(id(deployment.zone_id), 'zone_id_unconfigured');
  require(typeof deployment.owned_domain === 'string' &&
    /^(?!.*(?:example|placeholder|localhost))([a-z0-9-]+\.)+[a-z]{2,}$/i.test(
      deployment.owned_domain,
    ), 'owned_domain_unconfigured');
  if (
    ['published', 'enabled'].includes(deployment.stage) &&
    JSON.stringify(api.routes) !==
      JSON.stringify([{ pattern: 'api.' + deployment.owned_domain, custom_domain: true }])
  )
    errors.push('api_owned_custom_domain_mismatch');
  require(['free', 'paid'].includes(deployment.workers_plan) &&
    deployment.workers_plan_evidence_ref, 'workers_plan_unconfirmed');
  require([7, 30].includes(deployment.d1_time_travel_days), 'd1_backup_retention_unconfirmed');
  const privateDB = collector.d1_databases?.find((x: Config) => x.binding === 'PRIVATE_DB'),
    publicDB = collector.d1_databases?.find((x: Config) => x.binding === 'PUBLIC_DB');
  if (!privateDB || !publicDB || collector.d1_databases.length !== 2)
    errors.push('collector_db_bindings_invalid');
  require(dbid(privateDB?.database_id) && dbid(publicDB?.database_id), 'd1_ids_placeholder');
  if (privateDB?.database_id === publicDB?.database_id) errors.push('private_public_database_same');
  if (publicDB?.database_id !== api.d1_databases?.[0]?.database_id)
    errors.push('public_db_binding_mismatch');
  require(deployment.retention_review_ref, 'source_retention_review_missing');
  if (['published', 'enabled'].includes(deployment.stage))
    require(deployment.public_approval_ref, 'public_domain_approval_missing');
  require(deployment.deployment_approval_ref, 'production_deployment_approval_missing');
  if (!deployment.notification_destination_configured)
    pending.push('notification_destination_not_configured');
  if (!deployment.external_monitor_evidence_ref) pending.push('external_monitor_not_connected');
  for (const s of sources) {
    if (!s.enabled) {
      pending.push(s.source_id + ':disabled');
      continue;
    }
    for (const right of ['automated_collection', 'private_storage', 'internal_analysis'])
      if (s.policy.rights[right] !== 'allowed')
        errors.push(s.source_id + ':rights_not_allowed:' + right);
    if (s.gpu) {
      require(deployment.workers_plan === 'paid', s.source_id +
        ':gpu_d1_query_budget_requires_confirmed_paid_plan');
      if (s.gpu.page_size > 50 || s.max_records > 50 || s.gpu.pages_per_invocation !== 1)
        errors.push(s.source_id + ':gpu_invocation_budget_exceeded');
      require(s.policy.fields.includes('gpu_projection_v1'), s.source_id +
        ':projection_fields_not_approved');
      require(s.gpu.owner_approval_ref, s.source_id + ':owner_approval_missing');
      require(s.gpu.retention.reviewed_ref, s.source_id + ':retention_unreviewed');
      for (const [key, value] of Object.entries(s.gpu.retention))
        if (key.endsWith('_days'))
          require(Number.isInteger(value) && Number(value) > 0, s.source_id +
            ':' +
            key +
            '_missing');
      require(s.gpu.retention.backup_days >= deployment.d1_time_travel_days, s.source_id +
        ':d1_backup_exceeds_grant');
      if (s.policy.retention_limit_days)
        require(s.gpu.retention.normalized_days + s.gpu.retention.backup_days <=
          s.policy.retention_limit_days, s.source_id + ':total_retention_exceeds_grant');
    }
    if (s.models) {
      const m = s.models,
        grant = s.policy.models_scope;
      require(deployment.workers_plan === 'paid', s.source_id +
        ':models_parse_and_d1_budget_requires_confirmed_paid_plan');
      require(m.owner_approval_ref, s.source_id + ':models_owner_approval_missing');
      require(m.runtime_review_ref, s.source_id + ':models_runtime_unreviewed');
      require(m.retention.reviewed_ref, s.source_id + ':models_retention_unreviewed');
      require(grant &&
        m.providers.every((p: string) => grant.providers.includes(p)) &&
        m.fields.every((f: string) => grant.fields.includes(f)), s.source_id +
        ':models_scope_not_approved');
      require(s.policy.fields.includes('models_projection_v2'), s.source_id +
        ':models_projection_not_approved');
      require(m.retention.backup_days >= deployment.d1_time_travel_days, s.source_id +
        ':models_backup_exceeds_grant');
      if (m.models_per_invocation > 25 || m.max_components > 64)
        errors.push(s.source_id + ':models_invocation_budget_exceeded');
      // Intake + ingest + worst-case disappearance + finalize + steady-state retention.
      const slots =
        2 +
        Math.ceil(m.max_models / m.models_per_invocation) +
        Math.ceil(m.max_models / 50) +
        Math.ceil(m.max_models / 25) +
        2;
      require(slots <= 72, s.source_id +
        ':models_daily_capacity_exceeds_existing_72_continuations');
      const gpu = sources.filter((x) => x.enabled && x.gpu);
      const isolatedPrivatePoC =
        deployment.collection_workload_mode === 'models_then_private_poc_v1' &&
        deployment.shared_collection_budget_review_ref &&
        gpu.length === 1 &&
        gpu[0].source_id === 'price_of_compute' &&
        gpu[0].adapter === 'price_of_compute' &&
        gpu[0].max_records <= 50 &&
        gpu[0].max_bytes <= 1000000 &&
        gpu[0].gpu.max_pages === 1 &&
        gpu[0].gpu.pages_per_invocation === 1 &&
        gpu[0].gpu.partitions.length === 1 &&
        gpu[0].gpu.partitions[0].id === 'h100-sxm' &&
        gpu[0].gpu.partitions[0].query.sku === 'h100-sxm' &&
        gpu[0].gpu.snapshot_max_age_minutes === 360 &&
        collector.vars.COLLECTION_CRON === '17 18 * * *' &&
        collector.vars.GPU_RESUME_CRON === '*/5 18-23 * * *' &&
        [
          'public_display',
          'normalized_redistribution',
          'derived_redistribution',
          'commercial_redistribution',
        ].every((key) => ['denied', 'review_required'].includes(gpu[0].policy.rights[key]));
      require(!gpu.length || isolatedPrivatePoC, s.source_id +
        ':shared_gpu_models_budget_requires_separate_review');
      if (gpu.length && isolatedPrivatePoC)
        // 68 continuation slots follow 18:17 UTC before the existing window ends.
        require(slots + 6 <= 68, s.source_id +
          ':combined_daily_capacity_exceeds_existing_68_continuations');
      if (s.policy.retention_limit_days)
        require(Math.max(
          m.retention.evidence_days,
          m.retention.archive_days,
          m.retention.normalized_days + m.retention.backup_days,
        ) <= s.policy.retention_limit_days, s.source_id + ':models_retention_exceeds_grant');
    }
  }
  return {
    mode: 'offline',
    static_valid: errors.length === 0,
    ready: errors.length === 0 && blockers.length === 0,
    errors: [...new Set(errors)],
    blockers: [...new Set(blockers)],
    pending,
    network_performed: false,
    resources_created: false,
    deployed: false,
    cron_enabled: false,
  };
}
