import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { SourceSchema } from '../src/schema';
import { canCollect } from '../src/policy';
import { collectModels } from '../src/models-pipeline';
import { localEnv } from './local-env';
if (!process.argv.includes('--allow-network')) throw new Error('network_opt_in_required');
const s = SourceSchema.parse(JSON.parse(await readFile('config/sources/models_dev.json', 'utf8')));
const now = () => new Date().toISOString(),
  slot = now();
if (!s.models || !canCollect(s, slot))
  throw new Error('reviewed_active_expansion_required; legacy/proposal untouched');
const local = await localEnv('development', 'work/live-models-state');
try {
  let result,
    invocations = 0;
  do {
    result = await collectModels(local.env, s, slot, { now });
    invocations++;
    if (invocations >= 120 && result.state === 'pending')
      throw new Error('local_live_invocation_budget_exhausted');
  } while (result.state === 'pending');
  const snapshot = await local.env.PRIVATE_DB.prepare(
    'SELECT snapshot_id,observed_at,state,complete_capture,model_count,price_count,component_count,quarantined_count,issues_json,metrics_json,data_origin FROM model_snapshots WHERE run_id=? ORDER BY recorded_at DESC LIMIT 1',
  )
    .bind(result.run_id)
    .first();
  const report = {
    test_kind: 'opt_in_local_live_expansion',
    environment: 'isolated_local_development',
    source_id: s.source_id,
    policy: s.policy.version,
    providers: s.models.providers,
    invocations,
    result,
    snapshot,
    production_deployed: false,
  };
  await mkdir('work', { recursive: true });
  await writeFile('work/models-live-report.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  if (result.state !== 'complete') process.exitCode = 2;
} finally {
  await local.mf.dispose();
}
