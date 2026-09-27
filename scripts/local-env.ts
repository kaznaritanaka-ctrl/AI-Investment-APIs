import { URL as NodeURL } from 'node:url';
import { Miniflare, Log, LogLevel } from 'miniflare';
import { readFile, mkdir } from 'node:fs/promises';
import type { CollectorEnv } from '../src/schema';
export async function localEnv(environment: 'test' | 'development' = 'test', persist?: string) {
  if (persist) await mkdir(persist, { recursive: true });
  const mf = new Miniflare({
    cf: false,
    modules: true,
    script: 'export default {fetch(){return new Response("local-only")}}',
    compatibilityDate: '2026-07-30',
    log: new Log(LogLevel.ERROR),
    d1Databases: ['PRIVATE_DB', 'PUBLIC_DB'],
    r2Buckets: ['EVIDENCE'],
    ...(persist ? { d1Persist: persist + '/d1', r2Persist: persist + '/r2' } : {}),
  });
  const env: CollectorEnv = {
    PRIVATE_DB: (await mf.getD1Database('PRIVATE_DB')) as unknown as D1Database,
    PUBLIC_DB: (await mf.getD1Database('PUBLIC_DB')) as unknown as D1Database,
    EVIDENCE: (await mf.getR2Bucket('EVIDENCE')) as unknown as R2Bucket,
    ENVIRONMENT: environment,
    AGENT_ENABLED: 'false',
  };
  for (const [db, name] of [
    [env.PRIVATE_DB, 'private'],
    [env.PUBLIC_DB, 'public'],
  ] as const) {
    const exists = await db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
      .bind(name === 'private' ? 'sources' : 'source_publications')
      .first();
    if (!exists)
      await db.exec(
        await readFile(
          new NodeURL('../migrations/' + name + '/0001_initial.sql', import.meta.url),
          'utf8',
        ),
      );
  }
  return { env, mf };
}
