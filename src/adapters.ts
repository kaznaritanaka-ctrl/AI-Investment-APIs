import { parse as parseLossless } from 'lossless-json';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import {
  AISchema,
  FXSchema,
  type Source,
  type Evidence,
  type Candidate,
  type AIPrice,
} from './schema';
import { decimal, isoDate, stable, hash } from './util';
type Obj = Record<string, unknown>;
const obj = (x: unknown): Obj => {
  if (!x || typeof x !== 'object' || Array.isArray(x)) throw new Error('invalid_structure');
  return x as Obj;
};
const numericJSON = (text: string): unknown =>
  parseLossless(text, undefined, (token: string) => token);
export type Parsed = { candidates: Candidate[]; issues: { record: string; code: string }[] };
const costNames = [
  'input',
  'output',
  'cache_read',
  'cache_write',
  'reasoning',
  'input_audio',
  'output_audio',
] as const;
// Only the data slice explicitly covered by the source policy is retained.
export function projectModels(text: string, source: Source): string {
  const root = obj(numericJSON(text));
  if (root.error || root.data || root.next || root.links)
    throw new Error('unexpected_catalog_structure');
  const selected: Obj = {};
  for (const key of source.selection) {
    const slash = key.indexOf('/'),
      provider = key.slice(0, slash),
      id = key.slice(slash + 1);
    const p = root[provider];
    if (!p) continue;
    const models = obj(obj(p).models);
    if (!models[id]) continue;
    const m = obj(models[id]);
    selected[key] = {
      provider,
      id,
      cost: m.cost ?? null,
      limit: m.limit ? { context: obj(m.limit).context ?? null } : null,
      modalities: m.modalities ?? null,
    };
  }
  return stable({ projection: 'models_projection_v1', selected });
}
export async function evidenceFromBody(
  source: Source,
  text: string,
  observed: string,
  status = 200,
  headers = new Headers(),
  synthetic = false,
): Promise<Evidence> {
  const payload_hash = await hash(text);
  const body = source.adapter === 'models_dev' ? projectModels(text, source) : text;
  return {
    source_id: source.source_id,
    source_policy_version: source.policy.version,
    format:
      source.adapter === 'ecb'
        ? 'ecb_xml'
        : source.adapter === 'models_dev'
          ? 'models_projection_v1'
          : 'openrouter_synthetic',
    body,
    observed_at: observed,
    response_status: status,
    payload_hash,
    evidence_hash: await hash(body),
    bytes: new TextEncoder().encode(text).byteLength,
    etag: headers.get('etag'),
    last_modified: headers.get('last-modified'),
    synthetic,
  };
}
export function parseEvidence(source: Source, evidence: Evidence): Parsed {
  if (source.adapter === 'ecb') return parseECB(evidence.body, source, evidence.observed_at);
  if (source.adapter === 'models_dev') return parseModels(evidence.body, source);
  if (source.adapter === 'openrouter') return parseOpenRouter(evidence.body);
  throw new Error('adapter_not_implemented');
}
export function parseECB(text: string, source: Source, observed: string): Parsed {
  if (/<!DOCTYPE|<!ENTITY/i.test(text) || XMLValidator.validate(text) !== true)
    throw new Error('invalid_xml');
  const parsed = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    parseAttributeValue: false,
    parseTagValue: false,
    removeNSPrefix: true,
    processEntities: false,
  }).parse(text);
  const dated = parsed.Envelope?.Cube?.Cube;
  if (!dated || Array.isArray(dated) || !isoDate(dated.time))
    throw new Error('invalid_source_date');
  if (dated.time > observed.slice(0, 10)) throw new Error('future_source_date');
  const rows = Array.isArray(dated.Cube) ? dated.Cube : [dated.Cube];
  const seen = new Set<string>(),
    candidates: Candidate[] = [];
  for (const row of rows) {
    if (!row || !/^[A-Z]{3}$/.test(row.currency) || seen.has(row.currency))
      throw new Error('invalid_currency_rows');
    seen.add(row.currency);
    if (!source.selection.includes(row.currency)) continue;
    const rate = decimal(row.rate);
    if (rate === '0') throw new Error('zero_fx_rate');
    candidates.push({
      dataset: 'fx',
      entity_key: 'EUR/' + row.currency,
      source_record_key: dated.time + ':' + row.currency,
      source_date: dated.time,
      source_published_at: null,
      source_effective_at: null,
      observation_basis: 'reference_rate',
      quality_flags: [],
      domain: FXSchema.parse({
        base_currency: 'EUR',
        quote_currency: row.currency,
        rate_decimal: rate,
        calendar: 'TARGET',
        reference_rate_type: 'ECB_reference',
      }),
    });
  }
  if (candidates.length !== source.selection.length) throw new Error('missing_selected_currencies');
  return { candidates, issues: [] };
}
function aiBase(id: string, provider: string | null, scope: AIPrice['pricing_scope']): AIPrice {
  return {
    model_author: null,
    model_id: id,
    model_version: null,
    serving_provider: provider,
    provider_endpoint_id: null,
    region: null,
    service_tier: null,
    pricing_scope: scope,
    modality: null,
    context_limit: null,
    context_pricing_tiers: null,
    price_components: [],
    billing_notes: null,
    tax_status: 'unknown',
    platform_fee_status: 'unknown',
  };
}
export function parseModels(body: string, source: Source): Parsed {
  const root = obj(JSON.parse(body));
  if (root.projection !== 'models_projection_v1') throw new Error('invalid_projection');
  const selected = obj(root.selected),
    result: Parsed = { candidates: [], issues: [] };
  for (const key of source.selection) {
    if (!selected[key]) {
      result.issues.push({ record: key, code: 'selected_record_missing' });
      continue;
    }
    try {
      const m = obj(selected[key]),
        cost = obj(m.cost),
        flags: string[] = [];
      const slash = key.indexOf('/'),
        provider = key.slice(0, slash),
        id = key.slice(slash + 1);
      if (m.provider !== provider || m.id !== id) throw new Error('identifier_mismatch');
      const d = aiBase(id, provider, 'provider_catalog');
      if (Object.keys(cost).some((k) => !costNames.includes(k as (typeof costNames)[number])))
        flags.push('unsupported_pricing_condition');
      d.context_pricing_tiers = cost.tiers ?? cost.context_over_200k ?? null;
      d.context_limit = m.limit ? (obj(m.limit).context as string | null) : null;
      d.modality = m.modalities as AIPrice['modality'];
      for (const name of costNames) {
        if (cost[name] === undefined && !['input', 'output'].includes(name)) continue;
        const amount = cost[name] === undefined || cost[name] === null ? null : decimal(cost[name]);
        if (amount === null) flags.push('price_component_missing');
        if (amount === '0') flags.push('zero_price_reported');
        d.price_components.push({
          component_type: name,
          amount_decimal: amount,
          currency: 'USD',
          unit: 'million_tokens',
          tier_conditions: null,
          cache_ttl: null,
        });
      }
      const domain = AISchema.parse(d);
      result.candidates.push({
        dataset: 'ai_api_prices',
        entity_key: key,
        source_record_key: key,
        source_date: null,
        source_published_at: null,
        source_effective_at: null,
        observation_basis: 'advertised_quote',
        quality_flags: [...new Set(flags)],
        domain,
      });
    } catch {
      result.issues.push({ record: key, code: 'invalid_selected_record' });
    }
  }
  return result;
}
// Offline contract only; no HTTP function can activate this adapter implicitly.
export function parseOpenRouter(text: string): Parsed {
  const root = obj(numericJSON(text));
  if (!Array.isArray(root.data) || !root.data.length) throw new Error('empty_catalog');
  if (
    root.next ||
    (root.links && obj(root.links).next) ||
    (root.total_count && Number(root.total_count) !== root.data.length)
  )
    throw new Error('pagination_incomplete');
  const candidates: Candidate[] = root.data.map((x) => {
    const m = obj(x),
      p = obj(m.pricing);
    if (typeof m.id !== 'string' || !m.id) throw new Error('invalid_model_id');
    const d = aiBase(m.id, null, 'aggregated_catalog');
    d.billing_notes =
      'Model-list catalog quote; serving endpoint unknown. Do not combine provider minima.';
    d.context_limit = (m.context_length ?? null) as string | null;
    for (const [key, name] of [
      ['prompt', 'input'],
      ['completion', 'output'],
      ['input_cache_read', 'cache_read'],
      ['input_cache_write', 'cache_write'],
      ['request', 'request'],
    ] as const) {
      if (p[key] === undefined && !['prompt', 'completion'].includes(key)) continue;
      d.price_components.push({
        component_type: name,
        amount_decimal: p[key] == null ? null : decimal(p[key]),
        currency: 'USD',
        unit: key === 'request' ? 'request' : 'token',
        tier_conditions: null,
        cache_ttl: null,
      });
    }
    const flags = d.price_components.some((c) => c.amount_decimal === null)
      ? ['price_component_missing']
      : [];
    if (
      Object.keys(p).some(
        (k) =>
          !['prompt', 'completion', 'input_cache_read', 'input_cache_write', 'request'].includes(k),
      )
    )
      flags.push('unsupported_pricing_condition');
    return {
      dataset: 'ai_api_prices',
      entity_key: 'catalog/' + m.id,
      source_record_key: m.id,
      source_date: null,
      source_published_at: null,
      source_effective_at: null,
      observation_basis: 'advertised_quote',
      quality_flags: flags,
      domain: AISchema.parse(d),
    };
  });
  return { candidates, issues: [] };
}
export function comparisonKey(c: Candidate): string {
  if (c.dataset === 'fx') return c.entity_key;
  const d = c.domain as AIPrice;
  return (
    c.entity_key +
    '|' +
    stable({
      ...d,
      price_components: d.price_components.map(
        ({ amount_decimal: _, ...conditions }) => conditions,
      ),
    })
  );
}
