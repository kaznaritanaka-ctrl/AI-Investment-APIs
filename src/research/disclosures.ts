import { z } from 'zod';
import { DCPortfolioSchema } from '../dc';
import { DecimalString } from '../schema';
import { hash, stable } from '../util';

// Candidate series: METI DC infrastructure grant decisions, not operational capacity.
// No crawler, real document body or newly approved rights are included.
export const DCDisclosureSchema = z
  .object({
    series_id: z.literal('meti_dc_infrastructure_decisions'),
    source_id: z.string().min(1),
    source_url: z.url(),
    source_published_at: z.iso.datetime().nullable(),
    source_date: z.iso.date().nullable(),
    observed_at: z.iso.datetime(),
    recorded_at: z.iso.datetime(),
    policy_version: z.string().min(1),
    terms_version: z.string().min(1),
    evidence_ref: z.string().min(1),
    method_version: z.literal('dc-disclosure-history-v1'),
    event_kind: z.enum(['grant_decision', 'plan', 'revision', 'operational_report']),
    disclosure_id: z.string().min(1),
    portfolio: DCPortfolioSchema,
    water: z
      .array(
        z
          .object({
            scope: z.enum(['project', 'site', 'phase']),
            scope_id: z.string().min(1),
            measure_kind: z.enum(['withdrawal', 'consumption', 'discharge']),
            amount_decimal: DecimalString.nullable(),
            missing_reason: z.literal('not_disclosed').nullable(),
            original_unit: z.enum(['m3', 'm3/day', 'm3/year']),
            period_from: z.iso.date().nullable(),
            period_to: z.iso.date().nullable(),
            basis: z.enum(['planned', 'reported_actual']),
            evidence_ref: z.string().min(1),
          })
          .strict(),
      )
      .max(20),
    synthetic: z.boolean(),
  })
  .strict()
  .superRefine((v, c) => {
    const issue = (message: string) => c.addIssue({ code: 'custom', message });
    if (v.recorded_at < v.observed_at) issue('recorded_before_observed');
    if (
      v.event_kind === 'grant_decision' &&
      (v.portfolio.phases.some((p) => ['energized', 'it_operational'].includes(p.status)) ||
        v.portfolio.capacity_observations.some((m) => m.measure_kind !== 'planned_mw'))
    )
      issue('grant_does_not_prove_capacity');
    const ids = {
      project: new Set(v.portfolio.projects.map((p) => p.project_id)),
      site: new Set(v.portfolio.sites.map((s) => s.site_id)),
      phase: new Set(v.portfolio.phases.map((p) => p.phase_id)),
    };
    for (const w of v.water) {
      if (!ids[w.scope].has(w.scope_id)) issue('water_scope_missing');
      if ((w.amount_decimal === null) !== (w.missing_reason !== null))
        issue('water_missing_reason_required');
      if (w.period_from && w.period_to && w.period_from > w.period_to)
        issue('water_period_invalid');
    }
  });
export type DCDisclosure = z.infer<typeof DCDisclosureSchema>;
export async function disclosureRevision(input: unknown, previous?: DCDisclosure) {
  const v = DCDisclosureSchema.parse(input);
  if (previous) {
    DCDisclosureSchema.parse(previous);
    if (
      v.series_id !== previous.series_id ||
      v.source_id !== previous.source_id ||
      v.disclosure_id !== previous.disclosure_id ||
      v.observed_at <= previous.observed_at ||
      v.synthetic !== previous.synthetic
    )
      throw new Error('disclosure_lineage_mismatch');
  }
  return {
    ...v,
    observation_id: await hash(stable(v)),
    previous_observation_id: previous ? await hash(stable(previous)) : null,
  };
}
