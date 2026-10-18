import { PersonalV2Schema } from '../src/research/personal-contract';
import { personalReviewHead, PersonalReviewSchema } from '../src/research/personal-review';
import type { PersonalEnv } from '../src/research/personal';
import { personalFixture } from './personal-fixture';
export async function continuingFixture(
  source: 'highreso_public' | 'rebro_public' = 'highreso_public',
) {
  const v1 = await personalFixture(source);
  return PersonalV2Schema.parse({
    ...v1,
    version: 'personal-gpu-v2',
    decision: {
      ...v1.decision,
      storage_until: null,
      retention: {
        ...v1.decision.retention,
        mode: 'owner_continuing',
        normalized_days: null,
        backup_recoverability_days: 7,
        continuing_storage: {
          basis_ref: 'SYNTHETIC continuing owner decision',
          owner_approval_ref: 'SYNTHETIC ONLY',
          purpose_ref: 'SYNTHETIC ten year research goal; not expiry',
        },
        backup: {
          destination_id: 'synthetic-vault',
          key_id: 'synthetic-key',
          interval_hours: 24,
          retention_days: 7,
          restore_check_hours: 24,
          max_copies: 8,
          reviewed_ref: 'SYNTHETIC ONLY',
          recovery_review_ref: 'SYNTHETIC ONLY',
        },
      },
    },
  });
}
export async function reviewFixture(
  env: PersonalEnv,
  c: Awaited<ReturnType<typeof continuingFixture>>,
  at: string,
) {
  const { head } = (await personalReviewHead(env, c, true))!;
  return PersonalReviewSchema.parse({
    version: 'personal-review-v1',
    contract_hash: head.contract_hash,
    previous_hash: head.review_hash,
    sequence: head.sequence + 1,
    approved_at: at,
    owner_approval_ref: 'SYNTHETIC reviewed historical analysis',
    historical_use_review_ref: 'SYNTHETIC existing run scope',
    terms_version: 'SYNTHETIC renewed terms',
    terms_evidence_ref: 'SYNTHETIC no live review',
    review_after: new Date(Date.parse(at) + 30 * 86400000).toISOString(),
    analysis_until: new Date(Date.parse(at) + 30 * 86400000).toISOString(),
    storage_state: 'continuing',
    storage_basis_ref: 'SYNTHETIC continuing decision confirmed',
    storage_ends_at: head.storage_ends_at,
    scope: 'existing_run_only',
    new_collection: false,
  });
}
