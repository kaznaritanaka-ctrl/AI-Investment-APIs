import { GPURentalSchema, GPUSecondarySchema } from './gpu';
import { z } from 'zod';
import { AISchema, DecimalString } from './schema';
import { ModelCatalogSchema, ModelCoverageSchema, ModelEventSchema } from './models-schema';
export const PublicObservationSchema = z.object({
  observation_id: z.string(),
  entity_key: z.string(),
  dataset: z.enum(['fx', 'ai_api_prices', 'ai_model_catalog', 'gpu_rental', 'gpu_secondary']),
  schema_version: z.literal('1'),
  dataset_version: z.string(),
  data_origin: z.enum(['live', 'synthetic']),
  observed_at: z.iso.datetime(),
  recorded_at: z.iso.datetime(),
  first_seen_at: z.iso.datetime(),
  source_date: z.string().nullable(),
  source_published_at: z.iso.datetime().nullable(),
  source_effective_at: z.iso.datetime().nullable(),
  supersedes_observation_id: z.string().nullable(),
  observation_basis: z.enum([
    'advertised_quote',
    'reference_rate',
    'catalog_listing',
    'derived',
    'observed_transaction',
    'third_party_reported_transaction',
    'modeled_estimate',
  ]),
  snapshot_id: z.string().optional(),
  model_snapshot_id: z.string().optional(),
  first_model_observed_at: z.iso.datetime().optional(),
  backfill: z.boolean().optional(),
  statistical_exclusions: z.array(z.string()).optional(),
  value: z.union([
    AISchema,
    ModelCatalogSchema,
    GPURentalSchema,
    GPUSecondarySchema,
    z.object({
      base_currency: z.string(),
      quote_currency: z.string(),
      rate_decimal: DecimalString,
      calendar: z.literal('TARGET'),
      reference_rate_type: z.enum(['ECB_reference', 'project_calculation']),
    }),
  ]),
  currency: z.string().nullable(),
  unit: z.string(),
  source: z.object({
    source_id: z.string(),
    source_url: z.url(),
    operator: z.string(),
    secondary: z.boolean(),
  }),
  attribution: z.string(),
  methodology: z.string(),
  quality_status: z.literal('accepted'),
  quality_flags: z.array(z.string()),
  coverage: z.object({ selection: z.array(z.string()), market_representative: z.literal(false) }),
  rights_version: z.string(),
  reuse: z.object({
    license_url: z.url().nullable(),
    conditions: z.array(z.string()),
    notice: z.string().nullable(),
  }),
  stale: z.boolean(),
  stale_reason: z.string().nullable(),
  fx_reference: z
    .object({
      fx_source_date: z.string(),
      fx_observed_at: z.iso.datetime(),
      fx_carried_forward: z.boolean(),
      fx_age: z.number().int().nonnegative(),
      calendar_closed: z.boolean(),
    })
    .nullable(),
  lineage: z.array(z.string()).optional(),
});
export const methodology = {
  'models-catalog-v1': {
    id: 'models-catalog-v1',
    description:
      'Provider-scoped secondary community catalog. Baseline and first observation are not releases. Not-seen requires two complete identical scopes and is not deprecation. Source canonical linkage is versioned without automatic model merging; alias/fixed version remains unknown unless established. Price eligibility is separate from membership.',
    history:
      'Daily immutable observations, bounded checkpoint replay, explicit reviewed reanalysis and public completion cutoff. Current rights and input lineage apply to events.',
    prices:
      'Original USD/million_tokens. Retain exact context-tier labels and experimental mode labels, not assumed batch/priority semantics. Unknown structures quarantine only that price. Source zero is zero_unverified, never free_confirmed. No unit conversion or derived ranking is published.',
  },
  'gpu-market-v1': {
    id: 'gpu-market-v1',
    description:
      'Observed search scope only. Separate rental and secondary asks. Decimal type-7 quantiles, matched-offer median ratios, exact UTC-date 7/30/90 references; no interpolation. Partial coverage is not zero. Disappearance is not sale. Availability evidence is not utilization. Unknown identity/conditions and secondary-source duplication are explicitly excluded. Comparisons retain both conditions and FX input IDs; net-tax quotes only for JP-US. First seen age is collector history, not listing age.',
    capture:
      'Daily run / partition / immutable page / snapshot. Complete pagination required before public prices; current partial coverage is reported separately.',
    lineage:
      'Immutable snapshot membership plus all input source-policy versions; FX uses original EUR quote observation IDs no later than both quotes, same source date and maximum four-day age.',
  },
  'same-series-change-v1': {
    id: 'same-series-change-v1',
    description:
      'Project calculation from two accepted same-condition observations. Requires both published input policies; percentage is null for zero or unknown denominator.',
  },
  'ecb-original-v1': {
    id: 'ecb-original-v1',
    description:
      'Unmodified ECB EUR reference quotes. Preserve source date, metadata and attribution. Date-only publication remains date-only. Not transaction prices.',
    calendar: 'TARGET',
    freshness: 'Expected TARGET date after 17:00 Europe/Berlin; collection age over 36h is stale.',
  },
  'fx-cross-v1': {
    id: 'fx-cross-v1',
    description:
      'Own calculation, not ECB-published cross rate. USDJPY=q_JPY/q_USD using same-date ECB EUR quotes.',
    precision: 40,
    output_decimal_places: 18,
    rounding: 'half-even',
    lineage: 'All input observations retained; all input source rights required.',
  },
  'api-catalog-v1': {
    id: 'api-catalog-v1',
    description:
      'Selected secondary Models.dev provider catalog observations; not manufacturer-verified prices. Identical provider, model and conditions only. Unspecified tiers are quarantined. No provider-minimum synthesis.',
    unit: 'USD per million tokens for Models.dev; USD per token/request for OpenRouter offline contract.',
    time: 'Model release/updated dates do not imply price effective dates.',
  },
  'fixed-tokens-v1': {
    id: 'fixed-tokens-v1',
    description:
      'Calculation helper only, not a published index. Same-provider input N and output M; excludes cache, reasoning, tax and request costs. Not equivalent task quality.',
  },
};
const query = (name: string, schema: unknown, description: string) => ({
  name,
  in: 'query',
  required: false,
  description,
  schema,
});
const gpuFilters = [
  'source',
  'sku',
  'provider',
  'country',
  'region',
  'contract',
  'condition',
  'basis',
  'snapshot',
].map((name) =>
  query(
    name,
    { type: 'string', maxLength: 160 },
    'Exact GPU dimension filter; unknown values are not inferred',
  ),
);
const common = [
  query(
    'as_of',
    { type: 'string', format: 'date-time' },
    'Knowledge cutoff; current rights still apply',
  ),
  ...gpuFilters,
  query('model_snapshot', { type: 'string', maxLength: 160 }, 'Exact Models.dev snapshot ID'),
  query(
    'dataset',
    {
      type: 'string',
      enum: ['fx', 'ai_api_prices', 'ai_model_catalog', 'gpu_rental', 'gpu_secondary'],
    },
    'Dataset filter. ai_model_catalog is opt-in to preserve default legacy price clients.',
  ),
  query(
    'entity',
    { type: 'string', maxLength: 300 },
    'Exact entity key returned by API; AI includes condition fingerprint',
  ),
];
const history = [
  ...common,
  query(
    'from',
    { type: 'string', format: 'date-time' },
    'Inclusive UTC timestamp; default snapshot minus 30 days',
  ),
  query(
    'to',
    { type: 'string', format: 'date-time' },
    'Inclusive UTC timestamp; interval at most 366 days',
  ),
  query('limit', { type: 'integer', minimum: 1, maximum: 100, default: 50 }, 'Maximum records'),
  query(
    'cursor',
    { type: 'string', maxLength: 2048 },
    'Opaque snapshot keyset cursor; keep filters unchanged, may change limit',
  ),
];
const errorSchema = {
  type: 'object',
  required: ['error'],
  properties: {
    error: { type: 'object', required: ['code'], properties: { code: { type: 'string' } } },
  },
};
const arraySchema = {
  type: 'object',
  required: ['schema_version', 'data'],
  properties: {
    schema_version: { const: '1' },
    data: { type: 'array', items: { $ref: '#/components/schemas/Observation' } },
    next_cursor: { type: ['string', 'null'] },
    snapshot_as_of: { type: 'string', format: 'date-time' },
  },
};
const response = (schema: unknown, description: string) => ({
  description,
  content: { 'application/json': { schema } },
  headers: { 'Cache-Control': { schema: { const: 'no-store' } } },
});
const operation = (summary: string, parameters: unknown[], schema: unknown) => ({
  summary,
  parameters,
  responses: {
    '200': response(schema, 'Success; null is not zero.'),
    '400': response(errorSchema, 'Invalid filters, interval or cursor.'),
    '404': response(errorSchema, 'No matching data or resource.'),
    '405': {
      description: 'Read-only endpoint. Empty response body.',
      headers: {
        Allow: { schema: { const: 'GET, HEAD' } },
        'Cache-Control': { schema: { const: 'no-store' } },
      },
    },
    '429': response(errorSchema, 'Configured rate limiter rejected request.'),
    '503': response(errorSchema, 'Public D1 unavailable; private state is not disclosed.'),
  },
});
const generic = { type: 'object' };
export const CoverageSchema = z.object({
  snapshot_id: z.string(),
  source_id: z.string(),
  dataset: z.enum(['gpu_rental', 'gpu_secondary']),
  data_origin: z.enum(['synthetic', 'live']),
  coverage: z.enum(['complete', 'partial']),
  missing_reason: z.string().nullable(),
  observed_offer_count: z.number().int().nonnegative(),
  received_api_records: z.number().int().nonnegative(),
  source_reported_total: z.number().int().nonnegative().nullable(),
  methodology: z.literal('gpu-market-v1'),
  market_representative: z.literal(false),
});
export const GPUMetricSchema = z.object({
  metric_id: z.string(),
  kind: z.enum(['cohort_summary', 'spot_difference', 'generation_ratio', 'jp_us']),
  dataset: z.enum(['gpu_rental', 'gpu_secondary']),
  snapshot_id: z.string(),
  sample_count: z.number().int().nonnegative(),
  status: z.enum(['ok', 'insufficient_data', 'incomparable']),
  conditions: z.record(z.string(), z.unknown()),
  methodology: z.literal('gpu-market-v1'),
  observed_at: z.iso.datetime(),
  recorded_at: z.iso.datetime(),
  median: DecimalString.nullable().optional(),
  ratio: DecimalString.nullable().optional(),
  input_refs: z.array(
    z.object({
      snapshot_id: z.string().nullable(),
      observation_id: z.string().nullable(),
      source_id: z.string(),
      policy_version: z.string(),
    }),
  ),
});
const gpuHistory = history
  .filter((p) =>
    ['dataset', 'source', 'sku', 'from', 'to', 'limit', 'cursor', 'as_of'].includes(p.name),
  )
  .concat([query('scope', { type: 'string', maxLength: 160 }, 'Exact search scope hash')]);
const gpuArray = (schema: string) => ({
  ...arraySchema,
  properties: {
    ...arraySchema.properties,
    data: { type: 'array', items: { $ref: '#/components/schemas/' + schema } },
  },
});
export const openapi = {
  openapi: '3.1.0',
  info: {
    title: 'AI Investment APIs',
    version: '0.3.0',
    description:
      'Research observations, not recommendations. Decimal strings. No universal data license. Public cache disabled for rights revocation.',
  },
  paths: {
    '/v1/models/coverage': {
      get: operation(
        'Model catalog snapshots; capture completeness is separate from price eligibility',
        [
          query('source', { type: 'string' }, 'Source ID'),
          query('scope', { type: 'string' }, 'Exact provider/field/policy/parser scope'),
          query('snapshot', { type: 'string' }, 'Snapshot ID'),
          ...history.filter((p) => ['as_of', 'limit', 'cursor'].includes(p.name)),
        ],
        gpuArray('ModelCoverage'),
      ),
    },
    '/v1/models/events': {
      get: operation(
        'Baseline, reobservation, first seen, reappearance, not seen, metadata, mapping, deprecation and price history with current input rights',
        [
          query('source', { type: 'string' }, 'Source ID'),
          query('scope', { type: 'string' }, 'Exact scope'),
          query('snapshot', { type: 'string' }, 'Snapshot ID'),
          ...history.filter((p) => ['as_of', 'limit', 'cursor'].includes(p.name)),
        ],
        gpuArray('ModelEvent'),
      ),
    },
    '/v1/gpu/coverage': {
      get: operation(
        'Current search coverage; partial is not inventory zero',
        gpuHistory.filter((p) => p.name !== 'sku'),
        gpuArray('Coverage'),
      ),
    },
    '/v1/gpu/metrics': {
      get: operation(
        'Comparable cohort statistics with sample sizes, exclusions and insufficient_data',
        gpuHistory,
        gpuArray('GPUMetric'),
      ),
    },
    '/v1/gpu/comparisons': {
      get: operation(
        'Persisted spot, generation and FX-linked JP-US comparisons; may be incomparable',
        gpuHistory,
        gpuArray('GPUMetric'),
      ),
    },
    '/v1/gpu/catalog': {
      get: operation('Identification dictionary; no market coverage implied', [], generic),
    },
    '/health': {
      get: operation(
        'Public data and last collector completion; external monitor status explicit',
        [],
        generic,
      ),
    },
    '/openapi.json': { get: operation('This OpenAPI contract', [], generic) },
    '/llms.txt': {
      get: {
        summary: 'Machine-readable usage notes',
        responses: {
          '200': {
            description: 'Notes',
            content: { 'text/plain': { schema: { type: 'string' } } },
          },
        },
      },
    },
    '/v1/datasets': { get: operation('Datasets with currently visible data', [], generic) },
    '/v1/sources': { get: operation('Currently authorized source notices and scope', [], generic) },
    '/v1/observations': {
      get: operation('Append-only observation and correction history', history, arraySchema),
    },
    '/v1/latest': {
      get: operation(
        'Latest accepted revision per exact series (maximum 100); GPU and model catalogs use latest complete scope membership',
        common,
        arraySchema,
      ),
    },
    '/v1/changes': {
      get: operation('Same-condition value changes', history, {
        ...arraySchema,
        properties: {
          ...arraySchema.properties,
          data: {
            type: 'array',
            items: {
              type: 'object',
              required: [
                'event_id',
                'observation_id',
                'previous_observation_id',
                'dataset',
                'entity_key',
                'observed_at',
                'details',
              ],
            },
          },
        },
      }),
    },
    '/v1/fx': {
      get: operation(
        'EUR raw or explicitly derived USD/JPY; no future-known observations',
        [
          query('base', { type: 'string', pattern: '^[A-Z]{3}$', default: 'EUR' }, 'Base currency'),
          query(
            'quote',
            { type: 'string', pattern: '^[A-Z]{3}$', default: 'USD' },
            'Quote currency',
          ),
          query(
            'as_of',
            { type: 'string', format: 'date-time' },
            'UTC information cutoff; no later observations or corrections',
          ),
        ],
        {
          type: 'object',
          required: ['schema_version', 'data'],
          properties: {
            schema_version: { const: '1' },
            data: { $ref: '#/components/schemas/Observation' },
          },
        },
      ),
    },
    '/v1/methodology/{id}': {
      get: operation(
        'Methodology or license notice',
        [
          {
            name: 'id',
            in: 'path',
            required: true,
            schema: { type: 'string', enum: [...Object.keys(methodology), 'licenses'] },
          },
        ],
        generic,
      ),
    },
  },
  components: {
    schemas: {
      Observation: z.toJSONSchema(PublicObservationSchema, { target: 'draft-2020-12' }),
      ModelCatalog: z.toJSONSchema(ModelCatalogSchema),
      ModelCoverage: z.toJSONSchema(ModelCoverageSchema),
      ModelEvent: z.toJSONSchema(ModelEventSchema),
      GPURental: z.toJSONSchema(GPURentalSchema),
      GPUSecondary: z.toJSONSchema(GPUSecondarySchema),
      Coverage: z.toJSONSchema(CoverageSchema),
      GPUMetric: z.toJSONSchema(GPUMetricSchema),
    },
  },
};
