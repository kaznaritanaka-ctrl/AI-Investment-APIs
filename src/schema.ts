import { z } from 'zod';
import { ModelScopeSchema, ModelsConfigSchema, type ModelCatalog } from './models-schema';
import type { GPURental, GPUSecondary } from './gpu';

export const Rights = z.enum(['allowed', 'denied', 'review_required', 'expired']);
export const rightsKeys = [
  'automated_collection',
  'private_storage',
  'internal_analysis',
  'external_llm_processing',
  'public_display',
  'raw_redistribution',
  'normalized_redistribution',
  'derived_redistribution',
  'commercial_redistribution',
] as const;
const rightsShape = Object.fromEntries(rightsKeys.map((k) => [k, Rights])) as Record<
  (typeof rightsKeys)[number],
  typeof Rights
>;
export const PolicySchema = z
  .object({
    version: z.string().min(1),
    rights: z.object(rightsShape).strict(),
    fields: z.array(z.string()).min(1),
    conditions: z.array(z.string()),
    valid_from: z.iso.datetime(),
    valid_until: z.iso.datetime().nullable(),
    retention_days: z.number().int().positive().max(3650),
    retention_limit_days: z.number().int().positive().nullable(),
    decision_actor: z.string(),
    evidence_version: z.string(),
    evidence_refs: z.array(z.string()).min(1),
    models_scope: ModelScopeSchema.optional(),
  })
  .strict();

export const GPUConfigSchema = z
  .object({
    owner_approval_ref: z.string().nullable(),
    partitions: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-z0-9_-]+$/),
            query: z.record(z.string(), z.string()),
            models: z.array(z.string()),
          })
          .strict(),
      )
      .max(16),
    page_size: z.number().int().min(1).max(100),
    max_pages: z.number().int().min(1).max(200),
    pages_per_invocation: z.number().int().min(1).max(4),
    snapshot_max_age_minutes: z.number().int().min(1).max(360),
    retention: z
      .object({
        evidence_days: z.number().int().positive().nullable(),
        archive_days: z.number().int().positive().nullable(),
        normalized_days: z.number().int().positive().nullable(),
        backup_days: z.number().int().positive().nullable(),
        reviewed_ref: z.string().nullable(),
      })
      .strict(),
    region_map: z.record(
      z.string(),
      z.object({ country: z.string().regex(/^[A-Z]{2}$/), evidence_ref: z.string() }).strict(),
    ),
  })
  .strict();

export const SourceSchema = z
  .object({
    source_id: z.string().regex(/^[a-z0-9_-]+$/),
    dataset_type: z.enum([
      'fx',
      'ai_api_prices',
      'gpu_rental',
      'gpu_secondary',
      'memory',
      'electricity',
      'rates_credit',
      'capex_utilization',
      'gpu_index',
    ]),
    operator: z.string(),
    source_url: z.url(),
    documentation_url: z.url().nullable(),
    terms_url: z.url().nullable(),
    license_url: z.url().nullable(),
    endpoint: z.url().nullable(),
    acquisition_method: z.string(),
    authentication_required: z.boolean().nullable(),
    native_currency: z.string().nullable(),
    native_unit: z.string().nullable(),
    geography: z.array(z.string()),
    native_frequency: z.string(),
    expected_update_calendar: z.string(),
    expected_lag: z.string(),
    rights_checked_at: z.iso.datetime(),
    rights_evidence_ref: z.string(),
    attribution_text: z.string(),
    known_limitations: z.array(z.string()),
    enabled: z.boolean(),
    adapter: z.enum([
      'ecb',
      'models_dev',
      'openrouter',
      'candidate',
      'lambda',
      'sakura_dok',
      'ebay_browse',
      'price_of_compute',
    ]),
    gpu: GPUConfigSchema.optional(),
    models: ModelsConfigSchema.optional(),
    selection: z.array(z.string()),
    max_bytes: z.number().int().positive().max(32000000),
    max_records: z.number().int().positive().max(100),
    policy: PolicySchema,
  })
  .strict();
export type Source = z.infer<typeof SourceSchema>;
export type Policy = z.infer<typeof PolicySchema>;
export const DecimalString = z.string().regex(/^(0|[1-9]\d*)(\.\d+)?$/);
export const PriceComponent = z
  .object({
    component_type: z.enum([
      'input',
      'output',
      'cache_read',
      'cache_write',
      'reasoning',
      'input_audio',
      'output_audio',
      'request',
    ]),
    amount_decimal: DecimalString.nullable(),
    currency: z.literal('USD'),
    unit: z.enum(['token', 'million_tokens', 'request']),
    tier_conditions: z.string().nullable(),
    cache_ttl: z.string().nullable(),
    price_state: z
      .enum(['reported', 'zero_unverified', 'missing', 'unknown', 'unsupported', 'free_confirmed'])
      .optional(),
    free_evidence_ref: z.string().nullable().optional(),
    source_path: z.string().optional(),
    pricing_mode: z.string().nullable().optional(),
  })
  .strict();
export const AISchema = z
  .object({
    model_author: z.string().nullable(),
    model_id: z.string().min(1),
    model_version: z.string().nullable(),
    serving_provider: z.string().nullable(),
    provider_endpoint_id: z.string().nullable(),
    region: z.string().nullable(),
    service_tier: z.string().nullable(),
    pricing_scope: z.enum(['provider_catalog', 'aggregated_catalog']),
    modality: z.object({ input: z.array(z.string()), output: z.array(z.string()) }).nullable(),
    context_limit: z.string().nullable(),
    context_pricing_tiers: z.unknown().nullable(),
    price_components: z.array(PriceComponent).min(1),
    billing_notes: z.string().nullable(),
    tax_status: z.literal('unknown'),
    platform_fee_status: z.literal('unknown'),
  })
  .strict();
export const FXSchema = z
  .object({
    base_currency: z.literal('EUR'),
    quote_currency: z.string().regex(/^[A-Z]{3}$/),
    rate_decimal: DecimalString,
    calendar: z.literal('TARGET'),
    reference_rate_type: z.literal('ECB_reference'),
  })
  .strict();
export type AIPrice = z.infer<typeof AISchema>;
export type FXRate = z.infer<typeof FXSchema>;
export type Candidate = {
  dataset: 'fx' | 'ai_api_prices' | 'ai_model_catalog' | 'gpu_rental' | 'gpu_secondary';
  entity_key: string;
  source_record_key: string;
  source_date: string | null;
  source_published_at: string | null;
  source_effective_at: string | null;
  observation_basis:
    | 'reference_rate'
    | 'catalog_listing'
    | 'advertised_quote'
    | 'observed_transaction'
    | 'third_party_reported_transaction'
    | 'modeled_estimate';
  quality_flags: string[];
  domain: AIPrice | FXRate | ModelCatalog | GPURental | GPUSecondary;
};
export type Evidence = {
  format:
    | 'ecb_xml'
    | 'models_projection_v1'
    | 'models_projection_v2'
    | 'openrouter_synthetic'
    | 'gpu_projection_v1';
  gpu_page?: {
    snapshot_id: string;
    partition_id: string;
    scope_hash: string;
    page_number: number;
    next_page: number | null;
    reported_total: number | null;
    received_count: number;
    complete: boolean;
    issues: string[];
  };
  body: string;
  observed_at: string;
  response_status: number;
  payload_hash: string;
  evidence_hash: string;
  bytes: number;
  etag: string | null;
  last_modified: string | null;
  synthetic: boolean;
  source_id: string;
  source_policy_version: string;
};
export type Observation = Candidate & {
  observation_id: string;
  source_id: string;
  source_policy_version: string;
  scheduled_for: string;
  observed_at: string;
  first_seen_at: string;
  recorded_at: string;
  native_frequency: string;
  source_url: string;
  raw_artifact_ref: string;
  raw_payload_hash: string;
  record_fingerprint: string;
  collector_version: string;
  parser_version: string;
  schema_version: '1';
  snapshot_id?: string;
  model_snapshot_id?: string;
  backfill?: boolean;
  data_origin: 'synthetic' | 'live';
  quality_status: 'accepted' | 'quarantined';
  supersedes_observation_id: string | null;
};
export type CollectorEnv = {
  PRIVATE_DB: D1Database;
  PUBLIC_DB: D1Database;
  EVIDENCE: R2Bucket;
  ENVIRONMENT: 'production' | 'test' | 'development';
  ALERT_WEBHOOK_URL?: string;
  AGENT_ENABLED?: string;
  COLLECTION_CRON?: string;
  COLLECTION_HOUR?: string;
  COLLECTION_MINUTE?: string;
  COLLECTION_ENABLED?: string;
  WATCHDOG_CRON?: string;
  GPU_RESUME_CRON?: string;
  LAMBDA_API_KEY?: string;
  SAKURA_ACCESS_TOKEN?: string;
  SAKURA_ACCESS_SECRET?: string;
  EBAY_CLIENT_ID?: string;
  EBAY_CLIENT_SECRET?: string;
};
