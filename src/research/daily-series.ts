import { z } from 'zod';
import { PersonalDailySchema, type PersonalDailyContract } from './personal-contract';
import { hash, stable } from '../util';

export const DailySeriesDefinition = z
  .object({
    version: z.literal('daily-comparison-v1'),
    source_id: z.enum(['highreso_public', 'rebro_public']),
    endpoint: z.url(),
    method_version: z.string(),
    scope: z
      .object({ models: z.array(z.string()), gpu_counts: z.array(z.number()).nullable() })
      .strict(),
    normalization_version: z.string(),
    unit_definition: z.string(),
  })
  .strict();
// Permission/review/retention/size budgets are not price-series definitions.
// Changing this definition splits the series; no implicit compatibility aliases.
export function dailySeriesDefinition(c: PersonalDailyContract) {
  if (!('models' in c.config.scope)) throw new Error('daily_series_scope');
  return DailySeriesDefinition.parse({
    version: 'daily-comparison-v1',
    source_id: c.config.source.source_id,
    endpoint: c.config.source.endpoint,
    method_version: c.config.method_version,
    scope: {
      models: [...c.config.scope.models].sort(),
      gpu_counts:
        'gpu_counts' in c.config.scope
          ? [...(c.config.scope.gpu_counts ?? [])].sort((a, b) => a - b)
          : null,
    },
    normalization_version: c.comparison?.normalization_version ?? 'domestic-gpu-normalization-v1',
    unit_definition:
      c.comparison?.unit_definition ??
      (c.config.adapter === 'highreso_public'
        ? 'JPY:node_hour|month:instance:v1'
        : 'JPY:gpu:single_gpu:v1'),
  });
}
export async function indexDailySeries(db: D1Database, source: string) {
  const rows = await db
    .prepare(
      'SELECT c.* FROM personal_daily_contracts c LEFT JOIN personal_daily_series_contracts s ON s.contract_hash=c.contract_hash WHERE c.source_id=? AND s.contract_hash IS NULL LIMIT 20',
    )
    .bind(source)
    .all<{ contract_hash: string; contract_json: string }>();
  const batch = [];
  for (const row of rows.results) {
    const c = PersonalDailySchema.parse(JSON.parse(row.contract_json));
    if ((await hash(stable(c))) !== row.contract_hash) throw new Error('daily_contract_conflict');
    const definition = dailySeriesDefinition(c);
    batch.push(
      db
        .prepare('INSERT OR IGNORE INTO personal_daily_series_contracts VALUES (?,?,?)')
        .bind(row.contract_hash, await hash(stable(definition)), stable(definition)),
    );
  }
  for (const statement of batch) await statement.run();
  return !(await db
    .prepare(
      'SELECT 1 FROM personal_daily_contracts c LEFT JOIN personal_daily_series_contracts s ON s.contract_hash=c.contract_hash WHERE c.source_id=? AND s.contract_hash IS NULL LIMIT 1',
    )
    .bind(source)
    .first());
}
