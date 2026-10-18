import { z } from 'zod';
import { PersonalCloudSchema } from './personal-contract';
import {
  cloudPersonalEnv,
  exportCloudPersonal,
  cleanCloudPersonal,
  cloudSource,
} from './personal-cloud';
import type { CollectorEnv } from '../schema';
import { hash, stable } from '../util';
import { collectPersonalGpu, type PersonalOptions } from './personal';
import { nasExportBinding, syncNasExport } from './nas-export';

const Pins = z
  .object({
    account_id: z.string().regex(/^[a-f0-9]{32}$/),
    private_database_id: z.uuid(),
    bucket: z.string().regex(/^[a-z0-9][a-z0-9-]{2,62}$/),
    contracts: z
      .array(
        z
          .object({ source_id: cloudSource, contract_hash: z.string().regex(/^[a-f0-9]{64}$/) })
          .strict(),
      )
      .min(1)
      .max(2),
  })
  .strict()
  .refine((v) => new Set(v.contracts.map((c) => c.source_id)).size === v.contracts.length);

// Initial acquisition needs a SECOND explicit flag and the immutable 24-hour contract.
// Missing flags/pins is the shipped state. No HTTP control endpoint or additional Cron.
export async function personalCloudScheduled(base: CollectorEnv, opt: PersonalOptions = {}) {
  if (base.PERSONAL_MAINTENANCE_ENABLED !== 'true') return [];
  if (base.ENVIRONMENT !== 'test' && (opt.now || opt.fetcher))
    throw new Error('personal_synthetic_boundary');
  const pins = Pins.parse(JSON.parse(base.PERSONAL_CLOUD_PINS ?? 'null'));
  const transport = nasExportBinding(base, pins);
  const results = [];
  for (const pin of pins.contracts) {
    try {
      const key = 'personal-research/control/contracts/' + pin.source_id + '.json',
        object = await base.EVIDENCE.get(key);
      if (!object || object.size > 65536) throw new Error('personal_contract_missing');
      const contract = PersonalCloudSchema.parse(await object.json());
      if (
        contract.config.source.source_id !== pin.source_id ||
        (await hash(stable(contract))) !== pin.contract_hash
      )
        throw new Error('personal_contract_mismatch');
      const env = cloudPersonalEnv(base, contract, { ...pins, contract_hash: pin.contract_hash });
      const at = (opt.now ?? (() => new Date().toISOString()))();
      let acquisition = 'not_requested';
      if (
        base.PERSONAL_INITIAL_COLLECTION_ENABLED === 'true' &&
        at >= contract.decision.acquisition_from &&
        at < contract.decision.acquisition_until
      ) {
        try {
          acquisition = (await collectPersonalGpu(env, contract, { ...opt, allow_network: true }))
            .state;
        } catch {
          acquisition = 'blocked_or_failed';
        }
      }
      const state = await exportCloudPersonal(env, base.EVIDENCE, contract, opt);
      await cleanCloudPersonal(base.EVIDENCE, pin.source_id, at);
      const exported = await syncNasExport(base, transport, pin.source_id, 'initial', at);
      results.push({
        source_id: pin.source_id,
        state: state.state,
        acquisition,
        nas_export: exported.state,
      });
    } catch {
      results.push({ source_id: pin.source_id, state: 'maintenance_failed' });
    }
  }
  return results;
}
