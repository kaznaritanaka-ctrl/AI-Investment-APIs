import { z } from 'zod';
import { SourceSchema } from '../schema';
import { canCollect, validPolicy } from '../policy';
import { D, isoDate, isoTime } from '../util';
import { isDCSource } from './dc-contract';
import {
  isPublicGpu,
  publicGpuEndpoints,
  publicGpuTermsReview,
  PublicAccessReviewSchema,
} from './public-gpu-contract';

export const StorageReviewHoldSchema = z
  .object({
    basis_ref: z.string().trim().min(1),
    owner_approval_ref: z.string().trim().min(1),
    // An explicitly permitted, finite storage-only window if storage rights become uncertain.
    all_copies_delete_by: z.iso.datetime(),
  })
  .strict();

// Private GPU configs stay outside the public/active source dispatch.
export const ResearchConfigSchema = z
  .object({
    source: SourceSchema,
    adapter: z.enum(['eia_retail', 'jepx_spot', 'highreso_public', 'rebro_public', 'dc_tracker']),
    visibility: z.literal('private_only'),
    method_version: z.enum([
      'dc-tracker-v1',
      'electricity-research-v1',
      'domestic-gpu-html-v1',
      'domestic-gpu-html-v2',
    ]),
    public_access: PublicAccessReviewSchema.optional(),
    dc_access: z
      .object({
        robots_finding: z.string().min(1),
        projects: z
          .array(
            z
              .object({
                candidate_number: z.number().int().positive(),
                project_id: z.string().min(1).max(120),
                title: z.string().min(1).max(500),
                prefecture: z.string().min(1),
                url: z.url(),
              })
              .strict(),
          )
          .min(1)
          .max(2),
      })
      .strict()
      .optional(),
    // Restrictive controls only; bundled non-secret config, never a grant or HTTP input.
    maintenance: z
      .object({
        collection_stopped: z.boolean(),
        revoke_at: z.iso.datetime().nullable(),
        delete_requests: z
          .array(
            z
              .object({
                run_id: z.string().regex(/^[a-f0-9]{64}$/),
                requested_at: z.iso.datetime(),
                basis_ref: z.string().trim().min(1),
                all_copies_delete_by: z.iso.datetime(),
              })
              .strict(),
          )
          .max(5),
      })
      .strict()
      .optional(),
    owner_approval_ref: z.string().min(1).nullable(),
    wire_contract_review_ref: z.string().min(1).nullable(),
    // Explicit review of an acquired config, never a retroactive grant or expiry extension.
    history_access: z
      .array(
        z
          .object({
            config_hash: z.string().regex(/^[a-f0-9]{64}$/),
            approval_ref: z.string().min(1),
          })
          .strict(),
      )
      .max(64),
    terms: z
      .object({
        version: z.string().min(1),
        checked_at: z.iso.datetime(),
        review_after: z.iso.datetime(),
        evidence_refs: z.array(z.string().min(1)).min(1),
      })
      .strict(),
    scope: z.discriminatedUnion('kind', [
      z
        .object({
          kind: z.literal('dc_tracker'),
          project_ids: z.array(z.string().min(1)).min(1).max(20),
        })
        .strict(),
      z
        .object({ kind: z.literal('eia_retail'), state: z.literal('CO'), sector: z.literal('IND') })
        .strict(),
      z.object({ kind: z.literal('jepx_spot'), area: z.literal('Tokyo') }).strict(),
      z
        .object({
          kind: z.literal('highreso_public'),
          gpu_counts: z.array(z.number().int().min(1).max(8)).min(1).max(8).optional(),
          models: z
            .array(z.enum(['A100', 'H100']))
            .min(1)
            .max(2),
        })
        .strict(),
      z
        .object({
          kind: z.literal('rebro_public'),
          models: z
            .array(z.enum(['A100', 'H100']))
            .min(1)
            .max(2),
        })
        .strict(),
    ]),
    limits: z
      .object({
        page_size: z.number().int().min(1).max(48),
        max_pages: z.number().int().min(1).max(4),
        max_input_rows: z.number().int().min(1).max(18000),
      })
      .strict(),
    retention: z
      .object({
        strategy: z.literal('d1_history'),
        target_days: z.number().int().min(1095).max(3650),
        evidence_days: z.number().int().min(1).max(30),
        archive_days: z.literal(0),
        normalized_mode: z
          .enum(['unapproved', 'fixed_days', 'until_revoked'])
          .default('fixed_days'),
        normalized_days: z.number().int().min(1).max(3650).nullable(),
        ongoing_storage: z
          .object({
            basis_ref: z.string().trim().min(1),
            owner_approval_ref: z.string().trim().min(1),
          })
          .strict()
          .nullable()
          .default(null),
        storage_review_hold: StorageReviewHoldSchema.nullable().default(null),
        backup_days: z.number().int().min(1).max(30),
        time_travel_days: z.union([z.literal(7), z.literal(30)]).nullable(),
        lifecycle_review_ref: z.string().min(1).nullable(),
        reviewed_ref: z.string().min(1).nullable(),
      })
      .strict(),
  })
  .strict()
  .superRefine((v, c) => {
    if (new Set(v.history_access.map((h) => h.config_hash)).size !== v.history_access.length)
      c.addIssue({ code: 'custom', message: 'duplicate_history_approval' });
    const u = new URL(v.source.source_url);
    if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash)
      c.addIssue({ code: 'custom', message: 'unsafe_source_url' });
    if (
      v.source.dataset_type !==
        (v.adapter === 'highreso_public'
          ? 'gpu_rental'
          : v.adapter === 'rebro_public'
            ? 'gpu_secondary'
            : v.adapter === 'dc_tracker'
              ? 'capex_utilization'
              : 'electricity') ||
      (isPublicGpu(v.adapter)
        ? !['domestic-gpu-html-v1', 'domestic-gpu-html-v2'].includes(v.method_version)
        : v.adapter === 'dc_tracker'
          ? v.method_version !== 'dc-tracker-v1'
          : v.method_version !== 'electricity-research-v1') ||
      v.source.adapter !== 'candidate' ||
      v.scope.kind !== v.adapter ||
      v.source.gpu ||
      v.source.models ||
      v.source.max_records < v.limits.page_size ||
      (v.adapter === 'jepx_spot' && (v.limits.page_size !== 48 || v.limits.max_pages !== 1))
    )
      c.addIssue({ code: 'custom', message: 'research_scope_invalid' });
    if (
      v.scope.kind === 'dc_tracker' &&
      (v.limits.max_pages > 3 ||
        v.limits.page_size > 20 ||
        v.limits.max_input_rows > 60 ||
        new Set(v.scope.project_ids).size !== v.scope.project_ids.length)
    )
      c.addIssue({ code: 'custom', message: 'dc_tracker_scope_invalid' });
    if (v.dc_access) {
      const projects = v.dc_access.projects;
      if (
        v.scope.kind !== 'dc_tracker' ||
        !isDCSource(v.source.source_id) ||
        v.limits.max_pages !== 1 ||
        v.limits.page_size < projects.length ||
        v.limits.max_input_rows < projects.length ||
        v.source.authentication_required ||
        v.source.endpoint !== v.source.source_url ||
        projects[0]?.url !== v.source.source_url ||
        v.source.max_bytes > 131072 ||
        projects.length !== v.scope.project_ids.length ||
        projects.some((p) => {
          const target = new URL(p.url);
          return (
            v.scope.kind !== 'dc_tracker' ||
            !v.scope.project_ids.includes(p.project_id) ||
            target.origin !== u.origin ||
            target.username ||
            target.password ||
            target.search ||
            target.hash
          );
        }) ||
        new Set(projects.map((p) => p.project_id)).size !== projects.length
      )
        c.addIssue({ code: 'custom', message: 'dc_tracker_live_scope_invalid' });
    }
    if (isPublicGpu(v.adapter)) {
      if (
        v.scope.kind === 'highreso_public' &&
        ((v.method_version === 'domestic-gpu-html-v2') !== (v.scope.gpu_counts !== undefined) ||
          (v.scope.gpu_counts && new Set(v.scope.gpu_counts).size !== v.scope.gpu_counts.length))
      )
        c.addIssue({ code: 'custom', message: 'public_gpu_cohort_review_required' });
      if ('models' in v.scope && new Set(v.scope.models).size !== v.scope.models.length)
        c.addIssue({ code: 'custom', message: 'duplicate_gpu_scope' });
      const urls = publicGpuEndpoints[v.adapter];
      if (
        v.source.source_id !== v.adapter ||
        v.source.source_url !== urls.page ||
        v.source.endpoint !== urls.page ||
        v.source.terms_url !== urls.terms ||
        v.source.authentication_required ||
        !v.public_access ||
        (v.adapter === 'rebro_public' &&
          (v.public_access.next_terms_sha256 != null ||
            v.public_access.highreso_terms_fallback !== undefined)) ||
        v.limits.max_pages !== 1 ||
        v.limits.max_input_rows > 100 ||
        v.source.max_bytes > 1000000
      )
        c.addIssue({ code: 'custom', message: 'public_gpu_scope_invalid' });
    } else if (v.public_access) c.addIssue({ code: 'custom', message: 'unexpected_public_access' });
  });
export type ResearchConfig = z.infer<typeof ResearchConfigSchema>;

const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
export const ResearchQuerySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('dc_tracker') }).strict(),
  z.object({ kind: z.literal('eia_retail'), from: month, to: month }).strict(),
  z.object({ kind: z.literal('jepx_spot'), delivery_date: z.string().refine(isoDate) }).strict(),
  z.object({ kind: z.literal('highreso_public') }).strict(),
  z.object({ kind: z.literal('rebro_public') }).strict(),
]);
export type ResearchQuery = z.infer<typeof ResearchQuerySchema>;
export function validateQuery(config: ResearchConfig, input: unknown): ResearchQuery {
  const q = ResearchQuerySchema.parse(input);
  if (q.kind !== config.adapter) throw new Error('research_scope_mismatch');
  if (q.kind === 'eia_retail') {
    const index = (m: string) => Number(m.slice(0, 4)) * 12 + Number(m.slice(5));
    if (index(q.to) < index(q.from) || index(q.to) - index(q.from) >= 12)
      throw new Error('research_window_limit');
  }
  return q;
}
export function assertResearchAllowed(config: ResearchConfig, now: string, currentTerms: string) {
  assertResearchAuthority(config, now, currentTerms, true);
}
export function assertResearchHistoryAllowed(
  config: ResearchConfig,
  now: string,
  currentTerms: string,
) {
  assertResearchAuthority(config, now, currentTerms, false);
}
function assertResearchAuthority(
  config: ResearchConfig,
  now: string,
  currentTerms: string,
  acquisition: boolean,
) {
  ResearchConfigSchema.parse(config);
  if (!isoTime(now)) throw new Error('invalid_research_time');
  const s = config.source,
    r = config.retention;
  // A missing license URL is neither a grant nor a veto; reuse the nine-rights policy.
  if (acquisition && (config.maintenance?.collection_stopped || config.maintenance?.revoke_at))
    throw new Error('research_collection_stopped');
  if (
    acquisition
      ? !(isPublicGpu(config.adapter)
          ? validPolicy(s, now) &&
            ['automated_collection', 'private_storage', 'internal_analysis'].every(
              (k) => s.policy.rights[k as keyof typeof s.policy.rights] === 'allowed',
            )
          : canCollect(s, now))
      : now < s.policy.valid_from ||
        (s.policy.valid_until !== null && now >= s.policy.valid_until) ||
        s.policy.rights.private_storage !== 'allowed' ||
        s.policy.rights.internal_analysis !== 'allowed'
  )
    throw new Error('policy_blocked');
  if (
    !config.owner_approval_ref ||
    !config.wire_contract_review_ref ||
    !r.reviewed_ref ||
    !s.policy.fields.includes(
      isPublicGpu(config.adapter)
        ? 'domestic_gpu_projection_v1'
        : config.adapter === 'dc_tracker'
          ? 'dc_tracker_projection_v1'
          : 'electricity_projection_v1',
    )
  )
    throw new Error('research_review_required');
  assertResearchRetentionReviewed(config);
  if (
    isPublicGpu(config.adapter) &&
    (!config.public_access?.reviewed_ref ||
      !config.public_access.robots_sha256 ||
      !publicGpuTermsReview(config.adapter, config.public_access, now).sha256 ||
      config.public_access.robots_decision !== 'allowed')
  )
    throw new Error('public_access_review_required');
  if (
    config.terms.version !== currentTerms ||
    s.policy.evidence_version !== currentTerms ||
    now < config.terms.checked_at ||
    now >= config.terms.review_after
  )
    throw new Error('terms_review_required');
}
export function assertResearchRetentionReviewed(config: ResearchConfig) {
  const s = config.source,
    r = config.retention;
  if (
    r.normalized_mode === 'unapproved' ||
    (r.normalized_mode === 'fixed_days' && r.normalized_days === null) ||
    (r.normalized_mode === 'until_revoked' &&
      (r.normalized_days !== null ||
        !r.ongoing_storage ||
        s.policy.retention_limit_days !== null ||
        s.policy.valid_until !== null)) ||
    r.time_travel_days === null ||
    !r.lifecycle_review_ref ||
    !r.reviewed_ref ||
    s.policy.retention_days !== r.evidence_days ||
    r.time_travel_days > r.backup_days ||
    (s.policy.retention_limit_days !== null &&
      (r.evidence_days > s.policy.retention_limit_days ||
        r.normalized_days === null ||
        r.normalized_days + r.backup_days > s.policy.retention_limit_days))
  )
    throw new Error('retention_review_required');
}
export function assertResearchExport(
  _config: ResearchConfig,
  _purpose: 'public' | 'external_llm' | 'raw',
) {
  // No export path exists in this private research slice, even with accidental extra grants.
  throw new Error('research_export_not_supported');
}
export function signedDecimal(input: unknown): string {
  if (typeof input !== 'string' || input.length > 80 || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(input))
    throw new Error('invalid_research_decimal');
  const n = new D(input);
  if (!n.isFinite() || n.abs().gt('1e20')) throw new Error('invalid_research_decimal');
  return n.toFixed();
}
export const ElectricityRecordSchema = z
  .object({
    record_key: z.string().min(1).max(120),
    market: z.enum(['retail_average', 'wholesale_day_ahead']),
    country: z.enum(['US', 'JP']),
    region: z.enum(['CO', 'Tokyo']),
    sector: z.literal('IND').nullable(),
    period: z.string().min(7).max(10),
    interval: z.enum(['month', '30_minutes']),
    interval_start: z.iso.datetime().nullable(),
    interval_end: z.iso.datetime().nullable(),
    timezone: z.enum(['not_applicable_month', 'Asia/Tokyo']),
    amount_decimal: z
      .string()
      .refine((s) => {
        try {
          signedDecimal(s);
          return true;
        } catch {
          return false;
        }
      })
      .nullable(),
    missing_reason: z.enum(['not_reported']).nullable(),
    currency: z.enum(['USD', 'JPY']),
    original_unit: z.enum(['cents per kilowatthour', 'JPY/kWh']),
    tax_status: z.literal('unknown'),
    source_date: z.string().refine(isoDate).nullable(),
    source_published_at: z.iso.datetime().nullable(),
    source_effective_at: z.iso.datetime().nullable(),
    basis: z.enum(['official_retail_statistic', 'exchange_published_price']),
  })
  .strict()
  .superRefine((v, c) => {
    if ((v.amount_decimal === null) !== (v.missing_reason !== null))
      c.addIssue({ code: 'custom', message: 'missing_reason_required' });
  });
export type ElectricityRecord = z.infer<typeof ElectricityRecordSchema>;
export const ResearchPageSchema = z
  .object({
    page: z.number().int().nonnegative(),
    records: z.array(ElectricityRecordSchema).max(48),
    reported_total: z.number().int().nonnegative().nullable(),
    next_page: z.number().int().positive().nullable(),
    coverage: z.enum(['complete', 'partial']),
    reasons: z.array(z.enum(['missing_intervals', 'source_empty', 'page_limit', 'more_pages'])),
  })
  .strict();
export type ResearchPage = z.infer<typeof ResearchPageSchema>;
