import { z } from 'zod';
import { GPUIdentity, identifyGPU } from '../gpu';
import { DecimalString } from '../schema';
import { D, isoDate, stable } from '../util';

// An intake contract, not permission to crawl or a claim that a provider offers this feed.
export const DomesticGPUIntakeSchema = z
  .object({
    source_id: z.enum(['highreso', 'sakura_dok', 'rebro']),
    record_key: z.string().min(1).max(120),
    reported_product: z.string().min(1).max(160),
    observation_kind: z.enum([
      'rental_quote',
      'buy_quote',
      'buy_execution_report',
      'sell_quote',
      'sell_execution_report',
    ]),
    basis: z.enum(['provider_public_quote', 'selected_public_case', 'permissioned_feed']),
    listing_state: z.enum(['seen', 'not_seen']),
    observed_at: z.iso.datetime(),
    source_published_at: z.iso.datetime().nullable(),
    source_period: z
      .string()
      .regex(/^\d{4}-(0[1-9]|1[0-2])(?:-(0[1-9]|[12]\d|3[01]))?$/)
      .nullable(),
    source_period_precision: z.enum(['day', 'month']).nullable(),
    transaction_at: z.iso.datetime().nullable(),
    execution_evidence_ref: z.string().min(1).nullable(),
    evidence_ref: z.string().min(1),
    policy_version: z.string().min(1),
    terms_version: z.string().min(1),
    amount_decimal: DecimalString.nullable(),
    missing_reason: z.enum(['not_reported', 'no_current_listing']).nullable(),
    currency: z.enum(['JPY', 'USD']).nullable(),
    unit: z.enum([
      'gpu_hour',
      'gpu_minute',
      'second',
      'month',
      'lot',
      'gpu',
      'points_per_gpu_minute',
    ]),
    sale_unit: z.enum(['single_gpu', 'multi_gpu_lot', 'server', 'rack', 'unknown']),
    gpu_count: z.number().int().positive().nullable(),
    condition: z.enum(['new', 'used', 'refurbished', 'for_parts', 'unknown']),
    country: z
      .string()
      .regex(/^[A-Z]{2}$/)
      .nullable(),
    region: z.string().nullable(),
    region_evidence_ref: z.string().min(1).nullable(),
    contract: z.enum(['on_demand', 'spot', 'reserved', 'monthly', 'unknown']),
    dedicated_or_shared: z.enum(['dedicated', 'shared', 'unknown']),
    interruptible: z.boolean().nullable(),
    minimum_term: z.string().nullable(),
    tax_status: z.enum(['included', 'excluded', 'unknown']),
    availability: z.enum(['available', 'unavailable', 'unknown']),
    availability_evidence_ref: z.string().min(1).nullable(),
    price_scope: z.enum(['public', 'account_specific', 'promotion', 'unknown']),
    synthetic: z.boolean(),
  })
  .strict()
  .superRefine((v, c) => {
    const issue = (message: string) => c.addIssue({ code: 'custom', message });
    if ((v.country || v.region) && !v.region_evidence_ref) issue('region_evidence_required');
    if (v.availability !== 'unknown' && !v.availability_evidence_ref)
      issue('availability_evidence_required');
    if ((v.amount_decimal === null) !== (v.missing_reason !== null))
      issue('missing_reason_required');
    if ((v.unit === 'points_per_gpu_minute') !== (v.currency === null))
      issue('points_are_not_currency');
    if (
      v.listing_state === 'not_seen' &&
      (v.amount_decimal !== null ||
        v.missing_reason !== 'no_current_listing' ||
        v.observation_kind.endsWith('execution_report') ||
        v.transaction_at)
    )
      issue('not_seen_does_not_prove_sale');
    if (v.observation_kind.endsWith('execution_report') && !v.execution_evidence_ref)
      issue('execution_evidence_required');
    if (v.observation_kind.endsWith('execution_report') && v.basis === 'provider_public_quote')
      issue('quote_is_not_execution');
    if (v.sale_unit === 'single_gpu' && v.gpu_count !== null && v.gpu_count !== 1)
      issue('single_gpu_count_mismatch');
    if (
      !v.observation_kind.endsWith('execution_report') &&
      (v.transaction_at || v.execution_evidence_ref)
    )
      issue('quote_is_not_execution');
    if (v.source_id !== 'rebro' && v.observation_kind !== 'rental_quote')
      issue('source_basis_mismatch');
    if (v.source_id === 'rebro' && v.observation_kind === 'rental_quote')
      issue('source_basis_mismatch');
    if (
      (v.source_period === null) !== (v.source_period_precision === null) ||
      (v.source_period &&
        v.source_period.length !== (v.source_period_precision === 'month' ? 7 : 10))
    )
      issue('date_precision_mismatch');
    if (v.source_period?.length === 10 && !isoDate(v.source_period)) issue('invalid_source_date');
  });
export type DomesticGPUIntake = z.infer<typeof DomesticGPUIntakeSchema>;
export function normalizeDomesticGPU(input: unknown) {
  const row = DomesticGPUIntakeSchema.parse(input);
  const identity = GPUIdentity.parse(identifyGPU(row.reported_product));
  if (identity.system_platform && row.sale_unit === 'single_gpu')
    throw new Error('rack_is_not_single_gpu');
  return { ...row, identity, coverage: 'one_provider_observed_records' as const };
}
export function compareDomesticGPU(before: unknown, after: unknown) {
  const a = normalizeDomesticGPU(before),
    b = normalizeDomesticGPU(after);
  if (b.listing_state === 'not_seen')
    return { state: 'not_seen', change_percent: null, warning: null };
  const known = (r: typeof a) =>
    r.identity.classification_status === 'resolved' &&
    r.sale_unit !== 'unknown' &&
    r.gpu_count !== null &&
    r.tax_status !== 'unknown' &&
    r.country !== null &&
    r.region !== null &&
    r.price_scope !== 'unknown' &&
    (r.observation_kind === 'rental_quote'
      ? r.contract !== 'unknown' && r.dedicated_or_shared !== 'unknown' && r.interruptible !== null
      : r.condition !== 'unknown');
  if (!known(a) || !known(b))
    return { state: 'not_comparable', change_percent: null, warning: null };
  const cohort = (r: typeof a) => [
    r.source_id,
    r.record_key,
    r.observation_kind,
    r.basis,
    r.identity,
    r.sale_unit,
    r.gpu_count,
    r.condition,
    r.country,
    r.region,
    r.contract,
    r.dedicated_or_shared,
    r.interruptible,
    r.minimum_term,
    r.tax_status,
    r.unit,
    r.currency,
    r.price_scope,
  ];
  if (stable(cohort(a)) !== stable(cohort(b)))
    return { state: 'not_comparable', change_percent: null, warning: null };
  if (a.amount_decimal === null || b.amount_decimal === null || new D(a.amount_decimal).isZero())
    return { state: 'insufficient_data', change_percent: null, warning: null };
  const change = new D(b.amount_decimal).minus(a.amount_decimal).div(a.amount_decimal).times(100);
  return {
    state: 'observed_change',
    change_percent: change.toFixed(),
    warning: change.abs().gt(50) ? 'large_change_review' : null,
  };
}
