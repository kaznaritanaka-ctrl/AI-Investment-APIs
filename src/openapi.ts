import { z } from 'zod';
import { AISchema, DecimalString } from './schema';
export const PublicObservationSchema = z.object({
  observation_id: z.string(),
  entity_key: z.string(),
  dataset: z.enum(['fx', 'ai_api_prices']),
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
  observation_basis: z.enum(['advertised_quote', 'reference_rate', 'derived']),
  value: z.union([
    AISchema,
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
const common = [
  query('dataset', { type: 'string', enum: ['fx', 'ai_api_prices'] }, 'Dataset filter'),
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
export const openapi = {
  openapi: '3.1.0',
  info: {
    title: 'AI Investment APIs',
    version: '0.1.0',
    description:
      'Research observations, not recommendations. Decimal strings. No universal data license. Public cache disabled for rights revocation.',
  },
  paths: {
    '/health': {
      get: operation('Public data availability, not collector operational health', [], generic),
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
        'Latest accepted revision per exact series (maximum 100)',
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
    schemas: { Observation: z.toJSONSchema(PublicObservationSchema, { target: 'draft-2020-12' }) },
  },
};
