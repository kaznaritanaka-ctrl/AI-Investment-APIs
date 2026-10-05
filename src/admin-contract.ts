// Versioned, allowlisted Admin DTOs. Keep the identical copy in AI-Investment-Admin.
import { z } from 'zod';

export const AdminResource = z.enum([
  'overview',
  'sources',
  'runs',
  'data',
  'rights',
  'settings',
  'releases',
]);
export const AdminQuery = z
  .object({
    source: z
      .string()
      .regex(/^[a-z0-9_-]{1,80}$/)
      .optional(),
    dataset: z
      .enum([
        'fx',
        'ai_api_prices',
        'ai_model_catalog',
        'gpu_rental',
        'gpu_secondary',
        'electricity',
      ])
      .optional(),
    from: z.iso.datetime().optional(),
    to: z.iso.datetime().optional(),
    as_of: z.iso.datetime().optional(),
    run: z.string().max(160).optional(),
    id: z.string().max(200).optional(),
    entity: z.string().max(300).optional(),
    snapshot: z.string().max(200).optional(),
    state: z
      .string()
      .regex(/^[a-z_]{1,50}$/)
      .optional(),
    view: z.enum(['latest', 'history', 'quality', 'changes']).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().max(2048).optional(),
  })
  .strict();
export type Query = z.infer<typeof AdminQuery>;
export type Resource = z.infer<typeof AdminResource>;
const text = z.string().max(2000);
const time = z.iso.datetime().nullable();
const count = z.number().int().nonnegative().nullable();
export const Field = z
  .object({
    name: text,
    value: z.union([text, z.number().finite(), z.boolean(), z.null()]),
    unit: text.nullable().default(null),
  })
  .strict();
export const Publication = z
  .object({
    state: z.enum(['complete', 'staging', 'held', 'not_published', 'unavailable']),
    original_count: count,
    derived_count: count,
    visible_count: count,
    completed_at: time,
  })
  .strict();
export const Invocation = z
  .object({
    id: text,
    kind: z.enum(['collection', 'watchdog', 'continuation', 'unknown']),
    scheduled_at: time,
    recorded_at: time,
    state: text,
    reason: text.nullable(),
    notification: z.enum([
      'sent',
      'pending',
      'attempts_exhausted',
      'not_configured',
      'not_queued',
      'unknown',
    ]),
    attempts: count,
    sent_at: time,
  })
  .strict();
// Operational metadata only. Never include evidence paths, payloads or arbitrary errors.
export const RunRecovery = z
  .object({
    state: z.enum(['recorded', 'not_reported', 'unavailable_at_as_of']),
    detected_at: time,
    classification: z
      .enum([
        'authentication',
        'rate_limit',
        'transport',
        'response_contract',
        'storage_or_publication',
        'schema_drift',
        'unclassified',
      ])
      .nullable(),
    stage: z
      .enum(['http', 'body', 'projection', 'parser', 'private_store', 'publication'])
      .nullable(),
    schema_drift: z.boolean().nullable(),
    diagnostic_codes: z
      .array(
        z.enum([
          'json_shape',
          'wrapper_changed',
          'pagination_contract',
          'semantics_changed',
          'field_type_or_enum',
          'field_type',
          'unknown_pricing_field',
          'pricing_basis_changed',
          'record_scope_changed',
          'required_field_missing',
          'identifier_or_shape_changed',
          'identifier_changed',
          'contract_failure',
        ]),
      )
      .max(64),
    evidence_state: z.enum([
      'preserved',
      'partial',
      'metadata_only',
      'not_captured',
      'unavailable',
      'expired',
      'not_reported',
    ]),
    evidence_hash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    evidence_expires_at: time,
    recovery_result: z.enum([
      'completed_after_failure',
      'not_needed',
      'in_progress',
      'not_completed',
    ]),
    // No external agent receipts have been imported. Do not infer agent activity.
    agent_status: z.literal('not_reported'),
    repair_patch: z.literal('not_reported'),
    regression_result: z.literal('not_reported'),
    reparse_result: z.literal('not_reported'),
    missing_observation: z.boolean().nullable(),
    missing_observation_count: count,
    missing_observation_scope: z.literal('current_run_only'),
    remaining_human_action: z.enum([
      'none',
      'none_yet',
      'review_operational_alerts',
      'confirm_source_semantics',
      'review_repair_candidate',
      'evidence_unavailable_do_not_backfill',
      'restore_read_access',
      'investigate_collection_or_publication',
      'review_historical_state',
    ]),
    briefing: text,
  })
  .strict();
export const Run = z
  .object({
    run_id: text,
    canonical_run_id: text,
    source_id: text,
    logical_slot: time,
    scheduled_for: time,
    state: text,
    started_at: time,
    finished_at: time,
    last_progress_at: time,
    observation_count: count,
    accepted_count: count,
    quarantined_count: count,
    error_code: text.nullable(),
    recovery_count: count,
    next_attempt_at: time,
    recovery: RunRecovery.optional(),
    publication: Publication,
    checkpoints: z
      .array(
        z
          .object({
            id: text,
            kind: text,
            state: text,
            stage: text.nullable(),
            observed_at: time,
            completed_at: time,
            counts: z.array(Field).max(20),
          })
          .strict(),
      )
      .max(20),
    attempts: z
      .array(
        z
          .object({
            attempt: z.number(),
            started_at: time,
            status: count,
            code: text,
            duration_ms: count,
          })
          .strict(),
      )
      .max(100),
    invocations: z.array(Invocation).max(100),
    details_truncated: z.boolean(),
  })
  .strict();
export const SourceStatus = z
  .object({
    source_id: text,
    name: text,
    dataset: text,
    adapter_available: z.boolean(),
    enabled: z.boolean(),
    registered: z.boolean(),
    suspended: z.boolean().nullable(),
    collection_allowed: z.boolean(),
    publication_allowed: z.boolean(),
    blockers: z.array(text).max(30),
    latest_observed_at: time,
    source_date: text.nullable(),
    freshness: z.enum(['healthy', 'stale', 'unavailable', 'not_applicable']),
    freshness_reason: text.nullable(),
    last_run: Run.nullable(),
    source_url: text.nullable(),
    attribution: text,
    coverage: z.array(text).max(100),
    limitations: z.array(text).max(100),
    policy_valid_until: time.optional(),
    publication_blockers: z.array(text).max(20).optional(),
    notification_problem: z.enum(['pending', 'attempts_exhausted']).nullable().optional(),
  })
  .strict();
export const AttentionItem = z
  .object({
    id: text,
    severity: z.enum(['error', 'warning', 'unknown']),
    message: text,
    page: AdminResource,
    source: text.nullable(),
    run: text.nullable(),
  })
  .strict();
export const Overview = z
  .object({
    logical_slot: time,
    expected: count,
    completed: count,
    published: count,
    fresh: count,
    checked_sources: count,
    attention: z.array(AttentionItem).max(300),
    sources: z.array(SourceStatus).max(100),
  })
  .strict();
export const DataRow = z
  .object({
    observation_id: text,
    source_id: text,
    dataset: text,
    entity_key: text,
    run_id: text,
    snapshot_id: text.nullable(),
    observed_at: time,
    recorded_at: time,
    source_period: text.nullable(),
    quality: text,
    data_origin: text,
    policy_version: text,
    supersedes_id: text.nullable(),
    retention_until: time,
    private_readable: z.boolean(),
    private_blocker: text.nullable(),
    fields: z.array(Field).max(512),
    public_fields: z.array(Field).max(512),
    previous_fields: z.array(Field).max(512),
    publication: Publication,
    issues: z.array(text).max(100),
    attribution: text,
    source_url: text.nullable(),
    conditions: z.array(text).max(100),
    license_notice: z.string().max(20000).nullable(),
    related_ids: z.array(text).max(100),
    derived: z.boolean(),
  })
  .strict();
export const PolicyRow = z
  .object({
    source_id: text,
    version: text,
    current: z.boolean(),
    runtime_matches: z.boolean(),
    recorded_at: time,
    rights: z.record(z.string(), z.enum(['allowed', 'denied', 'review_required', 'expired'])),
    valid_from: time,
    valid_until: time,
    days_remaining: z.number().int().nullable(),
    expiry: z.enum(['expired', 'seven_days', 'thirty_days', 'valid', 'no_deadline']),
    collection_allowed: z.boolean(),
    publication_allowed: z.boolean(),
    blockers: z.array(text).max(30),
    fields: z.array(text).max(100),
    conditions: z.array(text).max(100),
    evidence_refs: z.array(text).max(100),
    checked_at: time,
    retention: z.array(Field).max(10),
    license_url: text.nullable(),
    attribution: text,
    license_notice: z.string().max(20000).nullable(),
  })
  .strict();
export const SettingRow = z
  .object({
    source_id: text.nullable(),
    name: text,
    runtime: z.array(Field).max(120),
    stored: z.array(Field).max(120),
    matches: z.boolean().nullable(),
    blockers: z.array(text).max(30),
  })
  .strict();
export const ReleaseRecord = z
  .object({
    record_id: z.string().regex(/^[a-zA-Z0-9._-]{1,120}$/),
    worker: z.enum(['ai-investment-admin', 'ai-investment-api', 'ai-investment-collector']),
    version_id: z.uuid(),
    git_sha: z.string().regex(/^[a-f0-9]{40}$/),
    tree_sha: z.string().regex(/^[a-f0-9]{40}$/),
    artifact_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    event: z.enum(['uploaded', 'activated', 'verified', 'rollback']),
    recorded_at: z.iso.datetime(),
    traffic_percent: z.number().min(0).max(100).nullable(),
    evidence_ref: z.string().regex(/^[a-zA-Z0-9_./:-]{1,400}$/),
    evidence_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    checks: z.record(z.string().regex(/^[a-z_]{1,40}$/), z.enum(['passed', 'failed', 'not_run'])),
    migration_names: z.array(z.string().regex(/^\d{4}_[a-z0-9_]+\.sql$/)).max(40),
    github_url: z
      .url()
      .refine((v) =>
        /^https:\/\/github\.com\/kaznaritanaka-ctrl\/AI-Investment-(Admin|APIs)\/(commit\/[a-f0-9]{40}|pull\/[0-9]+)$/.test(
          v,
        ),
      )
      .nullable(),
  })
  .strict();
export const ReleaseData = z
  .object({
    records: z.array(ReleaseRecord).max(100),
    migrations: z
      .array(
        z
          .object({
            database: z.enum(['private', 'public']),
            name: text,
            applied_at: text.nullable(),
          })
          .strict(),
      )
      .max(100),
    ledger_available: z.boolean(),
  })
  .strict();
export const AdminReport = z
  .object({
    schema_version: z.literal('admin-read-v1'),
    resource: AdminResource,
    fetched_at: z.iso.datetime(),
    as_of: z.iso.datetime(),
    state: z.enum(['ready', 'partial', 'unavailable', 'not_supported']),
    issues: z.array(text).max(100),
    next_cursor: text.nullable(),
    overview: Overview.optional(),
    sources: z.array(SourceStatus).max(100).optional(),
    runs: z.array(Run).max(100).optional(),
    data: z.array(DataRow).max(100).optional(),
    datasets: z
      .array(
        z
          .object({
            dataset: text,
            visible_count: count,
            latest_observed_at: time,
          })
          .strict(),
      )
      .max(20)
      .optional(),
    policies: z.array(PolicyRow).max(300).optional(),
    settings: z.array(SettingRow).max(100).optional(),
    releases: ReleaseData.optional(),
  })
  .strict();
export type Report = z.infer<typeof AdminReport>;
export type RunDTO = z.infer<typeof Run>;
export type RunRecoveryDTO = z.infer<typeof RunRecovery>;
export type SourceDTO = z.infer<typeof SourceStatus>;
export type DataDTO = z.infer<typeof DataRow>;
export type PolicyDTO = z.infer<typeof PolicyRow>;
export type FieldDTO = z.infer<typeof Field>;
export type ReleaseDTO = z.infer<typeof ReleaseRecord>;
