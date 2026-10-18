import {
  PersonalCloudSchema,
  inspectPersonalContract,
  type PersonalOperation,
} from './personal-contract';
import { hash, isoTime, stable } from '../util';
import type { PersonalEnv } from './personal';

// Capabilities are process-local objects, never a serialized flag accepted from a payload.
const verified = new WeakSet<object>();
export const hasCloudPersonalAuthority = (env: object) => verified.has(env);
export type CloudPersonalBinding = {
  contract_hash: string;
  account_id: string;
  private_database_id: string;
  bucket: string;
};
export async function inspectPersonalAuthority(
  env: PersonalEnv,
  input: unknown,
  at: string,
  operation: PersonalOperation,
) {
  if (!env.PERSONAL_CLOUD) return inspectPersonalContract(input, at, env.ENVIRONMENT, operation);
  if ('PUBLIC_DB' in env || !isoTime(at)) throw new Error('personal_cloud_boundary');
  const c = PersonalCloudSchema.parse(input),
    binding = env.PERSONAL_CLOUD;
  const digest = await hash(stable(c));
  if (
    digest !== binding.contract_hash ||
    c.cloud.account_id !== binding.account_id ||
    c.cloud.private_database_id !== binding.private_database_id ||
    c.cloud.bucket !== binding.bucket ||
    c.decision.retention.store_id !== env.PERSONAL_STORE_ID
  )
    throw new Error('personal_cloud_scope_mismatch');
  if (
    (env.ENVIRONMENT === 'test') !== (c.data_origin === 'synthetic') ||
    env.ENVIRONMENT === 'development'
  )
    throw new Error('personal_synthetic_boundary');
  if ((await hash(stable(c.config))) !== c.config_sha256)
    throw new Error('personal_config_hash_mismatch');
  if (at < c.decision.approved_at) throw new Error('personal_approval_not_effective');
  verified.add(env);
  return { contract: c, contract_hash: digest };
}
