import { z } from 'zod';
import { DecimalString, type Source, type Evidence } from './schema';
import catalogData from '../config/gpu-catalog.json';
import { ATTRIBUTION, PROJECTION_VERSION } from './price-of-compute';
const currency = z.string().regex(/^[A-Z]{3}$/);
const country = z
  .string()
  .regex(/^[A-Z]{2}$/)
  .nullable();
export const GPUIdentity = z
  .object({
    gpu_sku_id: z.string().nullable(),
    accelerator_model: z.string().nullable(),
    vram_gb: DecimalString.nullable(),
    form_factor: z.enum(['SXM', 'PCIe', 'NVL', 'unknown']),
    module_generation: z.string().nullable(),
    system_platform: z.string().nullable(),
    identification_evidence: z.string().nullable(),
    classification_version: z.string(),
    classification_status: z.enum(['resolved', 'candidate', 'excluded']),
    exclusion_reasons: z.array(z.string()),
  })
  .strict();
const rentalBase = z
  .object({
    provider: z.string(),
    offer_id: z.string(),
    country,
    region: z.string().nullable(),
    region_evidence: z.string().nullable(),
    accelerator_model: z.string().nullable(),
    vram_gb: DecimalString.nullable(),
    form_factor: z.enum(['SXM', 'PCIe', 'unknown']),
    interconnect: z.string().nullable(),
    gpu_count: z.number().int().positive().nullable(),
    dedicated_or_shared: z.enum(['dedicated', 'shared', 'unknown']),
    contract_type: z.enum(['on_demand', 'spot', 'reserved', 'monthly', 'unknown']),
    interruptible: z.boolean().nullable(),
    minimum_term: z.string().nullable(),
    commitment: z.string().nullable(),
    amount_decimal: DecimalString.nullable(),
    currency,
    billing_unit: z.enum(['gpu_hour', 'node_hour', 'second', 'month']),
    includes_cpu_ram_storage: z.string().nullable(),
    egress_notes: z.string().nullable(),
    tax_status: z.enum(['included', 'excluded', 'unknown']),
    availability_status: z.enum(['available', 'unavailable', 'unknown']),
    availability_evidence: z.string().nullable(),
    observation_basis: z.literal('advertised_quote'),
    synthetic: z.boolean(),
  })
  .strict();
function regionAndAvailability(
  v: {
    country: string | null;
    region: string | null;
    region_evidence: string | null;
    availability_status: string;
    availability_evidence: string | null;
  },
  c: z.RefinementCtx,
) {
  if ((v.country || v.region) && !v.region_evidence)
    c.addIssue({ code: 'custom', message: 'region_evidence_required', path: ['region_evidence'] });
  if (v.availability_status !== 'unknown' && !v.availability_evidence)
    c.addIssue({
      code: 'custom',
      message: 'availability_evidence_required',
      path: ['availability_evidence'],
    });
}
export const GPUSchema = rentalBase.superRefine(regionAndAvailability);
export type GPUQuote = z.infer<typeof GPUSchema>;
export const PriceOfComputeMetadata = z
  .object({
    projection: z.literal(PROJECTION_VERSION),
    source_id: z.literal('price_of_compute'),
    source_url: z.string().url(),
    source_day: z.iso.date(),
    source_updated_at: z.iso.datetime(),
    retrieved_at: z.iso.datetime(),
    attribution: z
      .object({ text: z.literal(ATTRIBUTION.text), url: z.literal(ATTRIBUTION.url) })
      .strict(),
  })
  .strict();
const PriceOfComputeQuote = PriceOfComputeMetadata.extend({
  requested_sku: z.enum(['h100-sxm', 'a100-pcie-80gb', 'b200', 'b300']),
  source_sku: z.string(),
  source_pricing_type: z.enum(['on_demand', 'spot', 'community']),
  source_observed_at: z.iso.datetime().nullable(),
}).strict();
export const GPURentalObject = rentalBase
  .extend({
    ...GPUIdentity.shape,
    serving_provider: z.string(),
    // Additive and source-scoped: legacy GPU records keep their shape and identity.
    price_of_compute: PriceOfComputeQuote.optional(),
    sale_unit: z.enum(['single_gpu', 'multi_gpu_lot', 'server', 'rack', 'unknown']),
    price_scope: z.enum(['public', 'account_specific', 'promotion', 'unknown']),
    minimum_gpu_count: z.number().int().positive().nullable(),
    network_conditions: z.string().nullable(),
    availability_observed_at: z.iso.datetime().nullable(),
    availability_gpu_count: z.number().int().nonnegative().nullable(),
    availability_guaranteed: z.boolean().nullable(),
    origin_source_id: z.string().nullable(),
    origin_offer_id: z.string().nullable(),
    secondary_source: z.boolean(),
    evidence_pointer: z.string(),
    source_effective_date: z.iso.date().nullable(),
    source_effective_until_date: z.iso.date().nullable(),
    tax_jurisdiction: z.string().nullable(),
    evidence_grade: z.enum(['source_reported', 'synthetic']),
  })
  .strict();
export const GPURentalSchema = GPURentalObject.superRefine(regionAndAvailability);
export const GPUSecondarySchema = z
  .object({
    ...GPUIdentity.shape,
    marketplace: z.string(),
    listing_id: z.string(),
    condition: z.enum(['used', 'refurbished', 'open_box', 'new', 'for_parts', 'unknown']),
    listing_format: z.enum(['fixed_price', 'auction', 'best_offer', 'unknown']),
    sale_unit: z.enum(['single_gpu', 'multi_gpu_lot', 'server', 'rack', 'unknown']),
    gpu_count_in_lot: z.number().int().positive().nullable(),
    quantity_available_reported: z.number().int().nonnegative().nullable(),
    asking_price: DecimalString.nullable(),
    shipping_price: DecimalString.nullable(),
    currency,
    tax_status: z.enum(['included', 'excluded', 'unknown']),
    tax_jurisdiction: z.string().nullable(),
    item_location: z.object({ country, evidence: z.string().nullable() }).strict(),
    delivery_region: z.string().nullable(),
    warranty_status: z.string().nullable(),
    source_listed_at: z.iso.datetime().nullable(),
    first_seen_at: z.iso.datetime().nullable(),
    last_seen_at: z.iso.datetime().nullable(),
    listing_state: z.enum(['seen', 'not_seen', 'explicitly_ended', 'explicitly_sold']),
    observation_basis: z.enum([
      'advertised_quote',
      'observed_transaction',
      'third_party_reported_transaction',
      'modeled_estimate',
    ]),
    transaction_at: z.iso.datetime().nullable(),
    report_period: z
      .object({
        from: z.iso.date(),
        to: z.iso.date(),
        sample_count: z.number().int().nonnegative().nullable(),
      })
      .nullable(),
    evidence_grade: z.enum(['source_reported', 'third_party_report', 'synthetic']),
    evidence_pointer: z.string(),
    origin_source_id: z.string().nullable(),
    origin_offer_id: z.string().nullable(),
    secondary_source: z.boolean(),
    synthetic: z.boolean(),
  })
  .strict();
export type GPURental = z.infer<typeof GPURentalSchema>;
export type GPUSecondary = z.infer<typeof GPUSecondarySchema>;
export type GPUDomain = GPURental | GPUSecondary;
export const GPU_CATALOG = catalogData;
export const GPU_METHOD = 'gpu-market-v1';
export function identifyGPU(text: string): z.infer<typeof GPUIdentity> {
  const model =
    catalogData.families.find((f) =>
      new RegExp('(^|[^A-Z0-9])' + f.model + '([^A-Z0-9]|$)', 'i').test(text),
    )?.model ?? null;
  const memory = text.match(/\b(\d+(?:\.\d+)?)\s*GB\b/i)?.[1] ?? null;
  const module = text.match(/\b(SXM\d+)\b/i)?.[1].toUpperCase() ?? null;
  const form = /\bSXM\d*\b/i.test(text)
    ? 'SXM'
    : /\bPCI[ -]?e\b/i.test(text)
      ? 'PCIe'
      : /\bNVL\b/i.test(text)
        ? 'NVL'
        : 'unknown';
  const platform = /\b(?:GB300|GB200|NVL72)\b/i.exec(text)?.[0].toUpperCase() ?? null;
  const spec = catalogData.skus.find(
    (s) =>
      s.model === model &&
      s.vram_gb === memory &&
      s.form_factor === form &&
      !platform &&
      (!module || s.module_generation === module),
  );
  return {
    gpu_sku_id: spec?.gpu_sku_id ?? null,
    accelerator_model: model,
    vram_gb: memory,
    form_factor: form,
    module_generation: text.match(/\b(SXM\d+)\b/i)?.[1].toUpperCase() ?? null,
    system_platform: platform,
    identification_evidence:
      [model, memory, form === 'unknown' ? null : form, platform].filter(Boolean).join('|') || null,
    classification_version: catalogData.version,
    classification_status: spec ? 'resolved' : 'candidate',
    exclusion_reasons: spec ? [] : ['ambiguous_sku'],
  };
}
export function classifyListing(text: string, condition: GPUSecondary['condition']) {
  const identity = identifyGPU(text),
    reasons = [...identity.exclusion_reasons];
  if (
    /heat\s*sink|heatsink|backplate|bracket|fan only|empty chassis|no gpu|without gpu|barebone|parts only/i.test(
      text,
    )
  )
    reasons.push('accessory_or_no_gpu');
  if (/rental|rent only|per hour|\/hour/i.test(text)) reasons.push('rental_listing');
  if (condition === 'for_parts' || /not working|defective|broken/i.test(text))
    reasons.push('for_parts');
  const count = text.match(
    /\b(\d{1,3})\s*[x×]\s*(?:NVIDIA\s*)?(?:A100|H100|H200|B200|B300)\b/i,
  )?.[1];
  const lot = count ? Number(count) : /\bsingle GPU\b/i.test(text) ? 1 : null;
  const sale_unit = /\bNVL72|rack\b/i.test(text)
    ? 'rack'
    : /\bserver\b/i.test(text)
      ? 'server'
      : lot === 1
        ? 'single_gpu'
        : lot && lot > 1
          ? 'multi_gpu_lot'
          : 'unknown';
  if (sale_unit === 'unknown') reasons.push('sale_unit_unknown');
  if (['server', 'rack'].includes(sale_unit)) reasons.push('bundled_system');
  if (condition === 'unknown') reasons.push('condition_unknown');
  return {
    ...identity,
    classification_status: reasons.some((r) => r !== 'ambiguous_sku' && r !== 'sale_unit_unknown')
      ? ('excluded' as const)
      : identity.classification_status,
    exclusion_reasons: reasons,
    sale_unit: sale_unit as GPUSecondary['sale_unit'],
    gpu_count_in_lot: lot,
  };
}
export function isGPU(dataset: string): dataset is 'gpu_rental' | 'gpu_secondary' {
  return dataset === 'gpu_rental' || dataset === 'gpu_secondary';
}
export function gpuAmount(d: GPUDomain) {
  return 'asking_price' in d ? d.asking_price : d.amount_decimal;
}
export function gpuRecordKey(d: GPUDomain) {
  return 'listing_id' in d
    ? d.listing_id
    : d.price_of_compute
      ? JSON.stringify([
          d.price_of_compute.requested_sku,
          d.provider,
          d.price_of_compute.source_pricing_type,
          d.region,
        ])
      : d.provider + '|' + d.offer_id + '|' + (d.region ?? 'unknown');
}
export function gpuComparison(d: GPUDomain) {
  if ('listing_id' in d)
    return {
      sku: d.gpu_sku_id,
      model: d.accelerator_model,
      vram: d.vram_gb,
      form: d.form_factor,
      platform: d.system_platform,
      condition: d.condition,
      format: d.listing_format,
      sale_unit: d.sale_unit,
      count: d.gpu_count_in_lot,
      currency: d.currency,
      tax: d.tax_status,
      tax_jurisdiction: d.tax_jurisdiction,
      country: d.item_location.country,
      delivery: d.delivery_region,
      warranty: d.warranty_status,
      basis: d.observation_basis,
    };
  return {
    sku: d.gpu_sku_id,
    model: d.accelerator_model,
    vram: d.vram_gb,
    form: d.form_factor,
    platform: d.system_platform,
    provider: d.serving_provider,
    country: d.country,
    region: d.region,
    sale_unit: d.sale_unit,
    count: d.gpu_count,
    contract: d.contract_type,
    ...(d.price_of_compute ? { source_pricing_type: d.price_of_compute.source_pricing_type } : {}),
    interruptible: d.interruptible,
    minimum_term: d.minimum_term,
    commitment: d.commitment,
    minimum_gpu_count: d.minimum_gpu_count,
    sharing: d.dedicated_or_shared,
    includes: d.includes_cpu_ram_storage,
    network: d.network_conditions,
    egress: d.egress_notes,
    currency: d.currency,
    unit: d.billing_unit,
    tax: d.tax_status,
    tax_jurisdiction: d.tax_jurisdiction,
    price_scope: d.price_scope,
    basis: d.observation_basis,
  };
}
export function gpuExclusions(d: GPUDomain) {
  const reasons = [...d.exclusion_reasons];
  if (!d.gpu_sku_id) reasons.push('ambiguous_sku');
  if (gpuAmount(d) === null) reasons.push('price_unknown');
  if (d.secondary_source) reasons.push('secondary_source_not_independent');
  if ('listing_id' in d) {
    if (d.listing_state !== 'seen') reasons.push('not_current_listing');
    if (d.listing_format !== 'fixed_price') reasons.push('not_fixed_ask');
    if (!['single_gpu', 'multi_gpu_lot'].includes(d.sale_unit) || !d.gpu_count_in_lot)
      reasons.push('sale_unit_incomparable');
  } else {
    if (!d.country || !d.region || !d.region_evidence) reasons.push('region_unknown');
    if (d.contract_type === 'unknown' || d.dedicated_or_shared === 'unknown')
      reasons.push('contract_unknown');
    if (d.price_scope !== 'public') reasons.push('non_public_price_scope');
  }
  return [...new Set(reasons)];
}
export interface GPUAdapter {
  readonly source: Source;
  parse(evidence: Evidence): { quotes: GPUQuote[]; issues: string[]; complete: boolean };
}
