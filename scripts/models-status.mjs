import { readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const args = process.argv.slice(2),
  remote = args.includes('--remote'),
  local = args.includes('--local');
if (
  args.some((x) => !['--remote', '--local', '--allow-network'].includes(x)) ||
  (remote && local) ||
  (remote && !args.includes('--allow-network'))
)
  throw new Error('Use offline default, --local, or --remote --allow-network for read-only state');
const settings = read('config/deployment.json');
if (
  remote &&
  process.env.CLOUDFLARE_ACCOUNT_ID &&
  process.env.CLOUDFLARE_ACCOUNT_ID !== settings.account_id
)
  throw new Error('environment_target_account_mismatch');
const sources = readdirSync('config/sources')
  .filter((x) => x.endsWith('.json'))
  .map((x) => read('config/sources/' + x));
const describe = (s, proposal = false) => ({
  source_id: s.source_id,
  dataset: s.models ? ['ai_model_catalog', 'ai_api_prices'] : [s.dataset_type],
  implementation: s.adapter === 'candidate' ? 'candidate_only' : 'implemented',
  enabled: s.enabled,
  proposal,
  policy_version: s.policy.version,
  collection_rights: ['automated_collection', 'private_storage', 'internal_analysis'].map((k) => ({
    right: k,
    state: s.policy.rights[k],
  })),
  publication_rights: [
    'public_display',
    'normalized_redistribution',
    'derived_redistribution',
    'commercial_redistribution',
  ].map((k) => ({ right: k, state: s.policy.rights[k] })),
  providers: s.models?.providers ?? null,
  selection: s.selection,
  fields: s.models?.fields ?? s.policy.fields,
  authentication: s.authentication_required ? 'secrets_not_checked' : 'no_key_required',
  deployment: 'not_verified',
  production_collecting: 'not_verified',
});
const report = {
  mode: remote ? 'remote_read_only' : local ? 'local_read_only' : 'offline',
  stage: settings.stage,
  network_performed: false,
  deployed: false,
  sources: sources.map((s) => describe(s)),
  expansion: describe(read('config/proposals/models_dev.v3.json'), true),
  runtime: null,
  missing_reason:
    remote || local
      ? null
      : 'database_not_queried; configured enabled does not establish production collection',
};
if (remote || local) {
  mkdirSync('work', { recursive: true });
  await build({
    entryPoints: ['src/models-status.ts'],
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    outfile: 'work/models-status.mjs',
    logLevel: 'warning',
  });
  const { modelStatusSQL: sql, formatModelStatus } = await import(
    pathToFileURL(resolve('work/models-status.mjs')).href
  );
  const r = spawnSync(
    process.execPath,
    [
      'node_modules/wrangler/bin/wrangler.js',
      'd1',
      'execute',
      'PRIVATE_DB',
      '--config',
      'wrangler.collector.jsonc',
      remote ? '--remote' : '--local',
      '--command',
      sql,
      '--json',
    ],
    {
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
      maxBuffer: 2e6,
    },
  );
  report.network_performed = remote;
  if (r.status !== 0) {
    report.missing_reason = 'status_query_failed_or_0003_not_applied';
    process.exitCode = 2;
  } else {
    report.runtime = formatModelStatus(
      JSON.parse(r.stdout).flatMap((r) => r.results ?? []),
      sources,
      new Date().toISOString(),
    );
    report.missing_reason =
      'DB records are evidence of recorded runs, not proof of a currently installed Cron';
  }
}
console.log(JSON.stringify(report, null, 2));
