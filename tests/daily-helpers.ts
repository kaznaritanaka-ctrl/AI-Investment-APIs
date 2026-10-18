import { cloudFixture } from './personal-cloud-fixture';
import { PersonalDailySchema } from '../src/research/personal-contract';
import { hash, stable } from '../src/util';
import { receiptSignature, type NasReceiptValue } from '../src/research/daily-protocol';
import type { DailyEnv } from '../src/research/personal-daily';
export const receiptSecret = 'SYNTHETIC-ONLY-NOT-A-REAL-KEY-0123456789';
export async function dailyFixture(source: 'highreso_public' | 'rebro_public' = 'rebro_public') {
  const { contract } = await cloudFixture(source);
  const c = PersonalDailySchema.parse({
    ...contract,
    version: 'personal-gpu-cloud-daily-v1',
    cloud: { ...contract.cloud, initial_acquisition_only: false },
    decision: { ...contract.decision, acquisition_until: '2026-10-25T00:00:00.000Z' },
    daily: {
      approval_ref: 'SYNTHETIC daily authority',
      timezone: 'UTC',
      collection_hour: 0,
      max_attempts_per_day: 1,
      backfill: false,
      monitoring_review_ref: 'SYNTHETIC ONLY',
      bootstrap_hours: 24,
      heartbeat_max_hours: 3,
      backup_max_hours: 48,
      inventory_max_days: 2,
    },
  });
  return {
    c,
    pin: {
      contract_hash: await hash(stable(c)),
      account_id: c.cloud.account_id,
      private_database_id: c.cloud.private_database_id,
      bucket: c.cloud.bucket,
    },
  };
}
export async function heartbeat(
  env: DailyEnv,
  source: string,
  at: string,
  status: NasReceiptValue['status'] = 'ok',
) {
  const r: NasReceiptValue = {
    version: 1,
    source_id: source as NasReceiptValue['source_id'],
    issued_at: at,
    status,
    last_backup_at: status === 'empty' ? null : at,
    last_restored_at: status === 'empty' ? null : at,
    last_inventory_at: status === 'empty' ? null : at,
    latest_observed_at: status === 'empty' ? null : at,
    pending: 0,
    code: 'none',
  };
  await env.NAS_HEALTH!.put(
    'daily/receipts/' + source + '.json',
    stable({ receipt: r, signature: await receiptSignature(r, receiptSecret) }),
  );
  return r;
}
