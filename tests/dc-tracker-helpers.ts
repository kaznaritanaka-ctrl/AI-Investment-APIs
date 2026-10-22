import proposal from '../config/proposals/research/meti_dc_tracker.json';
import { ResearchConfigSchema } from '../src/research/schema';
import { hash, stable } from '../src/util';
import type { DCTrackerRecord } from '../src/research/dc-tracker-schema';
export const dcTime = '2026-10-22T01:00:00.000Z';
export function dcConfig() {
  const c = ResearchConfigSchema.parse(structuredClone(proposal));
  c.source.enabled = true;
  for (const k of ['automated_collection', 'private_storage', 'internal_analysis'] as const)
    c.source.policy.rights[k] = 'allowed';
  c.owner_approval_ref = 'synthetic-owner';
  c.wire_contract_review_ref = 'synthetic-wire';
  c.scope = { kind: 'dc_tracker', project_ids: ['synthetic-project'] };
  c.retention.normalized_mode = 'fixed_days';
  c.retention.normalized_days = 90;
  c.retention.time_travel_days = 7;
  c.retention.reviewed_ref = 'synthetic-retention';
  c.retention.lifecycle_review_ref = 'synthetic-lifecycle';
  return c;
}
export const dcOpt = (at = dcTime, c = dcConfig()) => ({
  now: () => at,
  current_terms_version: c.terms.version,
});
export async function dcRecord(
  at = dcTime,
  field: DCTrackerRecord['field'] = 'planned_service_date',
  disclosure = 'synthetic-release',
): Promise<DCTrackerRecord> {
  const c = dcConfig();
  const scope = field.endsWith('_mw') ? 'site' : 'phase';
  const scopeId = scope === 'site' ? 'synthetic-site' : 'synthetic-phase';
  return {
    record_key: await hash(stable([c.source.source_id, disclosure, scope, scopeId, field])),
    disclosure_id: disclosure,
    entity: { entity_id: 'synthetic-operator', name_ja: '合成事業者', corporate_number: null },
    project: {
      project_id: 'synthetic-project',
      name: '合成DC案件',
      operator_entity_id: 'synthetic-operator',
      owner_entity_id: null,
      tenant_entity_ids: null,
      country: 'JP',
      prefecture: null,
      tracked_since: '2026-10-22',
      tracking_status: 'active',
    },
    site: {
      site_id: 'synthetic-site',
      project_id: 'synthetic-project',
      name: '合成サイト',
      region: null,
      location_evidence_ref: null,
    },
    phase: {
      phase_id: 'synthetic-phase',
      site_id: 'synthetic-site',
      phase_label: '合成第1期',
      status: 'construction',
      planned_service_date: '2028-01-01',
      actual_service_date: null,
    },
    field,
    scope,
    scope_id: scopeId,
    value_text:
      field === 'planned_service_date' ? '2028-01-01' : field === 'status' ? 'construction' : null,
    value_decimal: field.endsWith('_mw') ? '0.00' : null,
    unit: field.endsWith('_mw') ? 'MW' : null,
    as_of_date: at.slice(0, 10),
    evidence: {
      source_id: c.source.source_id,
      source_url: 'https://www.meti.go.jp/synthetic-release',
      source_policy_version: c.source.policy.version,
      observed_at: at,
      published_at: null,
      source_date: at.slice(0, 10),
      evidence_ref: 'synthetic-evidence',
      basis: 'announced',
      confidence: 'documented',
    },
    evidence_sha256: await hash('synthetic-evidence-only'),
    evidence_level: 'primary_disclosure',
    source_quote: '合成の引用：予定日を公表します。',
    drafted_by: 'deterministic',
    status: 'draft',
    change: null,
    financing: null,
  };
}
export function dcPage(
  records: DCTrackerRecord[],
  page = 0,
  total = records.length,
  next: number | null = null,
  coverage = 'complete',
) {
  return JSON.stringify({
    page,
    records,
    reported_total: total,
    next_page: next,
    coverage,
    reasons:
      coverage === 'complete'
        ? []
        : total === 0
          ? ['source_empty']
          : next === null
            ? ['page_limit']
            : ['more_pages'],
  });
}
