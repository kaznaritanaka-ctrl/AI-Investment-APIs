import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { localEnv } from './local-env';
import { ResearchConfigSchema, assertResearchAllowed } from '../src/research/schema';
import { isPublicGpu } from '../src/research/public-gpu-contract';
import { collectPublicGpuDay } from '../src/research/public-gpu';
import { errorCode } from '../src/util';

async function main() {
  const args = process.argv.slice(2);
  if (
    args.length !== 3 ||
    args[0] !== '--allow-network' ||
    args[1] !== '--approved-config' ||
    !args[2]
  )
    throw new Error('usage_allow_network_approved_config_path');
  const c = ResearchConfigSchema.parse(JSON.parse(await readFile(args[2], 'utf8')));
  if (!isPublicGpu(c.adapter)) throw new Error('research_scope_mismatch');
  const at = new Date().toISOString();
  // No local DB/R2 creation until a separately approved policy passes every gate.
  assertResearchAllowed(c, at, c.terms.version);
  const local = await localEnv(
    'development',
    resolve('work/private-public-gpu', c.source.source_id),
  );
  try {
    const previous = await local.env.PRIVATE_DB.prepare(
      'SELECT scheduled_for FROM research_runs WHERE source_id=? AND substr(scheduled_for,1,10)=? AND synthetic=0',
    )
      .bind(c.source.source_id, at.slice(0, 10))
      .first<{ scheduled_for: string }>();
    const results = await collectPublicGpuDay(
      local.env,
      [c],
      previous?.scheduled_for ?? at,
      () => ({
        allow_network: true,
        current_terms_version: c.terms.version,
      }),
    );
    console.log(JSON.stringify({ mode: 'local_live_opt_in', production: false, results }));
    if (results.some((r) => r.state !== 'complete')) process.exitCode = 1;
  } finally {
    await local.mf.dispose();
  }
}
main().catch((error) => {
  console.error(
    JSON.stringify({
      mode: 'local_live_opt_in',
      production: false,
      state: 'blocked',
      reason: errorCode(error),
    }),
  );
  process.exitCode = 1;
});
