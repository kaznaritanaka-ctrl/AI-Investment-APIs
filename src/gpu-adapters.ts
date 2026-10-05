import { parse as parseLossless } from 'lossless-json';
import { type Source, type Evidence, type Candidate } from './schema';
import {
  GPURentalSchema,
  GPUSecondarySchema,
  PriceOfComputeMetadata,
  gpuRecordKey,
  identifyGPU,
  classifyListing,
  type GPURental,
  type GPUSecondary,
} from './gpu';
import { type Partition, validateNextURL } from './request-plan';
import { stable, hash, decimal, D, isoTime, isoDate } from './util';
import { projectPriceOfCompute } from './price-of-compute';
type Obj = Record<string, unknown>;
const object = (v: unknown): Obj => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('gpu_schema_invalid');
  return v as Obj;
};
const str = (v: unknown): string => {
  if (typeof v !== 'string' || !v || v.length > 512) throw new Error('gpu_field_invalid');
  return v;
};
const integer = (v: unknown): number => {
  const n = Number(v);
  if (v === null || v === undefined || !Number.isSafeInteger(n) || n < 0)
    throw new Error('gpu_count_invalid');
  return n;
};
const nullableDate = (v: unknown) =>
  typeof v === 'string' && isoTime(v) ? new Date(v).toISOString() : null;
export function emptyRental(
  provider: string,
  offer: string,
  description: string,
  synthetic: boolean,
): GPURental {
  return {
    provider,
    serving_provider: provider,
    offer_id: offer,
    country: null,
    region: null,
    region_evidence: null,
    ...identifyGPU(description),
    interconnect: null,
    gpu_count: null,
    dedicated_or_shared: 'unknown',
    contract_type: 'unknown',
    interruptible: null,
    minimum_term: null,
    commitment: null,
    amount_decimal: null,
    currency: 'USD',
    billing_unit: 'node_hour',
    includes_cpu_ram_storage: null,
    egress_notes: null,
    tax_status: 'unknown',
    availability_status: 'unknown',
    availability_evidence: null,
    observation_basis: 'advertised_quote',
    synthetic,
    sale_unit: 'unknown',
    price_scope: 'unknown',
    minimum_gpu_count: null,
    network_conditions: null,
    availability_observed_at: null,
    availability_gpu_count: null,
    availability_guaranteed: null,
    origin_source_id: provider,
    origin_offer_id: offer,
    secondary_source: false,
    evidence_pointer: '',
    source_effective_date: null,
    source_effective_until_date: null,
    tax_jurisdiction: null,
    evidence_grade: synthetic ? 'synthetic' : 'source_reported',
  };
}
function ebayItem(value: unknown, synthetic: boolean): GPUSecondary {
  const row = object(value),
    listing_id = str(row.itemId),
    title = str(row.title);
  const names: Record<string, GPUSecondary['condition']> = {
    Used: 'used',
    'Seller refurbished': 'refurbished',
    'Certified Refurbished': 'refurbished',
    'Manufacturer refurbished': 'refurbished',
    New: 'new',
    'New other (see details)': 'open_box',
    'For parts or not working': 'for_parts',
  };
  const condition =
      typeof row.condition === 'string' ? (names[row.condition] ?? 'unknown') : 'unknown',
    classification = classifyListing(title, condition);
  const options = Array.isArray(row.buyingOptions) ? row.buyingOptions : [],
    price = object(row.price);
  const location = row.itemLocation ? object(row.itemLocation) : null,
    country =
      typeof location?.country === 'string' && /^[A-Z]{2}$/.test(location.country)
        ? location.country
        : null;
  const shipping =
    Array.isArray(row.shippingOptions) && row.shippingOptions.length === 1
      ? object(row.shippingOptions[0])
      : null;
  const shippingPrice = shipping?.shippingCost ? object(shipping.shippingCost) : null;
  return GPUSecondarySchema.parse({
    ...classification,
    marketplace: 'eBay',
    listing_id,
    condition,
    listing_format: options.includes('AUCTION')
      ? 'auction'
      : options.includes('FIXED_PRICE')
        ? 'fixed_price'
        : options.includes('BEST_OFFER')
          ? 'best_offer'
          : 'unknown',
    quantity_available_reported: null,
    asking_price: price ? decimal(price.value) : null,
    shipping_price:
      shippingPrice && shippingPrice.currency === price?.currency
        ? decimal(shippingPrice.value)
        : null,
    currency: str(price.currency),
    tax_status: 'unknown',
    tax_jurisdiction: null,
    item_location: { country, evidence: country ? 'itemLocation.country' : null },
    delivery_region: null,
    warranty_status: null,
    source_listed_at: nullableDate(row.itemCreationDate),
    first_seen_at: null,
    last_seen_at: null,
    listing_state: 'seen',
    observation_basis: 'advertised_quote',
    transaction_at: null,
    report_period: null,
    evidence_grade: synthetic ? 'synthetic' : 'source_reported',
    evidence_pointer: 'itemSummaries/' + listing_id,
    origin_source_id: 'ebay',
    origin_offer_id: listing_id,
    secondary_source: false,
    synthetic,
  });
}
export async function gpuEvidenceFromBody(
  s: Source,
  p: Partition,
  snapshot: string,
  scope: string,
  page: number,
  scheduled: string,
  text: string,
  observed: string,
  synthetic: boolean,
): Promise<Evidence> {
  // PoC parses actual LosslessNumber tokens itself. Do not run the generic token-to-string
  // path, which would also turn numeric provider identifiers into apparently valid labels.
  const poc =
    s.adapter === 'price_of_compute' ? projectPriceOfCompute(text, p.query.sku, observed) : null;
  const root = poc ? {} : object(parseLossless(text, undefined, (token) => token));
  if (root.error || root.errors) throw new Error('gpu_error_response');
  const records: (GPURental | GPUSecondary)[] = [],
    issues: string[] = [];
  let total: number | null = null,
    next: number | null = null,
    received = 0;
  const keep = (fn: () => GPURental | GPUSecondary) => {
    try {
      const d = fn();
      if (p.models.length && (!d.accelerator_model || !p.models.includes(d.accelerator_model)))
        d.exclusion_reasons.push('outside_selected_models');
      records.push(d);
    } catch {
      issues.push('invalid_record');
    }
  };
  if (s.adapter === 'ebay_browse') {
    total = integer(root.total);
    const rows = root.itemSummaries === undefined && total === 0 ? [] : root.itemSummaries;
    if (!Array.isArray(rows) || rows.length > s.gpu!.page_size)
      throw new Error('gpu_schema_invalid');
    received = rows.length;
    rows.forEach((row) => keep(() => ebayItem(row, synthetic)));
    if (
      integer(root.offset) !== page * s.gpu!.page_size ||
      integer(root.limit) !== s.gpu!.page_size
    )
      throw new Error('pagination_scope_changed');
    if (root.next) {
      validateNextURL(s, p, page, scheduled, str(root.next));
      next = page + 1;
    } else if (page * s.gpu!.page_size + received < total) issues.push('pagination_incomplete');
  } else if (s.adapter === 'sakura_dok') {
    const meta = object(root.meta),
      rows = root.results;
    if (!Array.isArray(rows) || rows.length > s.gpu!.page_size)
      throw new Error('gpu_schema_invalid');
    if (integer(meta.page) !== page + 1 || integer(meta.page_size) !== s.gpu!.page_size)
      throw new Error('pagination_scope_changed');
    total = integer(meta.count);
    received = rows.length;
    const pages = integer(meta.total_pages);
    if (page + 1 < pages) {
      if (meta.next) validateNextURL(s, p, page, scheduled, str(meta.next));
      next = page + 1;
    } else if (page * s.gpu!.page_size + received < total) issues.push('pagination_incomplete');
    rows.forEach((value, index) =>
      keep(() => {
        const row = object(value),
          plan = str(row.plan),
          m = plan.match(/^(h100|v100)-(\d+)gb$/i);
        const d = emptyRental(
          'sakura',
          plan,
          m ? m[1].toUpperCase() + ' ' + m[2] + 'GB' : plan,
          synthetic,
        );
        if (typeof row.is_overridden !== 'boolean') throw new Error('gpu_schema_invalid');
        Object.assign(d, {
          country: 'JP',
          region: 'is1a',
          region_evidence: s.documentation_url,
          amount_decimal: decimal(row.price),
          currency: 'JPY',
          billing_unit: 'second',
          price_scope: row.is_overridden ? 'account_specific' : 'public',
          source_effective_date:
            typeof row.begin_at === 'string' && isoDate(row.begin_at) ? row.begin_at : null,
          source_effective_until_date:
            typeof row.end_at === 'string' && isoDate(row.end_at) ? row.end_at : null,
          evidence_pointer: 'results/' + index,
        });
        // Date-only rate validity is preserved separately; no midnight effective timestamp.
        if (
          row.end_at !== null &&
          row.end_at !== undefined &&
          (typeof row.end_at !== 'string' || !isoDate(row.end_at))
        )
          throw new Error('invalid_effective_date');
        return GPURentalSchema.parse(d);
      }),
    );
  } else if (s.adapter === 'lambda') {
    const data = object(root.data);
    received = Object.keys(data).length;
    total = received;
    for (const [key, value] of Object.entries(data)) {
      const item = object(value),
        type = object(item.instance_type),
        regions = item.regions_with_capacity_available;
      if (!Array.isArray(regions)) throw new Error('gpu_schema_invalid');
      for (const region of regions.length ? regions : [null])
        keep(() => {
          const d = emptyRental('lambda', str(type.name), str(type.gpu_description), synthetic);
          if (d.offer_id !== key) throw new Error('gpu_identity_mismatch');
          const specs = object(type.specs),
            gpus = integer(specs.gpus);
          if (gpus === 0) throw new Error('gpu_count_invalid');
          Object.assign(d, {
            gpu_count: gpus,
            sale_unit: 'server',
            amount_decimal: new D(decimal(type.price_cents_per_hour)).div(100).toFixed(),
            currency: 'USD',
            billing_unit: 'node_hour',
            includes_cpu_ram_storage: stable({
              vcpus: integer(specs.vcpus),
              ram_gib: integer(specs.memory_gib),
              storage_gib: integer(specs.storage_gib),
            }),
            contract_type: 'on_demand',
            evidence_pointer: 'data/' + key,
            origin_offer_id: key,
          });
          if (region) {
            const r = object(region),
              name = str(r.name),
              known = s.gpu!.region_map[name];
            Object.assign(d, {
              region: name,
              country: known?.country ?? null,
              region_evidence: known?.evidence_ref ?? 'regions_with_capacity_available.name',
              availability_status: 'available',
              availability_evidence:
                'regions_with_capacity_available includes this type; quantity and guarantee unknown',
              availability_observed_at: observed,
            });
          }
          return GPURentalSchema.parse(d);
        });
    }
  } else if (poc) {
    if (page !== 0) throw new Error('pagination_unsupported');
    received = poc.records.length;
    total = received;
    const { records: _rows, ...metadata } = poc;
    // Reject the whole response on a changed contract before evidence persistence.
    for (const [index, row] of poc.records.entries()) {
      const d = emptyRental(
        row.provider,
        row.requested_sku,
        row.source_sku.replaceAll('-', ' '),
        synthetic,
      );
      Object.assign(d, {
        amount_decimal: row.amount_decimal,
        billing_unit: 'gpu_hour',
        region: row.source_region,
        region_evidence: row.source_region ? 'providers/' + index + '/region' : null,
        contract_type:
          row.source_pricing_type === 'community' ? 'unknown' : row.source_pricing_type,
        secondary_source: true,
        origin_source_id: row.origin_source_id,
        origin_offer_id: null,
        evidence_pointer: 'providers/' + index,
        price_of_compute: {
          ...metadata,
          requested_sku: row.requested_sku,
          source_sku: row.source_sku,
          source_pricing_type: row.source_pricing_type,
          source_observed_at: row.source_observed_at,
        },
      });
      if (p.models.length && (!d.accelerator_model || !p.models.includes(d.accelerator_model)))
        d.exclusion_reasons.push('outside_selected_models');
      records.push(GPURentalSchema.parse(d));
    }
  } else throw new Error('gpu_adapter_not_implemented');
  if (records.length > s.max_records) throw new Error('page_record_limit_exceeded');
  if (
    records.some(
      (d) =>
        'source_listed_at' in d && d.source_listed_at !== null && d.source_listed_at > observed,
    )
  )
    issues.push('future_listing_date');
  const { records: _rows, ...pocMetadata } = poc ?? { records: [] };
  const metadata = poc ? PriceOfComputeMetadata.parse(pocMetadata) : null;
  const body = stable({ records, ...(metadata ? { price_of_compute: metadata } : {}) });
  return {
    format: 'gpu_projection_v1',
    body,
    observed_at: observed,
    response_status: 200,
    payload_hash: await hash(text),
    evidence_hash: await hash(body),
    bytes: new TextEncoder().encode(text).length,
    etag: null,
    last_modified: null,
    synthetic,
    source_id: s.source_id,
    source_policy_version: s.policy.version,
    gpu_page: {
      snapshot_id: snapshot,
      partition_id: p.id,
      scope_hash: scope,
      page_number: page,
      next_page: next,
      reported_total: total,
      received_count: received,
      complete: issues.length === 0,
      issues: [...new Set(issues)],
    },
  };
}
export function parseGPUProjection(s: Source, e: Evidence): Candidate[] {
  if (e.format !== 'gpu_projection_v1' || !e.gpu_page) throw new Error('gpu_evidence_invalid');
  const root = object(JSON.parse(e.body));
  if (!Array.isArray(root.records) || root.records.length > s.max_records)
    throw new Error('gpu_evidence_invalid');
  const metadata =
    s.adapter === 'price_of_compute' ? PriceOfComputeMetadata.parse(root.price_of_compute) : null;
  if (
    metadata &&
    (metadata.retrieved_at !== e.observed_at ||
      metadata.source_day > e.observed_at.slice(0, 10) ||
      Date.parse(metadata.source_updated_at) > Date.parse(e.observed_at))
  )
    throw new Error('gpu_source_time_mismatch');
  const partition = s.gpu?.partitions.find((p) => p.id === e.gpu_page!.partition_id);
  if (
    metadata &&
    metadata.source_url !== 'https://priceofcompute.com/api/v1/prices/' + partition?.query.sku
  )
    throw new Error('gpu_source_metadata_mismatch');
  return root.records.map((value) => {
    const domain =
      s.dataset_type === 'gpu_rental'
        ? GPURentalSchema.parse(value)
        : s.dataset_type === 'gpu_secondary'
          ? GPUSecondarySchema.parse(value)
          : null;
    if (!domain) throw new Error('gpu_dataset_mismatch');
    if (domain.synthetic !== e.synthetic) throw new Error('synthetic_origin_mismatch');
    const poc = 'price_of_compute' in domain ? domain.price_of_compute : undefined;
    if (s.adapter === 'price_of_compute') {
      if (
        !poc ||
        !metadata ||
        stable({
          projection: poc.projection,
          source_id: poc.source_id,
          source_url: poc.source_url,
          source_day: poc.source_day,
          source_updated_at: poc.source_updated_at,
          retrieved_at: poc.retrieved_at,
          attribution: poc.attribution,
        }) !== stable(metadata)
      )
        throw new Error('gpu_source_metadata_mismatch');
      if (
        poc.requested_sku !== partition?.query.sku ||
        poc.source_sku.toLowerCase() !== poc.requested_sku ||
        poc.source_url !== 'https://priceofcompute.com/api/v1/prices/' + poc.requested_sku ||
        (poc.source_observed_at && Date.parse(poc.source_observed_at) > Date.parse(e.observed_at))
      )
        throw new Error('gpu_source_metadata_mismatch');
    } else if (poc) throw new Error('gpu_source_metadata_mismatch');
    const key = gpuRecordKey(domain);
    return {
      dataset: s.dataset_type as 'gpu_rental' | 'gpu_secondary',
      domain,
      entity_key: key,
      source_record_key: key,
      source_date: poc?.source_day ?? null,
      // Source update time is retained explicitly; it is not an established publication time.
      source_published_at: null,
      source_effective_at: null,
      observation_basis: domain.observation_basis,
      quality_flags: poc
        ? [
            ...('amount_decimal' in domain && domain.amount_decimal === '0'
              ? ['zero_price_reported']
              : []),
            ...(poc.source_observed_at ? [] : ['provider_observation_time_missing']),
          ]
        : [],
    };
  });
}
