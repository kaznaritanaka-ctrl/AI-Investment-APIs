import { z } from 'zod';
import { DecimalString } from './schema';
const evidence = z
  .object({
    source_id: z.string(),
    source_url: z.url(),
    source_policy_version: z.string(),
    observed_at: z.iso.datetime(),
    published_at: z.iso.datetime().nullable(),
    source_date: z.iso.date().nullable(),
    evidence_ref: z.string(),
    basis: z.enum([
      'announced',
      'contracted',
      'official_operational_report',
      'third_party_report',
      'estimate',
    ]),
    confidence: z.enum(['documented', 'reported', 'unverified']),
  })
  .strict();
const capacity = z
  .object({
    measure_id: z.string(),
    mw: DecimalString,
    measure_kind: z.enum(['planned_mw', 'contracted_mw', 'energized_mw', 'it_operational_mw']),
    scope: z.enum(['project', 'site', 'phase']),
    scope_id: z.string(),
    as_of_date: z.iso.date().nullable(),
    evidence,
  })
  .strict();
export const DCProjectSchema = z
  .object({
    project_id: z.string(),
    name: z.string(),
    operator_entity_id: z.string().nullable(),
    owner_entity_id: z.string().nullable().default(null),
    tenant_entity_ids: z.array(z.string()).nullable().default(null),
    country: z
      .string()
      .regex(/^[A-Z]{2}$/)
      .nullable(),
    evidence,
  })
  .strict();
export const DCSiteSchema = z
  .object({
    site_id: z.string(),
    project_id: z.string(),
    name: z.string(),
    region: z.string().nullable(),
    location_evidence_ref: z.string().nullable(),
    evidence,
  })
  .strict();
export const DCPhaseSchema = z
  .object({
    phase_id: z.string(),
    site_id: z.string(),
    phase_label: z.string(),
    status: z.enum([
      'proposed',
      'power_application',
      'power_contracted',
      'permitted',
      'construction',
      'energized',
      'facility_handover',
      'it_installed',
      'it_operational',
      'paused',
      'cancelled',
      'unknown',
    ]),
    planned_service_date: z.iso.date().nullable(),
    actual_service_date: z.iso.date().nullable(),
    evidence,
  })
  .strict();
export const DCRelationshipSchema = z
  .object({
    relationship_id: z.string(),
    from_entity_id: z.string(),
    to_entity_id: z.string(),
    role: z
      .enum([
        'gpu_vendor',
        'oem_odm',
        'rack_integrator',
        'power_cooling',
        'construction',
        'facility_owner',
        'utility',
        'financier',
        'cloud_customer',
        'unknown',
      ])
      .default('unknown'),
    contract_status: z
      .enum(['announced', 'signed', 'delivered', 'terminated', 'unknown'])
      .default('unknown'),
    valid_from: z.iso.date().nullable().default(null),
    valid_until: z.iso.date().nullable().default(null),
    disclosed_vs_inferred: z.enum(['disclosed', 'inferred', 'unknown']).default('unknown'),
    kind: z.enum([
      'corporate_collaboration',
      'equipment_order',
      'project_delivery',
      'power_contract',
    ]),
    project_id: z.string().nullable(),
    site_id: z.string().nullable(),
    phase_id: z.string().nullable(),
    delivery_date: z.iso.date().nullable(),
    evidence,
  })
  .strict()
  .superRefine((v, c) => {
    if (
      v.kind === 'project_delivery' &&
      (!v.project_id || !v.site_id || v.evidence.basis !== 'official_operational_report')
    )
      c.addIssue({ code: 'custom', message: 'project_specific_delivery_evidence_required' });
    if (v.kind === 'corporate_collaboration' && (v.delivery_date || v.phase_id))
      c.addIssue({ code: 'custom', message: 'collaboration_does_not_prove_delivery' });
  });
export const DCPortfolioSchema = z
  .object({
    schema_version: z.literal('dc-research-v1'),
    projects: z.array(DCProjectSchema),
    sites: z.array(DCSiteSchema),
    phases: z.array(DCPhaseSchema),
    capacity_observations: z.array(capacity),
    relationships: z.array(DCRelationshipSchema),
  })
  .strict()
  .superRefine((v, c) => {
    const projects = new Set(v.projects.map((x) => x.project_id)),
      sites = new Set(v.sites.map((x) => x.site_id)),
      phases = new Set(v.phases.map((x) => x.phase_id));
    if (
      projects.size !== v.projects.length ||
      sites.size !== v.sites.length ||
      phases.size !== v.phases.length
    )
      c.addIssue({ code: 'custom', message: 'duplicate_scope_id' });
    if (
      v.sites.some((s) => !projects.has(s.project_id)) ||
      v.phases.some((p) => !sites.has(p.site_id))
    )
      c.addIssue({ code: 'custom', message: 'scope_reference_missing' });
    for (const m of v.capacity_observations)
      if (!(m.scope === 'project' ? projects : m.scope === 'site' ? sites : phases).has(m.scope_id))
        c.addIssue({ code: 'custom', message: 'capacity_scope_missing' });
    for (const r of v.relationships)
      if (
        (r.project_id && !projects.has(r.project_id)) ||
        (r.site_id && !sites.has(r.site_id)) ||
        (r.phase_id && !phases.has(r.phase_id))
      )
        c.addIssue({ code: 'custom', message: 'relationship_scope_missing' });
  });
