import { inspectPersonalContract, PersonalContractSchema } from '../src/research/personal-contract';
import { errorCode } from '../src/util';
export async function inspectPersonalPreparation(input: unknown, at: string) {
  const parsed = PersonalContractSchema.safeParse(input);
  let reason: string | null = null;
  try {
    await inspectPersonalContract(
      input,
      at,
      parsed.success && parsed.data.data_origin === 'synthetic' ? 'test' : 'development',
      'collect',
    );
  } catch (error) {
    reason = errorCode(error);
  }
  return {
    scope: 'offline_configuration_only',
    status: reason ? 'blocked' : 'configuration_passed',
    reason,
    source_id: parsed.success ? parsed.data.config.source.source_id : null,
    authority_kind: 'owner_personal_research_exception',
    provider_permission: 'unconfirmed',
    data_origin: parsed.success ? parsed.data.data_origin : null,
    network_performed: false,
    storage_opened: false,
    live_verified: false,
    production_ready: false,
  };
}
