import { z } from 'zod';

// These are projection paths, not permission to store entire model/provider objects.
export const ModelField = z.enum([
  'id',
  'canonical_model_id',
  'limit.context',
  'limit.input',
  'limit.output',
  'modalities.input',
  'modalities.output',
  'reasoning',
  'tool_call',
  'structured_output',
  'attachment',
  'temperature',
  'release_date',
  'last_updated',
  'status',
  'cost',
  'experimental.modes.cost',
]);
export const ModelScopeSchema = z
  .object({
    providers: z
      .array(z.string().regex(/^[a-z0-9-]+$/))
      .min(1)
      .max(20),
    fields: z.array(ModelField).min(1),
  })
  .strict();
export const ModelsConfigSchema = z
  .object({
    providers: z
      .array(z.string().regex(/^[a-z0-9-]+$/))
      .min(1)
      .max(20),
    fields: z.array(ModelField).min(1),
    max_models: z.number().int().positive().max(2000),
    models_per_invocation: z.number().int().positive().max(25),
    max_components: z.number().int().min(2).max(64),
    owner_approval_ref: z.string().nullable(),
    runtime_review_ref: z.string().nullable(),
    retention: z
      .object({
        evidence_days: z.number().int().positive().max(3650),
        archive_days: z.number().int().positive().max(3650),
        normalized_days: z.number().int().positive().max(3650),
        backup_days: z.number().int().positive().max(30),
        reviewed_ref: z.string().nullable(),
      })
      .strict(),
  })
  .strict();
const count = z
  .string()
  .regex(/^(0|[1-9]\d*)$/)
  .nullable();
const date = z
  .string()
  .regex(/^\d{4}-\d{2}(-\d{2})?$/)
  .nullable();
export const ModelCatalogSchema = z
  .object({
    model_id: z.string().min(1).max(180),
    serving_provider: z.string().min(1).max(80),
    provider_endpoint_id: z.string().min(1).max(180),
    model_author: z.string().nullable(),
    model_version: z.string().nullable(),
    identifier_kind: z.literal('unknown'),
    canonical_model_id: z.string().nullable(),
    mapping_basis: z.enum(['source_canonical_model_id', 'not_provided']),
    mapping_version: z.literal('models-canonical-v1'),
    context_limit: count,
    max_input: count,
    max_output: count,
    modality: z
      .object({ input: z.array(z.string()).nullable(), output: z.array(z.string()).nullable() })
      .strict(),
    capabilities: z
      .object({
        reasoning: z.boolean().nullable(),
        tool_call: z.boolean().nullable(),
        structured_output: z.boolean().nullable(),
        attachment: z.boolean().nullable(),
        temperature: z.boolean().nullable(),
      })
      .strict(),
    release_date: date,
    upstream_updated_date: date,
    source_status: z.enum(['alpha', 'beta', 'deprecated']).nullable(),
    availability: z.literal('unknown'),
    pricing_scope: z.literal('provider_catalog'),
    region: z.null(),
    service_tier: z.null(),
    missing_reasons: z.record(
      z.string(),
      z.enum([
        'not_provided',
        'not_in_policy',
        'invalid_source_value',
        'not_established_by_catalog',
      ]),
    ),
  })
  .strict();
export type ModelCatalog = z.infer<typeof ModelCatalogSchema>;
const reuse = z.object({
  license_url: z.string().nullable(),
  conditions: z.array(z.string()),
  notice: z.string(),
});
export const ModelCoverageSchema = z.object({
  schema_version: z.literal('1'),
  snapshot_id: z.string(),
  source_id: z.string(),
  rights_version: z.string(),
  dataset: z.tuple([z.literal('ai_model_catalog'), z.literal('ai_api_prices')]),
  scope_hash: z.string(),
  providers: z.array(z.string()),
  fields: z.array(ModelField),
  observed_at: z.iso.datetime(),
  recorded_at: z.iso.datetime(),
  completed_at: z.iso.datetime(),
  state: z.enum(['complete', 'partial']),
  capture_complete: z.boolean(),
  enumerated_model_count: z.number().int().nonnegative(),
  model_count: z.number().int().nonnegative(),
  price_observation_count: z.number().int().nonnegative(),
  price_component_count: z.number().int().nonnegative(),
  price_quarantined_count: z.number().int().nonnegative(),
  reasons: z.array(z.string()),
  data_origin: z.enum(['live', 'synthetic']),
  basis: z.literal('secondary_community_catalog'),
  availability_verified: z.literal(false),
  market_representative: z.literal(false),
  attribution: z.string(),
  reuse,
});
export const ModelEventSchema = z.object({
  event_id: z.string(),
  snapshot_id: z.string(),
  record_key: z.string(),
  kind: z.enum([
    'baseline_seen',
    'first_seen',
    'observed_again',
    'reappeared',
    'not_seen',
    'metadata_changed',
    'source_mapping_changed',
    'source_deprecated',
    'price_conditions_changed',
    'price_changed',
  ]),
  observation_id: z.string().nullable(),
  previous_observation_id: z.string().nullable(),
  observed_at: z.iso.datetime(),
  recorded_at: z.iso.datetime(),
  details: z.union([
    z.object({ release_inferred: z.literal(false) }).strict(),
    z.object({ fields: z.array(z.string()) }).strict(),
    z
      .object({
        before: z.string().nullable(),
        after: z.string().nullable(),
        automatic_merge: z.literal(false),
      })
      .strict(),
    z.object({ availability: z.literal('unknown') }).strict(),
    z.object({ price_direction: z.null() }).strict(),
    z
      .object({
        components: z.array(
          z.object({
            component: z.string(),
            before: z.string().nullable(),
            after: z.string().nullable(),
          }),
        ),
      })
      .strict(),
    z
      .object({
        scope_hash: z.string(),
        availability: z.literal('unknown'),
        deprecation_inferred: z.literal(false),
      })
      .strict(),
  ]),
  methodology: z.literal('models-catalog-v1'),
  attribution: z.string(),
  source_id: z.string(),
  reuse,
});
