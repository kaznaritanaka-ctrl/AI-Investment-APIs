import { Miniflare, Log, LogLevel } from 'miniflare';
import { resolve } from 'node:path';
import { personalLocalEnv } from './personal-local-env';
import { checkedLocalPath, separatePaths, inspectPersonalVault } from './personal-vault';
import type { PersonalV2Contract } from '../src/research/personal-contract';

// The latest authority/attempt/deletion records live in the reviewed vault, outside
// the data DB and outside every data snapshot. Restoring data never restores them.
export async function personalContinuingEnv(
  c: PersonalV2Contract,
  primary: string,
  vault: string,
  environment: 'test' | 'development',
) {
  primary = await checkedLocalPath(primary);
  vault = await checkedLocalPath(vault);
  separatePaths(primary, vault);
  await inspectPersonalVault(vault, c);
  const data = await personalLocalEnv(c.decision.retention.store_id, environment, primary);
  let control: Miniflare | undefined;
  try {
    control = new Miniflare({
      cf: false,
      modules: true,
      script: 'export default { fetch(){ return new Response(null,{status:404}); } }',
      compatibilityDate: '2026-07-30',
      log: new Log(LogLevel.ERROR),
      r2Buckets: ['PERSONAL_CONTROL'],
      r2Persist: resolve(vault, 'control'),
    });
    const controlBucket = (await control.getR2Bucket('PERSONAL_CONTROL')) as unknown as R2Bucket;
    const target = data.env.EVIDENCE;
    const select = (key: string) => (key.startsWith('research-control/') ? controlBucket : target);
    const routed = new Proxy(target, {
      get(_target, property) {
        if (['get', 'put', 'head'].includes(String(property)))
          return (key: string, ...args: unknown[]) => {
            const bucket = select(key);
            return Reflect.apply(Reflect.get(bucket, property), bucket, [key, ...args]);
          };
        if (property === 'delete')
          return async (keys: string | string[]) => {
            for (const key of typeof keys === 'string' ? [keys] : keys)
              await select(key).delete(key);
          };
        if (property === 'list')
          return (options: R2ListOptions) => {
            if (!options?.prefix) throw new Error('personal_control_prefix_required');
            return select(options.prefix).list(options);
          };
        throw new Error('personal_bucket_operation_forbidden');
      },
    });
    return {
      env: { ...data.env, EVIDENCE: routed },
      dispose: async () => {
        await data.mf.dispose();
        await control!.dispose();
      },
    };
  } catch (error) {
    await data.mf.dispose();
    await control?.dispose();
    throw error;
  }
}
