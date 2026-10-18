import { z } from 'zod';
import { hash, isoTime, stable } from '../util';
import { ResearchConfigSchema } from './schema';
import { isPublicGpu, publicGpuEndpoints } from './public-gpu-contract';

const ref = z.string().trim().min(1).max(500);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const time = z.iso.datetime().refine((v) => new Date(v).toISOString() === v);
const PersonalV1Base = z
  .object({
    version: z.literal('personal-gpu-v1'),
    authority_kind: z.literal('owner_personal_research_exception'),
    status: z.literal('approved_for_local_execution'),
    data_origin: z.enum(['synthetic', 'live']),
    // The original disabled proposal is captured verbatim, never promoted to allowed.
    config: ResearchConfigSchema,
    config_sha256: digest,
    decision: z
      .object({
        exception_id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}$/),
        provider_permission: z.literal('unconfirmed'),
        owner_execution_approval_ref: ref,
        risk_acceptance_ref: ref,
        unresolved_conditions: z.array(ref).min(1).max(16),
        approved_at: time,
        acquisition_from: time,
        acquisition_until: time,
        analysis_until: time,
        storage_until: time,
        max_attempts: z.literal(1),
        fields: z.tuple([z.literal('domestic_gpu_projection_v1')]),
        terms: z
          .object({
            version: ref,
            monitored_url: z.url(),
            applicable_terms_review_ref: ref,
            review_after: time,
            terms_sha256: digest,
            robots_sha256: digest,
            robots_decision: z.literal('allowed'),
            access_review_ref: ref,
            // The current fixed Highreso monitor is the old domestic version only.
            applicability: z.enum(['highreso_domestic_pre_20261101', 'rebro_public_scope_review']),
          })
          .strict(),
        retention: z
          .object({
            mode: z.literal('fixed_days'),
            evidence_days: z.number().int().min(1).max(30),
            normalized_days: z.number().int().min(1).max(3650),
            archive_days: z.literal(0),
            time_travel: z.literal('not_applicable_local'),
            // v1 only supports a reviewed local store with no backup/sync copies.
            backup_recoverability_days: z.literal(0),
            copy_inventory_review_ref: ref,
            automatic_cleanup_review_ref: ref,
            revocation_restore_review_ref: ref,
            store_id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}$/),
          })
          .strict(),
        public_export: z.literal(false),
        external_llm: z.literal(false),
        raw_persistence: z.literal(false),
      })
      .strict(),
  })
  .strict();

export const PersonalBackupSchema = z
  .object({
    destination_id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}$/),
    key_id: ref,
    interval_hours: z.number().int().min(1).max(168),
    retention_days: z.number().int().min(1).max(90),
    restore_check_hours: z.number().int().min(1).max(720),
    max_copies: z.number().int().min(2).max(96),
    reviewed_ref: ref,
    recovery_review_ref: ref,
  })
  .strict()
  .refine(
    (v) => v.max_copies * v.interval_hours >= v.retention_days * 24,
    'personal_backup_capacity_invalid',
  );
const PersonalV2Base = z
  .object({
    ...PersonalV1Base.shape,
    version: z.literal('personal-gpu-v2'),
    decision: z
      .object({
        ...PersonalV1Base.shape.decision.shape,
        storage_until: z.null(),
        retention: z
          .object({
            ...PersonalV1Base.shape.decision.shape.retention.shape,
            mode: z.literal('owner_continuing'),
            normalized_days: z.null(),
            backup_recoverability_days: z.number().int().min(1).max(90),
            continuing_storage: z
              .object({ basis_ref: ref, owner_approval_ref: ref, purpose_ref: ref })
              .strict(),
            backup: PersonalBackupSchema,
          })
          .strict(),
      })
      .strict(),
  })
  .strict();
function common(
  v: z.infer<typeof PersonalV1Base> | z.infer<typeof PersonalV2Base>,
  ctx: z.RefinementCtx,
) {
  const c = v.config,
    d = v.decision,
    t = d.terms;
  if (
    !isPublicGpu(c.adapter) ||
    c.source.enabled ||
    c.history_access.length ||
    !c.source.policy.fields.includes('domestic_gpu_projection_v1') ||
    ['automated_collection', 'private_storage', 'internal_analysis'].some(
      (key) =>
        c.source.policy.rights[key as keyof typeof c.source.policy.rights] !== 'review_required',
    )
  )
    ctx.addIssue({ code: 'custom', message: 'personal_source_scope_invalid' });
  if (
    isPublicGpu(c.adapter) &&
    (t.monitored_url !== publicGpuEndpoints[c.adapter].terms ||
      (c.adapter === 'highreso_public'
        ? t.applicability !== 'highreso_domestic_pre_20261101' ||
          t.review_after > '2026-10-31T15:00:00.000Z'
        : t.applicability !== 'rebro_public_scope_review'))
  )
    ctx.addIssue({ code: 'custom', message: 'personal_terms_scope_invalid' });
  if (
    d.approved_at > d.acquisition_from ||
    d.acquisition_from >= d.acquisition_until ||
    d.acquisition_until > t.review_after ||
    d.acquisition_until > d.analysis_until ||
    (d.storage_until !== null && d.analysis_until > d.storage_until) ||
    (d.retention.normalized_days !== null &&
      d.retention.evidence_days > d.retention.normalized_days)
  )
    ctx.addIssue({ code: 'custom', message: 'personal_deadlines_invalid' });
  if (
    v.version === 'personal-gpu-v2' &&
    v.decision.retention.backup_recoverability_days !== v.decision.retention.backup.retention_days
  )
    ctx.addIssue({ code: 'custom', message: 'personal_backup_retention_mismatch' });
}
export const PersonalV1Schema = PersonalV1Base.superRefine(common);
export const PersonalV2Schema = PersonalV2Base.superRefine(common);
export const PersonalContractSchema = z.union([PersonalV1Schema, PersonalV2Schema]);
export type PersonalV2Contract = z.infer<typeof PersonalV2Schema>;
export type PersonalContract = z.infer<typeof PersonalContractSchema>;
export type PersonalOperation = 'collect' | 'read' | 'maintain';

export async function inspectPersonalContract(
  input: unknown,
  at: string,
  environment: 'test' | 'development' | 'production',
  operation: PersonalOperation,
) {
  if (environment !== 'test' && environment !== 'development')
    throw new Error('personal_production_forbidden');
  if (!isoTime(at)) throw new Error('invalid_personal_time');
  const parsed = PersonalContractSchema.safeParse(input);
  if (!parsed.success) throw new Error('personal_contract_invalid');
  const c = parsed.data,
    d = c.decision;
  if ((environment === 'test') !== (c.data_origin === 'synthetic'))
    throw new Error('personal_synthetic_boundary');
  if ((await hash(stable(c.config))) !== c.config_sha256)
    throw new Error('personal_config_hash_mismatch');
  if (at < d.approved_at) throw new Error('personal_approval_not_effective');
  if (operation !== 'maintain') {
    if (at < d.approved_at || (d.storage_until !== null && at >= d.storage_until))
      throw new Error('personal_storage_expired');
    if (at >= d.analysis_until) throw new Error('personal_analysis_expired');
    if (at >= d.terms.review_after) throw new Error('personal_terms_review_required');
    if (operation === 'collect' && (at < d.acquisition_from || at >= d.acquisition_until))
      throw new Error('personal_acquisition_window_closed');
  }
  return { contract: c, contract_hash: await hash(stable(c)) };
}

export function personalDeadlines(c: PersonalContract, capturedAt: string) {
  const day = (n: number) => new Date(Date.parse(capturedAt) + n * 86400000).toISOString();
  const normalized =
    c.version === 'personal-gpu-v2'
      ? null
      : [day(c.decision.retention.normalized_days), c.decision.storage_until].sort()[0];
  return {
    evidence: [
      day(c.decision.retention.evidence_days),
      ...(normalized ? [normalized] : []),
    ].sort()[0],
    normalized,
    all_copies: normalized,
  };
}
