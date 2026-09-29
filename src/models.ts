import { AISchema, type AIPrice, type Source, type Evidence } from './schema';
import { ModelCatalogSchema, type ModelCatalog } from './models-schema';
import { modelsAuthorizationReady } from './policy';
import { stable, hash, decimal, isoDate } from './util';

export const MODELS_PARSER = 'models-catalog-20260930.1';
type Obj = Record<string, unknown>;
const object = (v: unknown): Obj => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('invalid_structure');
  return v as Obj;
};
const costs = [
  'input',
  'output',
  'cache_read',
  'cache_write',
  'reasoning',
  'input_audio',
  'output_audio',
] as const;
export type ProjectedModel = {
  key: string;
  catalog: ModelCatalog;
  price: AIPrice | null;
  price_issues: string[];
};
export type ModelProjection = {
  projection: 'models_projection_v2';
  scope_hash: string;
  complete: boolean;
  issues: string[];
  enumerated_count: number;
  records: ProjectedModel[];
  parse_elapsed_ms: number;
};
export const modelScope = (s: Source) => ({
  endpoint: s.endpoint,
  providers: [...s.models!.providers].sort(),
  fields: [...s.models!.fields].sort(),
  max_models: s.models!.max_models,
  max_components: s.models!.max_components,
  policy_version: s.policy.version,
  parser: MODELS_PARSER,
});
export const modelScopeHash = (s: Source) => hash(stable(modelScope(s)));

function projectRecord(s: Source, provider: string, id: string, m: Obj): ProjectedModel {
  const missing: ModelCatalog['missing_reasons'] = {};
  const read = (path: string, check: (v: unknown) => boolean): any => {
    if (!s.models!.fields.includes(path as any)) {
      missing[path] = 'not_in_policy';
      return null;
    }
    let v: unknown = m;
    for (const part of path.split('.'))
      v = v && typeof v === 'object' ? (v as Obj)[part] : undefined;
    if (v == null) {
      missing[path] = 'not_provided';
      return null;
    }
    if (!check(v)) {
      missing[path] = 'invalid_source_value';
      return null;
    }
    return v;
  };
  const identifier = (v: unknown) =>
    typeof v === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,179}$/.test(v);
  if (!identifier(id) || m.id !== id) throw new Error('invalid_model_identity');
  const canonical = read('canonical_model_id', (v) => identifier(v) && String(v).includes('/')) as
    string | null;
  const count = (v: unknown) => typeof v === 'string' && /^(0|[1-9]\d*)$/.test(v);
  const date = (v: unknown) =>
    typeof v === 'string' && (/^\d{4}-(0[1-9]|1[0-2])$/.test(v) || isoDate(v));
  const modalities = (v: unknown) =>
    Array.isArray(v) &&
    v.length <= 16 &&
    v.every((x) => ['text', 'audio', 'image', 'video', 'pdf'].includes(x));
  for (const key of ['model_version', 'identifier_kind', 'region', 'service_tier', 'availability'])
    missing[key] = 'not_established_by_catalog';
  const catalog = ModelCatalogSchema.parse({
    model_id: id,
    serving_provider: provider,
    provider_endpoint_id: id,
    model_author: canonical ? canonical.split('/')[0] : null,
    model_version: null,
    identifier_kind: 'unknown',
    canonical_model_id: canonical,
    mapping_basis: canonical ? 'source_canonical_model_id' : 'not_provided',
    mapping_version: 'models-canonical-v1',
    context_limit: read('limit.context', count),
    max_input: read('limit.input', count),
    max_output: read('limit.output', count),
    modality: {
      input: read('modalities.input', modalities),
      output: read('modalities.output', modalities),
    },
    capabilities: Object.fromEntries(
      ['reasoning', 'tool_call', 'structured_output', 'attachment', 'temperature'].map((k) => [
        k,
        read(k, (v) => typeof v === 'boolean'),
      ]),
    ),
    release_date: read('release_date', date),
    upstream_updated_date: read('last_updated', date),
    source_status: read('status', (v) => ['alpha', 'beta', 'deprecated'].includes(String(v))),
    availability: 'unknown',
    pricing_scope: 'provider_catalog',
    region: null,
    service_tier: null,
    missing_reasons: missing,
  });
  const flags: string[] = [];
  if (!s.models!.fields.includes('cost'))
    return {
      key: provider + '/' + id,
      catalog,
      price: null,
      price_issues: ['price_not_in_policy'],
    };
  const components: AIPrice['price_components'] = [];
  const add = (value: unknown, path: string, condition: string | null, mode: string | null) => {
    let c: Obj = {};
    if (value != null) {
      try {
        c = object(value);
      } catch {
        flags.push('invalid_pricing_structure');
      }
    }
    if (
      Object.keys(c).some(
        (k) => !costs.includes(k as any) && !['tiers', 'context_over_200k', 'tier'].includes(k),
      )
    )
      flags.push('unsupported_pricing_structure');
    for (const k of costs) {
      if (!(k in c) && !['input', 'output'].includes(k)) continue;
      let amount: string | null = null;
      let state: NonNullable<AIPrice['price_components'][number]['price_state']> =
        k in c ? 'unknown' : 'missing';
      if (c[k] != null) {
        try {
          amount = decimal(c[k]);
          state = amount === '0' ? 'zero_unverified' : 'reported';
        } catch {
          state = 'unsupported';
          flags.push('invalid_price');
        }
      }
      if (amount === null) flags.push('price_component_missing');
      if (amount === '0') flags.push('zero_price_reported');
      components.push({
        component_type: k,
        amount_decimal: amount,
        currency: 'USD',
        unit: 'million_tokens',
        tier_conditions: condition,
        cache_ttl: null,
        price_state: state,
        free_evidence_ref: null,
        source_path: path + '.' + k,
        pricing_mode: mode,
      });
    }
  };
  const tiers: { type: 'context'; size: string }[] = [];
  let cost: Obj = {};
  try {
    if (m.cost != null) cost = object(m.cost);
  } catch {
    flags.push('invalid_pricing_structure');
  }
  add(m.cost, 'cost', null, null);
  if (cost.tier !== undefined) flags.push('unsupported_pricing_structure');
  if (cost.tiers !== undefined) {
    if (!Array.isArray(cost.tiers) || cost.tiers.length > 8)
      flags.push('unsupported_pricing_structure');
    else
      for (const [i, value] of cost.tiers.entries()) {
        try {
          const row = object(value),
            tier = object(row.tier);
          if (
            Object.keys(tier).some((k) => !['type', 'size'].includes(k)) ||
            tier.type !== 'context' ||
            !count(tier.size) ||
            tiers.some((t) => t.size === tier.size)
          )
            throw new Error('tier');
          const condition = { type: 'context' as const, size: tier.size as string };
          tiers.push(condition);
          add(row, 'cost.tiers.' + i, stable(condition), null);
        } catch {
          flags.push('unsupported_pricing_structure');
        }
      }
  }
  if (cost.context_over_200k !== undefined) {
    // Upstream aliases any single tier >=200k here. The name alone does not establish a threshold.
    const rows = Array.isArray(cost.tiers) ? cost.tiers : [];
    if (rows.length !== 1 || !tiers.length) flags.push('ambiguous_legacy_context_tier');
    else {
      const { tier: _, ...values } = object(rows[0]);
      if (stable(values) !== stable(cost.context_over_200k)) flags.push('conflicting_context_tier');
    }
  }
  if (m.experimental && s.models!.fields.includes('experimental.modes.cost')) {
    try {
      const modes = object(object(m.experimental).modes);
      if (Object.keys(modes).length > 8) throw new Error('mode_limit');
      for (const [mode, value] of Object.entries(modes).sort(([a], [b]) => a.localeCompare(b))) {
        if (!/^[a-z0-9_-]{1,40}$/.test(mode)) {
          flags.push('unsupported_pricing_mode');
          continue;
        }
        const entry = object(value);
        // Request bodies/headers could affect price, and are outside the projection grant.
        if (entry.provider !== undefined) flags.push('unretained_mode_conditions');
        if (entry.cost !== undefined) {
          const modeCost = object(entry.cost);
          if (['tiers', 'tier', 'context_over_200k'].some((k) => modeCost[k] !== undefined))
            flags.push('unsupported_mode_tiers');
          add(entry.cost, 'experimental.modes.' + mode + '.cost', null, mode);
        }
      }
    } catch {
      flags.push('unsupported_pricing_mode');
    }
  } else if (m.experimental && !s.models!.fields.includes('experimental.modes.cost'))
    flags.push('pricing_modes_not_in_policy');
  if (components.length > s.models!.max_components)
    return {
      key: provider + '/' + id,
      catalog,
      price: null,
      price_issues: ['component_limit_exceeded'],
    };
  const price = AISchema.parse({
    model_author: catalog.model_author,
    model_id: id,
    model_version: null,
    serving_provider: provider,
    provider_endpoint_id: id,
    region: null,
    service_tier: null,
    pricing_scope: 'provider_catalog',
    modality: catalog.modality.input && catalog.modality.output ? catalog.modality : null,
    context_limit: catalog.context_limit,
    context_pricing_tiers: tiers.length ? tiers : null,
    price_components: components,
    billing_notes:
      'Secondary community catalog; original USD/million_tokens. Zero is not confirmed free. Mode and tier conditions retain source labels; availability, tax, fees, promotions and cache TTL are unconfirmed.',
    tax_status: 'unknown',
    platform_fee_status: 'unknown',
  });
  return { key: provider + '/' + id, catalog, price, price_issues: [...new Set(flags)] };
}
export async function projectModelCatalog(text: string, s: Source): Promise<ModelProjection> {
  if (!modelsAuthorizationReady(s)) throw new Error('model_scope_not_authorized');
  if (new TextEncoder().encode(text).byteLength > s.max_bytes)
    throw new Error('response_too_large');
  const started = performance.now();
  // Native source-aware reviver keeps the original numeric lexeme without building
  // very large strings character-by-character. Fail closed on unsupported runtimes.
  let parsed: unknown;
  try {
    parsed = JSON.parse(text, (_key, value, context?: { source?: string }) => {
      if (typeof value !== 'number') return value;
      if (!context?.source) throw new Error('json_numeric_lexeme_unavailable');
      return context.source;
    });
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('catalog_parse_error');
    throw error;
  }
  const root = object(parsed);
  if (root.error || root.data || root.next || root.links)
    throw new Error('unexpected_catalog_structure');
  const records: ProjectedModel[] = [],
    issues: string[] = [];
  let enumerated = 0;
  for (const provider of [...s.models!.providers].sort()) {
    if (!Object.hasOwn(root, provider)) {
      issues.push('selected_provider_missing:' + provider);
      continue;
    }
    try {
      const p = object(root[provider]);
      if (p.id !== provider) throw new Error('provider_identity');
      const models = object(p.models),
        ids = Object.keys(models).sort();
      enumerated += ids.length;
      if (enumerated > s.models!.max_models) {
        issues.push('model_limit_exceeded');
        continue;
      }
      for (const id of ids) {
        try {
          records.push(projectRecord(s, provider, id, object(models[id])));
        } catch {
          issues.push('model_schema_error');
        }
      }
    } catch {
      issues.push('provider_schema_error:' + provider);
    }
  }
  // Do not silently retain a truncated prefix as a complete catalog.
  if (issues.includes('model_limit_exceeded')) records.length = 0;
  return {
    projection: 'models_projection_v2',
    scope_hash: await modelScopeHash(s),
    complete: issues.length === 0,
    issues: [...new Set(issues)],
    enumerated_count: enumerated,
    records,
    parse_elapsed_ms: performance.now() - started,
  };
}
export async function modelEvidence(
  s: Source,
  text: string,
  observed: string,
  synthetic = false,
): Promise<Evidence> {
  const projected = await projectModelCatalog(text, s),
    body = stable(projected);
  return {
    format: 'models_projection_v2',
    body,
    source_id: s.source_id,
    source_policy_version: s.policy.version,
    observed_at: observed,
    response_status: 200,
    payload_hash: await hash(text),
    evidence_hash: await hash(body),
    bytes: new TextEncoder().encode(text).byteLength,
    etag: null,
    last_modified: null,
    synthetic,
  };
}
export async function readModelEvidence(
  s: Source,
  e: Evidence,
  reviewedScopeHash?: string,
): Promise<ModelProjection> {
  if (
    e.format !== 'models_projection_v2' ||
    e.source_id !== s.source_id ||
    e.source_policy_version !== s.policy.version ||
    (await hash(e.body)) !== e.evidence_hash
  )
    throw new Error('evidence_integrity_failure');
  const p = JSON.parse(e.body) as ModelProjection;
  if (
    p.projection !== 'models_projection_v2' ||
    p.scope_hash !== (reviewedScopeHash ?? (await modelScopeHash(s))) ||
    !Array.isArray(p.records) ||
    p.records.length > s.models!.max_models
  )
    throw new Error('evidence_scope_mismatch');
  for (const r of p.records) {
    const catalog = ModelCatalogSchema.parse(r.catalog);
    const price = r.price ? AISchema.parse(r.price) : null;
    const granted = new Set(s.models!.fields);
    const guarded = {
      canonical_model_id: catalog.canonical_model_id ?? catalog.model_author,
      'limit.context': catalog.context_limit,
      'limit.input': catalog.max_input,
      'limit.output': catalog.max_output,
      'modalities.input': catalog.modality.input,
      'modalities.output': catalog.modality.output,
      ...catalog.capabilities,
      release_date: catalog.release_date,
      last_updated: catalog.upstream_updated_date,
      status: catalog.source_status,
      cost: price,
    };
    if (
      !s.models!.providers.includes(r.catalog.serving_provider) ||
      r.key !== r.catalog.serving_provider + '/' + r.catalog.model_id ||
      stable(catalog) !== stable(r.catalog) ||
      stable(price) !== stable(r.price) ||
      Object.entries(guarded).some(
        ([field, value]) => !granted.has(field as any) && value !== null,
      ) ||
      (price &&
        (price.model_id !== catalog.model_id ||
          price.serving_provider !== catalog.serving_provider ||
          price.price_components.length > s.models!.max_components ||
          price.price_components.some(
            (c) => c.pricing_mode !== null && !granted.has('experimental.modes.cost'),
          )))
    )
      throw new Error('evidence_scope_mismatch');
  }
  return p;
}
