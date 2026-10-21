import {
  refreshDailyExports,
  projectDailyExports,
  expireDailyExports,
} from '../src/research/daily-export';
import type { DailyEnv } from '../src/research/personal-daily';
import { exportFixture } from './nas-export-fixture';
import { stable } from '../src/util';
export async function dailyExportRuntime(env: DailyEnv & { NAS_EXPORT: R2Bucket }, step: number) {
  const at = new Date(Date.parse('2038-01-01T00:00:00.000Z') + step * 900000).toISOString();
  const base = {
    EVIDENCE: env.EVIDENCE,
    NAS_EXPORT: env.NAS_EXPORT,
    PERSONAL_EXPORT_PINS: stable(exportFixture()),
  };
  const results = [];
  for (const source of ['rebro_public', 'highreso_public']) {
    const refreshed = await refreshDailyExports(env, source, at);
    const projected = await projectDailyExports(env, base, exportFixture(), source, at);
    await expireDailyExports(env, base.NAS_EXPORT, source, at);
    results.push({ source, refreshed, projected });
  }
  return results;
}
