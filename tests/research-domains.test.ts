import { describe, expect, it } from 'vitest';
import {
  normalizeDomesticGPU,
  compareDomesticGPU,
  type DomesticGPUIntake,
} from '../src/research/domestic-gpu';
import { DCDisclosureSchema, disclosureRevision } from '../src/research/disclosures';
import { researchFixture, researchTime } from './research-helpers';

function gpu(source_id: DomesticGPUIntake['source_id'] = 'rebro'): DomesticGPUIntake {
  return {
    source_id,
    record_key: 'synthetic-offer-001',
    reported_product: 'A100 80GB PCIe',
    observation_kind: source_id === 'rebro' ? 'buy_quote' : 'rental_quote',
    basis: 'provider_public_quote',
    listing_state: 'seen',
    observed_at: researchTime,
    source_published_at: null,
    source_period: '2026-10',
    source_period_precision: 'month',
    transaction_at: null,
    execution_evidence_ref: null,
    evidence_ref: 'synthetic:offer-001',
    policy_version: 'synthetic-policy',
    terms_version: 'synthetic-terms',
    amount_decimal: '123.456',
    missing_reason: null,
    currency: 'JPY',
    unit: source_id === 'rebro' ? 'lot' : 'gpu_hour',
    sale_unit: 'single_gpu',
    gpu_count: 1,
    condition: 'unknown',
    country: null,
    region: null,
    region_evidence_ref: null,
    contract: 'unknown',
    dedicated_or_shared: 'unknown',
    interruptible: null,
    minimum_term: null,
    tax_status: 'unknown',
    availability: 'unknown',
    availability_evidence_ref: null,
    price_scope: 'public',
    synthetic: true,
  };
}
describe('domestic GPU intake and DC disclosure history (all synthetic)', () => {
  it('reuses GPU classification without inventing regional, SKU or transaction facts', () => {
    for (const id of ['highreso', 'sakura_dok', 'rebro'] as const) {
      const row = normalizeDomesticGPU(gpu(id));
      expect(row.identity.accelerator_model).toBe('A100');
      expect(row.country).toBeNull();
      expect(row.transaction_at).toBeNull();
      expect(row.coverage).toBe('one_provider_observed_records');
    }
    const unknown = normalizeDomesticGPU({ ...gpu(), reported_product: 'H100' });
    expect(unknown.identity.vram_gb).toBeNull();
    expect(unknown.identity.form_factor).toBe('unknown');
    expect(() =>
      normalizeDomesticGPU({ ...gpu('sakura_dok'), region: 'is1a', country: 'JP' }),
    ).toThrow('region_evidence_required');
    expect(() => normalizeDomesticGPU({ ...gpu(), reported_product: 'GB300 NVL72 rack' })).toThrow(
      'rack_is_not_single_gpu',
    );
    expect(
      normalizeDomesticGPU({
        ...gpu(),
        reported_product: 'GB300 NVL72 rack',
        sale_unit: 'rack',
        gpu_count: null,
      }).identity.system_platform,
    ).toBe('GB300');
  });
  it('keeps four dealer price meanings, public cases and month precision distinct', () => {
    for (const kind of [
      'buy_quote',
      'buy_execution_report',
      'sell_quote',
      'sell_execution_report',
    ] as const) {
      const v = normalizeDomesticGPU({
        ...gpu(),
        observation_kind: kind,
        basis: kind.endsWith('execution_report') ? 'selected_public_case' : 'provider_public_quote',
        execution_evidence_ref: kind.endsWith('execution_report')
          ? 'synthetic:reported-case'
          : null,
      });
      expect(v.observation_kind).toBe(kind);
      expect(v.source_period).toBe('2026-10');
      expect(v.transaction_at).toBeNull();
    }
    expect(() =>
      normalizeDomesticGPU({ ...gpu(), observation_kind: 'buy_execution_report' }),
    ).toThrow('execution_evidence_required');
    expect(() => normalizeDomesticGPU({ ...gpu(), transaction_at: researchTime })).toThrow(
      'quote_is_not_execution',
    );
    expect(() =>
      normalizeDomesticGPU({
        ...gpu(),
        source_period: '2026-02-30',
        source_period_precision: 'day',
      }),
    ).toThrow('invalid_source_date');
  });
  it('does not equate points/minutes with currency/hour; comparisons require matching conditions', () => {
    const a: DomesticGPUIntake = {
        ...gpu('highreso'),
        tax_status: 'excluded',
        country: 'JP',
        region: 'synthetic-region',
        region_evidence_ref: 'synthetic:region',
        contract: 'on_demand',
        dedicated_or_shared: 'dedicated',
        interruptible: false,
      },
      b = { ...a, amount_decimal: '400' };
    expect(compareDomesticGPU(a, b)).toMatchObject({
      state: 'observed_change',
      warning: 'large_change_review',
    });
    expect(compareDomesticGPU(a, { ...b, tax_status: 'included' })).toMatchObject({
      state: 'not_comparable',
    });
    expect(
      compareDomesticGPU(a, {
        ...b,
        country: 'JP',
        region: 'synthetic-site',
        region_evidence_ref: 'synthetic:region',
      }),
    ).toMatchObject({ state: 'not_comparable' });
    expect(compareDomesticGPU(a, { ...b, unit: 'gpu_minute' })).toMatchObject({
      state: 'not_comparable',
    });
    expect(
      normalizeDomesticGPU({ ...a, unit: 'points_per_gpu_minute', currency: null }).currency,
    ).toBeNull();
    expect(() => normalizeDomesticGPU({ ...a, unit: 'points_per_gpu_minute' })).toThrow(
      'points_are_not_currency',
    );
    expect(
      compareDomesticGPU(a, { ...a, amount_decimal: null, missing_reason: 'not_reported' }).state,
    ).toBe('insufficient_data');
  });
  it('does not infer a sale or zero price from listing disappearance or API failure', () => {
    const gone = {
      ...gpu(),
      listing_state: 'not_seen',
      amount_decimal: null,
      missing_reason: 'no_current_listing',
    };
    expect(compareDomesticGPU(gpu(), gone)).toEqual({
      state: 'not_seen',
      change_percent: null,
      warning: null,
    });
    expect(() =>
      normalizeDomesticGPU({
        ...gone,
        observation_kind: 'buy_execution_report',
        execution_evidence_ref: 'synthetic:case',
      }),
    ).toThrow('not_seen_does_not_prove_sale');
    expect(() => normalizeDomesticGPU({ ...gone, amount_decimal: '0' })).toThrow();
  });
  it('keeps DC revisions immutable, with separate water measures and no invented capacity from grant decisions', async () => {
    const first = DCDisclosureSchema.parse(JSON.parse(researchFixture('dc.synthetic.json')));
    const saved = await disclosureRevision(first);
    expect(saved.previous_observation_id).toBeNull();
    expect(first.water.map((x) => x.measure_kind)).toEqual([
      'withdrawal',
      'consumption',
      'discharge',
    ]);
    expect(first.water.every((x) => x.amount_decimal === null)).toBe(true);
    const next = {
      ...first,
      event_kind: 'revision',
      observed_at: '2026-10-16T01:00:00.000Z',
      recorded_at: '2026-10-16T01:00:00.000Z',
    };
    const revised = await disclosureRevision(next, first);
    expect(revised.previous_observation_id).toBe(saved.observation_id);
    expect(revised.observation_id).not.toBe(saved.observation_id);
    const bad = structuredClone(first);
    bad.portfolio.capacity_observations[0].measure_kind = 'it_operational_mw';
    expect(() => DCDisclosureSchema.parse(bad)).toThrow('grant_does_not_prove_capacity');
    bad.portfolio.capacity_observations[0].measure_kind = 'planned_mw';
    bad.water[0].scope_id = 'absent';
    expect(() => DCDisclosureSchema.parse(bad)).toThrow('water_scope_missing');
    await expect(
      disclosureRevision({ ...next, disclosure_id: 'different-project' }, first),
    ).rejects.toThrow('disclosure_lineage_mismatch');
  });
});
