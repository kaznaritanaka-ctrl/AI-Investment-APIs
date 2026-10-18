import { continuingFixture } from './personal-continuing-fixture';
import { PersonalCloudSchema } from '../src/research/personal-contract';
import { hash, stable } from '../src/util';
export async function cloudFixture(source: 'highreso_public' | 'rebro_public' = 'highreso_public') {
  const local = await continuingFixture(source);
  const contract = PersonalCloudSchema.parse({
    ...local,
    version: 'personal-gpu-cloud-v1',
    status: 'approved_for_cloud_execution',
    decision: {
      ...local.decision,
      acquisition_until: '2026-10-19T00:00:00.000Z',
      retention: { ...local.decision.retention, time_travel: 'cloudflare_d1' },
    },
    cloud: {
      account_id: 'a'.repeat(32),
      private_database_id: '00000000-0000-4000-8000-000000000001',
      bucket: 'synthetic-personal-only',
      d1_time_travel_days: 7,
      deployment_approval_ref: 'SYNTHETIC ONLY',
      lifecycle_review_ref: 'SYNTHETIC ONLY',
      nas_admission_review_ref: 'SYNTHETIC ONLY',
      restore_review_ref: 'SYNTHETIC ONLY',
      initial_acquisition_only: true,
    },
  });
  return {
    contract,
    binding: {
      contract_hash: await hash(stable(contract)),
      account_id: contract.cloud.account_id,
      private_database_id: contract.cloud.private_database_id,
      bucket: contract.cloud.bucket,
    },
  };
}
