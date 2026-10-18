import { mkdir } from 'node:fs/promises';
import { Miniflare, Log, LogLevel } from 'miniflare';
import { applyMigrations } from './migrations';
import type { PersonalEnv } from '../src/research/personal';

// Local simulations only. This capability set deliberately has no PUBLIC_DB.
export async function personalLocalEnv(
  storeId: string,
  environment: 'test' | 'development' = 'test',
  persist?: string,
) {
  if (persist) await mkdir(persist, { recursive: true });
  const mf = new Miniflare({
    cf: false,
    modules: true,
    script: 'export default {fetch(){return new Response(null,{status:404})}}',
    compatibilityDate: '2026-07-30',
    log: new Log(LogLevel.ERROR),
    d1Databases: ['PRIVATE_DB'],
    r2Buckets: ['EVIDENCE', 'NAS_EXPORT', 'NAS_HEALTH'],
    ...(persist ? { d1Persist: persist + '/d1', r2Persist: persist + '/r2' } : {}),
  });
  try {
    const env: PersonalEnv = {
      PRIVATE_DB: (await mf.getD1Database('PRIVATE_DB')) as unknown as D1Database,
      EVIDENCE: (await mf.getR2Bucket('EVIDENCE')) as unknown as R2Bucket,
      ENVIRONMENT: environment,
      PERSONAL_STORE_ID: storeId,
    };
    await applyMigrations(env.PRIVATE_DB, 'private');
    return { env, mf };
  } catch (error) {
    await mf.dispose();
    throw error;
  }
}
