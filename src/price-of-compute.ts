import { parse, LosslessNumber } from 'lossless-json';
import Decimal from 'decimal.js';

export const PROJECTION_VERSION = 'poc_private_projection_v1';
export const ATTRIBUTION = {
  text: 'Data: Price of Compute',
  url: 'https://www.priceofcompute.com/',
} as const;
const SUPPORTED_SKUS = new Set(['h100-sxm', 'a100-pcie-80gb', 'b200', 'b300']);
const PRICING_TYPES = new Set(['on_demand', 'spot', 'community']);
const ROOT_FIELDS = new Set(['sku', 'day', 'prices', 'providers', 'updated_at', 'attribution']);
const ROW_FIELDS = new Set(['provider', 'pricing_type', 'usd_per_gpu_hr', 'region', 'observed_at']);

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('invalid_object');
  return value as Record<string, unknown>;
}
function label(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 256 ||
    /[\u0000-\u001f]/.test(value)
  )
    throw Error('invalid_label');
  return value;
}
function time(value: unknown): string {
  const result = label(value);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(result) ||
    !Number.isFinite(Date.parse(result))
  )
    throw Error('invalid_timestamp');
  if (new Date(result).toISOString().slice(0, 19) !== result.slice(0, 19))
    throw Error('invalid_timestamp');
  return result;
}
function day(value: unknown): string {
  const result = label(value);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(result) ||
    !Number.isFinite(Date.parse(result)) ||
    new Date(result).toISOString().slice(0, 10) !== result
  )
    throw Error('invalid_day');
  return result;
}
function decimal(value: unknown): string {
  if (value instanceof LosslessNumber) value = value.value;
  if (
    typeof value !== 'string' ||
    value.length > 128 ||
    !/^(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)
  )
    throw Error('invalid_price');
  const result = new Decimal(value);
  if (
    !result.isFinite() ||
    result.isNegative() ||
    result.e > 12 ||
    result.e < -18 ||
    (result.isZero() && /[1-9]/.test(value.split(/[eE]/)[0]))
  )
    throw Error('invalid_price');
  return result.toFixed();
}

/** Pure source projection. Does not fetch, persist, or grant collection/publication rights. */
export function projectPriceOfCompute(text: string, requestedSku: string, retrievedAt: string) {
  if (!SUPPORTED_SKUS.has(requestedSku)) throw Error('sku_not_approved');
  if (new TextEncoder().encode(text).length > 262144) throw Error('response_too_large');
  const retrieved = time(retrievedAt);
  const root = object(parse(text));
  if (root.error || root.errors) throw Error('source_error');
  if (root.next || (root.links && object(root.links).next)) throw Error('pagination_unsupported');
  // Unknown root fields can change pagination, currency, basis or market scope.
  // Discarding them as harmless text could mark a partial or redefined quote complete.
  if (Object.keys(root).some((field) => !ROOT_FIELDS.has(field)))
    throw Error('unsupported_root_field');
  const sourceSku = label(root.sku);
  if (sourceSku.toLowerCase() !== requestedSku) throw Error('sku_mismatch');
  const sourceDay = day(root.day),
    updatedAt = time(root.updated_at);
  if (sourceDay > retrieved.slice(0, 10) || Date.parse(updatedAt) > Date.parse(retrieved))
    throw Error('future_source_time');
  if (!Array.isArray(root.providers) || root.providers.length > 50) throw Error('provider_limit');
  const seen = new Set<string>();
  const records = root.providers.map((input) => {
    const row = object(input);
    if (Object.keys(row).some((field) => !ROW_FIELDS.has(field)))
      throw Error('unsupported_provider_field');
    const provider = label(row.provider),
      pricingType = label(row.pricing_type);
    if (!PRICING_TYPES.has(pricingType)) throw Error('unsupported_pricing_type');
    const region = row.region == null ? null : label(row.region);
    const observedAt = row.observed_at == null ? null : time(row.observed_at);
    if (observedAt && Date.parse(observedAt) > Date.parse(retrieved))
      throw Error('future_source_time');
    const amount = decimal(row.usd_per_gpu_hr);
    // Identity retains the source-native pricing type and region, without inventing a provider offer ID.
    const recordKey = JSON.stringify([requestedSku, provider, pricingType, region]);
    if (seen.has(recordKey)) throw Error('duplicate_provider_condition');
    seen.add(recordKey);
    return {
      record_key: recordKey,
      source_id: 'price_of_compute',
      requested_sku: requestedSku,
      source_sku: sourceSku,
      provider,
      source_pricing_type: pricingType,
      source_region: region,
      amount_decimal: amount,
      currency: 'USD',
      billing_unit: 'gpu_hour',
      source_observed_at: observedAt,
      source_day: sourceDay,
      source_updated_at: updatedAt,
      retrieved_at: retrieved,
      observation_basis: 'advertised_quote',
      availability_status: 'unknown',
      availability_guaranteed: null,
      country: null,
      tax_status: 'unknown',
      secondary_source: true,
      origin_source_id: provider,
      origin_offer_id: null,
      quality_flags: [
        ...(amount === '0' ? ['zero_price_reported'] : []),
        ...(observedAt ? [] : ['provider_observation_time_missing']),
      ],
    };
  });
  return {
    projection: PROJECTION_VERSION,
    source_id: 'price_of_compute',
    source_url: `https://priceofcompute.com/api/v1/prices/${requestedSku}`,
    source_day: sourceDay,
    source_updated_at: updatedAt,
    retrieved_at: retrieved,
    attribution: ATTRIBUTION,
    records,
  };
}
