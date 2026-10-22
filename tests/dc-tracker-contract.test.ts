import { describe, expect, it } from 'vitest';
import {
  DCTrackerRecordSchema,
  parseDCTracker,
  dcTrackerFingerprint,
} from '../src/research/dc-tracker-schema';
import { dcReviewWeek, dcWeeklyReviewDue } from '../src/research/dc-tracker';
import { ResearchConfigSchema, assertResearchAllowed } from '../src/research/schema';
import { dcConfig, dcPage, dcRecord, dcTime } from './dc-tracker-helpers';
import proposal from '../config/proposals/research/meti_dc_tracker.json';

describe('DC tracker offline contracts (no D1 runtime)', () => {
  it('enforces official evidence, exact scope, quoted AI drafts, reason unknown and disclosed financing', async () => {
    const r = await dcRecord();
    for (const basis of ['third_party_report', 'estimate'])
      expect(
        DCTrackerRecordSchema.safeParse({ ...r, evidence: { ...r.evidence, basis } }).success,
      ).toBe(false);
    expect(DCTrackerRecordSchema.safeParse({ ...r, source_quote: '' }).success).toBe(false);
    expect(
      DCTrackerRecordSchema.safeParse({ ...r, evidence: { ...r.evidence, source_url: '' } })
        .success,
    ).toBe(false);
    expect(
      DCTrackerRecordSchema.safeParse({ ...r, site: { ...r.site, project_id: 'wrong' } }).success,
    ).toBe(false);
    const unknown = DCTrackerRecordSchema.parse({
      ...r,
      change: {
        kind: 'delay',
        reason_code: 'demand_stated_by_operator',
        reason_quote: null,
        operator_stated: false,
      },
    });
    expect(unknown.change?.reason_code).toBe('unknown');
    const finance = {
      project_id: r.project.project_id,
      entity_id: null,
      instrument: 'loan',
      amount_decimal: '100.00',
      currency: 'JPY',
      maturity: null,
      collateral_text: null,
      admin_event_id: null,
      disclosed_vs_inferred: 'inferred',
    };
    expect(
      DCTrackerRecordSchema.safeParse({
        ...r,
        field: 'financing',
        value_text: null,
        financing: finance,
      }).success,
    ).toBe(false);
    await expect(
      parseDCTracker(dcConfig(), dcPage([{ ...r, drafted_by: 'ai_codex' }]), 0),
    ).rejects.toThrow('dc_external_llm_review_required');
    await expect(
      parseDCTracker(dcConfig(), dcPage([{ ...r, record_key: 'unstable' }]), 0),
    ).rejects.toThrow('dc_tracker_record_key_mismatch');
  });

  it('does not mistake a crawl time or drafting author for a changed disclosure', async () => {
    const a = await dcRecord(),
      b = structuredClone(a);
    b.evidence.observed_at = '2026-10-23T01:00:00.000Z';
    b.evidence.evidence_ref = 'synthetic-second-capture';
    b.drafted_by = 'ai_claude';
    expect(await dcTrackerFingerprint(a)).toBe(await dcTrackerFingerprint(b));
    b.value_text = '2029-01-01';
    b.phase!.planned_service_date = b.value_text;
    expect(await dcTrackerFingerprint(a)).not.toBe(await dcTrackerFingerprint(b));
  });
  it('keeps capacity definitions and precision and rejects numeric or mixed units', async () => {
    const r = await dcRecord(dcTime, 'planned_mw');
    r.value_decimal = '10.000';
    expect(DCTrackerRecordSchema.parse(r).value_decimal).toBe('10.000');
    for (const value of [10, '1e3', '-1'])
      expect(DCTrackerRecordSchema.safeParse({ ...r, value_decimal: value }).success).toBe(false);
    expect(DCTrackerRecordSchema.safeParse({ ...r, unit: 'kW' }).success).toBe(false);
    expect(DCTrackerRecordSchema.safeParse({ ...r, value_text: '10 MW' }).success).toBe(false);
    expect(
      DCTrackerRecordSchema.safeParse({ ...r, scope: 'project', scope_id: r.site!.site_id })
        .success,
    ).toBe(false);
  });
  it('checks the independent AI grant, publisher scope, complete snapshots and stable record key', async () => {
    const c = dcConfig(),
      r = await dcRecord();
    c.source.policy.rights.external_llm_processing = 'allowed';
    const page = await parseDCTracker(c, dcPage([{ ...r, drafted_by: 'ai_claude' }]), 0);
    expect(page.records[0].drafted_by).toBe('ai_claude');
    await expect(
      parseDCTracker(
        c,
        dcPage([
          { ...r, evidence: { ...r.evidence, source_url: 'https://other.invalid/release' } },
        ]),
        0,
      ),
    ).rejects.toThrow('dc_tracker_source_scope_mismatch');
    await expect(parseDCTracker(c, dcPage([r], 0, 2, null, 'complete'), 0)).rejects.toThrow(
      'dc_tracker_coverage_mismatch',
    );
    await expect(parseDCTracker(c, dcPage([r, r]), 0)).rejects.toThrow(
      'dc_tracker_record_key_mismatch',
    );
    c.limits.max_pages = 1;
    c.limits.page_size = 1;
    expect((await parseDCTracker(c, dcPage([r], 0, 2, null, 'partial'), 0)).coverage).toBe(
      'partial',
    );
  });
  it('fails closed on unknown rights, reviews, storage modes and dates', () => {
    const p = ResearchConfigSchema.parse(proposal);
    expect(() => assertResearchAllowed(p, dcTime, p.terms.version)).toThrow('policy_blocked');
    for (const right of ['automated_collection', 'private_storage', 'internal_analysis'] as const) {
      const c = dcConfig();
      c.source.policy.rights[right] = 'review_required';
      expect(() => assertResearchAllowed(c, dcTime, c.terms.version)).toThrow('policy_blocked');
    }
    const c = dcConfig();
    c.retention.normalized_mode = 'unapproved';
    expect(() => assertResearchAllowed(c, dcTime, c.terms.version)).toThrow(
      'retention_review_required',
    );
    c.retention.normalized_mode = 'until_revoked';
    c.retention.normalized_days = null;
    expect(() => assertResearchAllowed(c, dcTime, c.terms.version)).toThrow(
      'retention_review_required',
    );
    c.retention.ongoing_storage = {
      basis_ref: 'synthetic-continuing-storage',
      owner_approval_ref: 'synthetic-owner',
    };
    expect(() => assertResearchAllowed(c, dcTime, c.terms.version)).not.toThrow();
    expect(() => assertResearchAllowed(c, c.terms.review_after, c.terms.version)).toThrow(
      'terms_review_required',
    );
  });
  it('preserves planned and actual dates separately and accepts the three added phase states', async () => {
    const r = await dcRecord(dcTime, 'actual_service_date');
    r.value_text = '2026-10-21';
    r.phase!.actual_service_date = r.value_text;
    const parsed = DCTrackerRecordSchema.parse(r);
    expect(parsed.phase).toMatchObject({
      planned_service_date: '2028-01-01',
      actual_service_date: '2026-10-21',
    });
    for (const status of ['land', 'permit', 'grid_connection'] as const) {
      expect(
        DCTrackerRecordSchema.parse({
          ...r,
          field: 'status',
          value_text: status,
          phase: { ...r.phase, status },
        }).phase?.status,
      ).toBe(status);
    }
  });
  it('uses UTC Monday, not the JST date, to identify weeks without adding a scheduler', () => {
    expect(dcReviewWeek('2026-10-25T15:00:00.000Z')).toBe('2026-10-19');
    expect(dcWeeklyReviewDue('2026-10-26T00:00:00.000Z', '2026-10-25T23:59:59.000Z')).toBe(true);
    expect(dcWeeklyReviewDue('2026-10-26T10:00:00.000Z', '2026-10-26T00:00:00.000Z')).toBe(false);
    expect(dcWeeklyReviewDue(dcTime, null)).toBe(true);
    expect(() => dcWeeklyReviewDue('invalid', null)).toThrow();
    expect(() => dcWeeklyReviewDue(dcTime, '2027-01-01T00:00:00.000Z')).toThrow();
  });
});
