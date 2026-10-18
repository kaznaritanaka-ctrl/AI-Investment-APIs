import highreso from '../config/proposals/research/highreso_public.json';
import rebro from '../config/proposals/research/rebro_public.json';
import { ResearchConfigSchema } from '../src/research/schema';
import { PersonalV1Schema } from '../src/research/personal-contract';
import { hash, stable } from '../src/util';
import { robotsFingerprint, termsFingerprint } from '../src/research/public-gpu-html';
import { robots, terms, gpuTime } from './public-gpu-fixture-config';
import type { PublicGpuAdapter } from '../src/research/public-gpu-contract';
export { gpuTime };
export async function personalFixture(adapter: PublicGpuAdapter = 'highreso_public') {
  const config = ResearchConfigSchema.parse(
    structuredClone(adapter === 'highreso_public' ? highreso : rebro),
  );
  return PersonalV1Schema.parse({
    version: 'personal-gpu-v1',
    authority_kind: 'owner_personal_research_exception',
    status: 'approved_for_local_execution',
    data_origin: 'synthetic',
    config,
    config_sha256: await hash(stable(config)),
    decision: {
      exception_id: 'synthetic-initial',
      provider_permission: 'unconfirmed',
      owner_execution_approval_ref: 'SYNTHETIC ONLY: not an owner approval',
      risk_acceptance_ref: 'SYNTHETIC ONLY',
      unresolved_conditions: ['SYNTHETIC unconfirmed provider permission'],
      approved_at: '2026-10-18T00:00:00.000Z',
      acquisition_from: '2026-10-18T00:00:00.000Z',
      acquisition_until: '2026-10-20T00:00:00.000Z',
      analysis_until: '2026-10-27T00:00:00.000Z',
      storage_until: '2026-11-01T00:00:00.000Z',
      max_attempts: 1,
      fields: ['domestic_gpu_projection_v1'],
      terms: {
        version: 'synthetic-v1',
        monitored_url: config.source.terms_url,
        applicable_terms_review_ref: 'SYNTHETIC ONLY',
        review_after: '2026-10-26T00:00:00.000Z',
        terms_sha256: await termsFingerprint(terms),
        robots_sha256: await robotsFingerprint(robots),
        robots_decision: 'allowed',
        access_review_ref: 'SYNTHETIC ONLY',
        applicability:
          adapter === 'highreso_public'
            ? 'highreso_domestic_pre_20261101'
            : 'rebro_public_scope_review',
      },
      retention: {
        mode: 'fixed_days',
        evidence_days: 1,
        normalized_days: 10,
        archive_days: 0,
        time_travel: 'not_applicable_local',
        backup_recoverability_days: 0,
        copy_inventory_review_ref: 'SYNTHETIC ONLY',
        automatic_cleanup_review_ref: 'SYNTHETIC ONLY',
        revocation_restore_review_ref: 'SYNTHETIC ONLY',
        store_id: 'synthetic-store',
      },
      public_export: false,
      external_llm: false,
      raw_persistence: false,
    },
  });
}
