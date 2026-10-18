import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { inspectPersonalContract } from '../src/research/personal-contract';
import {
  collectPersonalGpu,
  maintainPersonalGpu,
  readPersonalGpu,
  stopPersonalCollection,
  revokePersonalUse,
} from '../src/research/personal';
import { personalLocalEnv } from './personal-local-env';
import { errorCode } from '../src/util';
async function main() {
  const [mode, flag, path, ...extra] = process.argv.slice(2);
  if (
    flag !== '--contract' ||
    !path ||
    !['collect', 'read', 'maintain', 'watch', 'stop', 'revoke'].includes(mode)
  )
    throw new Error('personal_usage_invalid');
  if (
    mode === 'collect'
      ? extra.length !== 1 || extra[0] !== '--allow-network'
      : mode === 'stop' || mode === 'revoke'
        ? extra.length !== 2 || extra[0] !== '--basis-ref' || !extra[1]?.trim()
        : extra.length !== 0
  )
    throw new Error('personal_usage_invalid');
  const input = JSON.parse(await readFile(path, 'utf8'));
  // No store/migration is opened for a draft or synthetic contract.
  const { contract: c } = await inspectPersonalContract(
    input,
    new Date().toISOString(),
    'development',
    mode === 'collect' ? 'collect' : mode === 'read' ? 'read' : 'maintain',
  );
  if (c.version === 'personal-gpu-v2') throw new Error('personal_v2_use_automation_manifest');
  const local = await personalLocalEnv(
    c.decision.retention.store_id,
    'development',
    resolve('work/private-personal-gpu', c.decision.retention.store_id),
  );
  try {
    await maintainPersonalGpu(local.env, c);
    let result: unknown;
    if (mode === 'collect')
      result = await collectPersonalGpu(local.env, c, { allow_network: true });
    else if (mode === 'read') {
      const rows = await readPersonalGpu(local.env, c);
      result = {
        observation_count: rows.results.length,
        authority_kind: rows.authority_kind,
        provider_permission: rows.provider_permission,
      };
    } else if (mode === 'stop') {
      await stopPersonalCollection(local.env, c, extra[1]);
      result = { state: 'collection_stopped' };
    } else if (mode === 'revoke') result = await revokePersonalUse(local.env, c, extra[1]);
    else if (mode === 'watch') {
      const controller = new AbortController(),
        stop = () => controller.abort();
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      try {
        let last = '';
        while (!controller.signal.aborted) {
          const state = JSON.stringify(await maintainPersonalGpu(local.env, c));
          if (state !== last) {
            console.log(state);
            last = state;
          }
          try {
            await setTimeout(60000, undefined, { signal: controller.signal });
          } catch {
            if (!controller.signal.aborted) throw new Error('personal_maintenance_timer_failed');
          }
        }
      } finally {
        process.removeListener('SIGINT', stop);
        process.removeListener('SIGTERM', stop);
      }
      return;
    } else result = await maintainPersonalGpu(local.env, c);
    console.log(JSON.stringify({ mode: 'local_personal_research', production: false, result }));
  } finally {
    await local.mf.dispose();
  }
}
main().catch((error) => {
  console.error(JSON.stringify({ state: 'blocked', reason: errorCode(error), production: false }));
  process.exitCode = 1;
});
