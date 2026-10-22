import { z } from 'zod';
import { DCEvidenceSchema, DCPhaseSchema, DCProjectSchema, DCSiteSchema } from '../dc';
import { DecimalString } from '../schema';
import { hash, stable } from '../util';
import type { ResearchConfig } from './schema';

const id = z.string().trim().min(1).max(120);
const quote = z.string().trim().min(1).max(500);
export const DCChangeSchema = z
  .object({
    kind: z.enum(['delay', 'downsize', 'cancel', 'upsize', 'acceleration']),
    reason_code: z.enum([
      'power',
      'financing',
      'permit',
      'supply_chain',
      'demand_stated_by_operator',
      'other_stated',
      'unknown',
    ]),
    reason_quote: quote.nullable(),
    operator_stated: z.boolean(),
  })
  .strict()
  .transform((v) =>
    v.operator_stated && v.reason_quote
      ? v
      : {
          ...v,
          reason_code: 'unknown' as const,
          reason_quote: null,
          operator_stated: false,
        },
  );
export const DCFinancingSchema = z
  .object({
    project_id: id.nullable(),
    entity_id: id.nullable(),
    instrument: z.enum(['loan', 'bond', 'equity', 'lease', 'subsidy']),
    amount_decimal: DecimalString.max(80).nullable(),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .nullable(),
    maturity: z.iso.date().nullable(),
    collateral_text: quote.nullable(),
    admin_event_id: id.nullable(), // Reference only; no cross-database FK or public projection.
    disclosed_vs_inferred: z.literal('disclosed'),
  })
  .strict()
  .superRefine((v, c) => {
    if ((!v.project_id && !v.entity_id) || (v.amount_decimal === null) !== (v.currency === null))
      c.addIssue({ code: 'custom', message: 'financing_disclosure_required' });
  });
export const DCTrackerRecordSchema = z
  .object({
    record_key: id,
    disclosure_id: id,
    entity: z
      .object({
        entity_id: id,
        name_ja: quote,
        corporate_number: z
          .string()
          .regex(/^\d{13}$/)
          .nullable(),
      })
      .strict()
      .nullable(),
    project: DCProjectSchema.omit({ evidence: true }).extend({
      project_id: id,
      name: quote,
      prefecture: quote.nullable(),
      tracked_since: z.iso.date(),
      tracking_status: z.enum(['active', 'paused']),
    }),
    site: DCSiteSchema.omit({ evidence: true }).nullable(),
    phase: DCPhaseSchema.omit({ evidence: true }).nullable(),
    field: z.enum([
      'disclosure',
      'status',
      'planned_service_date',
      'actual_service_date',
      'planned_mw',
      'contracted_mw',
      'energized_mw',
      'it_operational_mw',
      'financing',
    ]),
    scope: z.enum(['project', 'site', 'phase']),
    scope_id: id,
    value_text: quote.nullable(),
    value_decimal: DecimalString.max(80).nullable(),
    unit: z.literal('MW').nullable(),
    as_of_date: z.iso.date(),
    evidence: DCEvidenceSchema.extend({
      basis: z.enum(['announced', 'contracted', 'official_operational_report']),
      evidence_ref: id,
    }),
    evidence_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    evidence_level: z.enum(['primary_disclosure', 'official_registry']),
    source_quote: quote.nullable(),
    drafted_by: z.enum(['deterministic', 'ai_codex', 'ai_claude', 'kaz']),
    status: z.literal('draft'),
    change: DCChangeSchema.nullable(),
    financing: DCFinancingSchema.nullable(),
  })
  .strict()
  .superRefine((v, c) => {
    const issue = (message: string) => c.addIssue({ code: 'custom', message });
    if (v.field !== 'disclosure' && !v.source_quote) issue('dc_quote_required');
    if (v.site && v.site.project_id !== v.project.project_id) issue('dc_site_scope_mismatch');
    if (v.phase && (!v.site || v.phase.site_id !== v.site.site_id))
      issue('dc_phase_scope_mismatch');
    if (
      v.scope_id !==
      (v.scope === 'project'
        ? v.project.project_id
        : v.scope === 'site'
          ? v.site?.site_id
          : v.phase?.phase_id)
    )
      issue('dc_observation_scope_mismatch');
    if (v.project.operator_entity_id && v.project.operator_entity_id !== v.entity?.entity_id)
      issue('dc_operator_missing');
    if (v.field.endsWith('_mw')) {
      if (v.value_decimal === null || v.value_text !== null || v.unit !== 'MW')
        issue('dc_capacity_definition_required');
    } else if (v.value_decimal !== null || v.unit !== null) issue('dc_noncapacity_decimal');
    if (
      v.field === 'status' &&
      (!v.phase || v.value_text !== v.phase.status || v.scope !== 'phase')
    )
      issue('dc_status_mismatch');
    if (
      ['planned_service_date', 'actual_service_date'].includes(v.field) &&
      (!v.phase ||
        v.scope !== 'phase' ||
        v.value_text !== v.phase[v.field as 'planned_service_date' | 'actual_service_date'] ||
        !z.iso.date().safeParse(v.value_text).success)
    )
      issue('dc_date_mismatch');
    if ((v.field === 'financing') !== (v.financing !== null)) issue('dc_financing_field_mismatch');
    if (
      v.financing &&
      ((v.financing.project_id && v.financing.project_id !== v.project.project_id) ||
        (v.financing.entity_id && v.financing.entity_id !== v.entity?.entity_id))
    )
      issue('dc_financing_scope_mismatch');
  });
export type DCTrackerRecord = z.infer<typeof DCTrackerRecordSchema>;
export const DCTrackerPageSchema = z
  .object({
    page: z.number().int().nonnegative(),
    records: z.array(DCTrackerRecordSchema).max(20),
    reported_total: z.number().int().nonnegative(),
    next_page: z.number().int().positive().nullable(),
    coverage: z.enum(['complete', 'partial']),
    reasons: z.array(z.enum(['more_pages', 'page_limit', 'source_empty'])),
  })
  .strict();

// This is a reviewed projection format, not an invented provider wire format.
// The live adapter emits this projection; source pages cannot supply records directly.
export async function parseDCTracker(config: ResearchConfig, text: string, pageNumber: number) {
  if (config.scope.kind !== 'dc_tracker' || pageNumber < 0 || pageNumber >= config.limits.max_pages)
    throw new Error('dc_tracker_scope_invalid');
  if (new TextEncoder().encode(text).length > Math.min(config.source.max_bytes, 131072))
    throw new Error('response_too_large');
  const page = DCTrackerPageSchema.parse(JSON.parse(text));
  const offset = pageNumber * config.limits.page_size;
  if (
    page.page !== pageNumber ||
    page.records.length !==
      Math.min(config.limits.page_size, Math.max(0, page.reported_total - offset)) ||
    (pageNumber > 0 && offset >= page.reported_total) ||
    page.reported_total > config.limits.max_input_rows
  )
    throw new Error('dc_tracker_coverage_mismatch');
  const more = offset + page.records.length < page.reported_total;
  const next = more && pageNumber + 1 < config.limits.max_pages ? pageNumber + 1 : null;
  const coverage = more || page.reported_total === 0 ? 'partial' : 'complete';
  const reasons = more
    ? [next === null ? 'page_limit' : 'more_pages']
    : page.reported_total === 0
      ? ['source_empty']
      : [];
  if (
    page.next_page !== next ||
    page.coverage !== coverage ||
    stable(page.reasons) !== stable(reasons)
  )
    throw new Error('dc_tracker_coverage_mismatch');
  const keys = new Set<string>();
  for (const record of page.records) {
    if (
      !config.scope.project_ids.includes(record.project.project_id) ||
      record.evidence.source_id !== config.source.source_id ||
      record.evidence.source_policy_version !== config.source.policy.version ||
      new URL(record.evidence.source_url).origin !== new URL(config.source.source_url).origin
    )
      throw new Error('dc_tracker_source_scope_mismatch');
    if (
      (record.drafted_by === 'ai_codex' || record.drafted_by === 'ai_claude') &&
      config.source.policy.rights.external_llm_processing !== 'allowed'
    )
      throw new Error('dc_external_llm_review_required');
    // Publisher ID + scope + field, independent of crawl time, ordering or revised value.
    const key = await hash(
      stable([
        config.source.source_id,
        record.disclosure_id,
        record.scope,
        record.scope_id,
        record.field,
      ]),
    );
    if (record.record_key !== key || keys.has(key))
      throw new Error('dc_tracker_record_key_mismatch');
    keys.add(key);
  }
  return page;
}

// Capture timestamps and drafting provenance do not revise the publisher's facts.
export async function dcTrackerFingerprint(record: DCTrackerRecord) {
  const { observed_at: _observed, evidence_ref: _ref, ...evidence } = record.evidence;
  const { drafted_by: _author, ...facts } = record;
  return hash(
    stable({
      ...facts,
      // Disclosure capture has no publisher as-of date; the crawl day is metadata.
      ...(record.field === 'disclosure' ? { as_of_date: null } : {}),
      evidence,
    }),
  );
}
