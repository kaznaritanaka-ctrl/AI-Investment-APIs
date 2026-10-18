import { z } from 'zod';
import type { CollectorEnv } from '../schema';
import type { PersonalOptions } from './personal';
import {
  registerDaily,
  collectDaily,
  exportDailyHistory,
  maintainDaily,
  dailyMonitor,
  dailyJSON,
  type DailyEnv,
} from './personal-daily';
import { dailySource, digest } from './daily-protocol';
const Pins = z
  .object({
    account_id: z.string().regex(/^[a-f0-9]{32}$/),
    private_database_id: z.uuid(),
    bucket: z.string().regex(/^[a-z0-9][a-z0-9-]{2,62}$/),
    contracts: z
      .array(z.object({ source_id: dailySource, contract_hash: digest }).strict())
      .min(1)
      .max(2),
  })
  .strict()
  .refine((v) => new Set(v.contracts.map((c) => c.source_id)).size === v.contracts.length);
export async function dailyScheduled(base: CollectorEnv, opt: PersonalOptions = {}) {
  if (base.PERSONAL_DAILY_MAINTENANCE_ENABLED !== 'true') return [];
  if (base.ENVIRONMENT !== 'test' && (opt.now || opt.fetcher))
    throw new Error('daily_synthetic_boundary');
  const pins = Pins.parse(JSON.parse(base.PERSONAL_DAILY_PINS ?? 'null')),
    at = (opt.now ?? (() => new Date().toISOString()))();
  // Capabilities projected explicitly; never forward PUBLIC_DB to personal code.
  const env: DailyEnv = {
    PRIVATE_DB: base.PRIVATE_DB,
    EVIDENCE: base.EVIDENCE,
    ENVIRONMENT: base.ENVIRONMENT,
    NAS_HEALTH: base.NAS_HEALTH,
    NAS_RECEIPT_SECRET: base.NAS_RECEIPT_SECRET,
  };
  const results = [];
  for (const pin of pins.contracts) {
    try {
      const input = await dailyJSON(
          base.EVIDENCE,
          'personal-daily/contracts/' + pin.source_id + '.json',
          65536,
        ),
        binding = { ...pins, contract_hash: pin.contract_hash };
      const { c } = await registerDaily(env, input, binding, at);
      let collection = 'disabled';
      const partial = await env.PRIVATE_DB.prepare(
        "SELECT day FROM personal_daily_runs WHERE source_id=? AND contract_hash=? AND state='partial' AND evidence_expires_at>? ORDER BY day LIMIT 1",
      )
        .bind(pin.source_id, pin.contract_hash, at)
        .first<string>('day');
      if (partial)
        try {
          await collectDaily(env, c, binding, { ...opt, allow_network: true }, partial);
        } catch {
          /* saved projection only, no backfill HTTP */
        }
      if (base.PERSONAL_DAILY_COLLECTION_ENABLED === 'true')
        try {
          collection = (await collectDaily(env, c, binding, { ...opt, allow_network: true })).state;
        } catch {
          collection = 'blocked_or_failed';
        }
      // Maintenance and export continue even when new acquisition is held or has failed.
      const maintenance = await maintainDaily(env, pin.source_id, at);
      let history = 'blocked';
      try {
        history = (await exportDailyHistory(env, pin.source_id, at)).state;
      } catch {
        /* current authority is required */
      }
      const nas = await dailyMonitor(env, c, at);
      results.push({
        source_id: pin.source_id,
        collection,
        maintenance: maintenance.state,
        history,
        nas: nas.state,
      });
    } catch {
      results.push({ source_id: pin.source_id, state: 'configuration_or_maintenance_failed' });
    }
  }
  return results;
}
