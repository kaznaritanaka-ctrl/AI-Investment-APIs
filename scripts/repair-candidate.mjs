import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  symlinkSync,
  openSync,
  closeSync,
} from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';
import { createHash } from 'node:crypto';

// Local-only deterministic candidate builder. No credentials, remote git, fetch,
// AI calls, migration, source activation, notification or deployment capability.
const args = process.argv.slice(2);
const permitted = ['--demo', '--verify', '--evidence', '--baseline'];
for (let i = 0; i < args.length; i++) {
  if (!permitted.includes(args[i])) throw new Error('unsupported_repair_argument');
  if (['--evidence', '--baseline'].includes(args[i]) && (!args[++i] || args[i].startsWith('--')))
    throw new Error('repair_argument_missing');
}
const value = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : null);
const demo = args.includes('--demo');
if (!demo && !value('--evidence')) {
  console.log(
    'Local only: repair:prepare --demo [--verify], or --evidence <private quarantine file> [--baseline <normal evidence file>] [--verify]. No network or production actions.',
  );
  process.exit(0);
}
if (demo && (value('--evidence') || value('--baseline')))
  throw new Error('demo_and_live_inputs_must_not_mix');
const repo = process.cwd();
const git = process.platform === 'win32' ? 'C:/Program Files/Git/cmd/git.exe' : 'git';
const cleanEnv = Object.fromEntries(
  [
    'PATH',
    'Path',
    'SystemRoot',
    'SYSTEMROOT',
    'WINDIR',
    'TEMP',
    'TMP',
    'TMPDIR',
    'PATHEXT',
    'ComSpec',
  ]
    .filter((k) => process.env[k])
    .map((k) => [k, process.env[k]]),
);
Object.assign(cleanEnv, {
  WRANGLER_SEND_METRICS: 'false',
  AI_APIS_TEMP_DIR: process.env.TEMP ?? '/tmp',
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'safe.directory',
  GIT_CONFIG_VALUE_0: repo,
});
function gitRead(...argv) {
  const r = spawnSync(git, argv, { cwd: repo, env: cleanEnv, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error('local_git_operation_failed');
  return r.stdout.trim();
}
if (gitRead('status', '--porcelain=v1'))
  throw new Error('freeze_and_commit_candidate_base_before_repair');
const base = gitRead('rev-parse', 'HEAD');
const toolsDir = join(repo, 'work/recovery-tool');
mkdirSync(toolsDir, { recursive: true });
await build({
  entryPoints: [
    'src/repair.ts',
    'src/recovery-evidence.ts',
    'src/models.ts',
    'src/sources.ts',
    'src/schema-drift.ts',
    'tests/models-helpers.ts',
  ],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outdir: toolsDir,
  outbase: '.',
  logLevel: 'silent',
});
const { reparseWrapperCandidate, repairPacket, repairGate } = await import(
  pathToFileURL(join(toolsDir, 'src/repair.js'))
);
const { projectModelCatalog, readModelEvidence } = await import(
  pathToFileURL(join(toolsDir, 'src/models.js'))
);
const { captureModelFields, recoveryPolicyHash } = await import(
  pathToFileURL(join(toolsDir, 'src/schema-drift.js'))
);
const { sources } = await import(pathToFileURL(join(toolsDir, 'src/sources.js')));
const { validateQuarantine } = await import(
  pathToFileURL(join(toolsDir, 'src/recovery-evidence.js'))
);
const sha = (text) => createHash('sha256').update(text).digest('hex');
let s,
  evidence,
  prior = null,
  now = new Date().toISOString();
if (demo) {
  const { expandedSource, catalog } = await import(
    pathToFileURL(join(toolsDir, 'tests/models-helpers.js'))
  );
  s = expandedSource();
  now = '2026-10-05T18:30:00.000Z';
  const observed = '2026-10-05T18:18:00.000Z';
  const original = catalog(5);
  prior = await projectModelCatalog(JSON.stringify(original), s);
  const text = JSON.stringify({ data: original });
  const capture = captureModelFields(text, s);
  evidence = {
    format: 'quarantine_evidence_v1',
    source_id: s.source_id,
    run_id: sha(s.source_id + '|2026-10-05T18:17:00.000Z'),
    policy_version: s.policy.version,
    policy_hash: await recoveryPolicyHash(s),
    observed_at: observed,
    expires_at: new Date(Date.parse(observed) + s.policy.retention_days * 86400000).toISOString(),
    synthetic: true,
    purpose: 'recovery_only_never_public',
    raw_response: false,
    source_payload_hash: sha(text),
    body: capture.body,
    body_hash: sha(capture.body ?? ''),
    wrapper: capture.wrapper,
    complete_projection: capture.complete,
    record_count: capture.record_count,
    diagnostics: capture.diagnostics,
  };
} else {
  evidence = JSON.parse(readFileSync(resolve(value('--evidence')), 'utf8'));
  s = sources.find((item) => item.source_id === evidence.source_id);
  if (!s || evidence.synthetic) throw new Error('unsupported_or_mixed_repair_input');
  if (value('--baseline')) {
    const baseline = JSON.parse(readFileSync(resolve(value('--baseline')), 'utf8'));
    const stamp = Date.parse(baseline.observed_at);
    if (
      !Number.isFinite(stamp) ||
      stamp > Date.parse(now) ||
      stamp + (s.models?.retention.evidence_days ?? 0) * 86400000 <= Date.parse(now) ||
      baseline.synthetic
    )
      throw new Error('baseline_expired_or_mixed_input');
    prior = await readModelEvidence(s, baseline);
  }
}
evidence = await validateQuarantine(s, evidence, now, demo ? 'test' : 'development');
let plan;
try {
  plan = await reparseWrapperCandidate(s, evidence, now, prior);
} catch {
  const blocked = join(
    repo,
    'work/repairs',
    sha(base + '|' + evidence.body_hash + '|blocked').slice(0, 16),
  );
  if (existsSync(blocked)) throw new Error('repair_candidate_already_exists_no_overwrite');
  mkdirSync(blocked, { recursive: true });
  writeFileSync(
    join(blocked, 'ai-input.json'),
    JSON.stringify(repairPacket(s, evidence), null, 2) + '\n',
  );
  writeFileSync(
    join(blocked, 'repair-result.json'),
    JSON.stringify(
      {
        schema_version: 1,
        source_id: s.source_id,
        run_id: evidence.run_id,
        evidence_hash: evidence.body_hash,
        synthetic: demo,
        patch: 'not_generated',
        regression: 'not_run',
        reparse: 'blocked',
        human_action: 'review_semantics_or_incomplete_evidence',
        production_deploy_allowed: false,
        publication_allowed: false,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    JSON.stringify({
      output: blocked,
      state: 'human_review_required',
      source_payload_exported: false,
    }),
  );
  process.exit(2);
}
const id = sha(base + '|' + evidence.body_hash + '|' + plan.candidate_parser_version).slice(0, 16);
const out = join(repo, 'work/repairs', id);
const checkout = join(repo, 'work/repair-worktrees', id);
if (existsSync(out) || existsSync(checkout))
  throw new Error('repair_candidate_already_exists_no_overwrite');
mkdirSync(out, { recursive: true });
mkdirSync(resolve(checkout, '..'), { recursive: true });
const branch = 'codex/repair-' + id;
gitRead('worktree', 'add', '-b', branch, checkout, base);
symlinkSync(
  join(repo, 'node_modules'),
  join(checkout, 'node_modules'),
  process.platform === 'win32' ? 'junction' : 'dir',
);
const file = join(checkout, 'src/models.ts');
const original = readFileSync(file, 'utf8');
const needle = '  const root = object(parsed);';
if (
  original.split(needle).length !== 2 ||
  !original.includes("export const MODELS_PARSER = '" + plan.base_parser_version + "';")
)
  throw new Error('parser_patch_context_changed');
const changed = original
  .replace(
    needle,
    `  const outer = object(parsed);\n  const wrapped = Object.hasOwn(outer, '${plan.wrapper}');\n  if (wrapped && Object.keys(outer).some(k => k !== '${plan.wrapper}')) throw new Error('unexpected_catalog_structure');\n  const root = object(wrapped ? outer.${plan.wrapper} : parsed);`,
  )
  .replace(
    "export const MODELS_PARSER = '" + plan.base_parser_version + "';",
    "export const MODELS_PARSER = '" + plan.candidate_parser_version + "';",
  );
writeFileSync(file, changed);
const fixture = {
  [plan.wrapper]: Object.fromEntries(
    s.models.providers.map((provider) => [
      provider,
      {
        id: provider,
        models: {
          'synthetic-repair-model': {
            id: 'synthetic-repair-model',
            cost: { input: 1, output: 2 },
            limit: { context: 8192 },
          },
        },
      },
    ]),
  ),
};
writeFileSync(
  join(checkout, 'tests/fixtures/models-wrapper.synthetic.json'),
  JSON.stringify(fixture, null, 2) + '\n',
);
writeFileSync(
  join(checkout, 'tests/generated-wrapper.test.ts'),
  `import { it, expect } from 'vitest';\nimport { projectModelCatalog, MODELS_PARSER } from '../src/models';\nimport { expandedSource } from './models-helpers';\nimport wrapped from './fixtures/models-wrapper.synthetic.json';\nit('reparses the wrapper contract without changing identity, decimal, currency or unit', async () => {\n const s = expandedSource(${JSON.stringify(s.models.providers)});\n const p = await projectModelCatalog(JSON.stringify(wrapped), s);\n expect(MODELS_PARSER).toBe(${JSON.stringify(plan.candidate_parser_version)});\n expect(p.complete).toBe(true);\n expect(p.records).toHaveLength(${s.models.providers.length});\n for (const r of p.records) {\n  expect(r.catalog.model_id).toBe('synthetic-repair-model');\n  expect(r.key).toBe(r.catalog.serving_provider + '/synthetic-repair-model');\n  expect(r.price?.price_components.map(c => [c.amount_decimal,c.currency,c.unit])).toEqual([['1','USD','million_tokens'],['2','USD','million_tokens']]);\n }\n});\n`,
);
const candidateEnv = {
  ...cleanEnv,
  GIT_CONFIG_VALUE_0: checkout,
  WRANGLER_LOG_PATH: join(out, 'wrangler.log'),
};
const format = spawnSync(
  process.execPath,
  [
    'node_modules/prettier/bin/prettier.cjs',
    '--write',
    'src/models.ts',
    'tests/generated-wrapper.test.ts',
  ],
  { cwd: checkout, env: candidateEnv, encoding: 'utf8', windowsHide: true },
);
if (format.status !== 0) throw new Error('candidate_format_failed');
const stage = spawnSync(
  git,
  ['add', '-N', 'tests/generated-wrapper.test.ts', 'tests/fixtures/models-wrapper.synthetic.json'],
  { cwd: checkout, env: candidateEnv, encoding: 'utf8', windowsHide: true },
);
if (stage.status !== 0) throw new Error('candidate_diff_registration_failed');
const diff = spawnSync(
  git,
  [
    'diff',
    '--binary',
    '--',
    'src/models.ts',
    'tests/generated-wrapper.test.ts',
    'tests/fixtures/models-wrapper.synthetic.json',
  ],
  { cwd: checkout, env: candidateEnv, encoding: 'utf8', windowsHide: true },
);
if (diff.status !== 0 || !diff.stdout) throw new Error('candidate_patch_failed');
writeFileSync(join(out, 'candidate.patch'), diff.stdout);
writeFileSync(
  join(out, 'ai-input.json'),
  JSON.stringify(repairPacket(s, evidence), null, 2) + '\n',
);
// Reparse in memory; do not create an unmanaged extra copy of retained source data.
await build({
  entryPoints: [file],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: join(out, 'candidate-models.mjs'),
  logLevel: 'silent',
});
const candidate = await import(pathToFileURL(join(out, 'candidate-models.mjs')));
const actual = await candidate.projectModelCatalog(evidence.body, s);
if (
  !actual.complete ||
  JSON.stringify(actual.records) !== JSON.stringify(plan.projection.records) ||
  candidate.MODELS_PARSER !== plan.candidate_parser_version
)
  throw new Error('patched_parser_reparse_mismatch');
const receipts = [];
if (args.includes('--verify')) {
  const commands = [
    ['check', ['scripts/run.mjs', 'check']],
    ['regression', ['scripts/run.mjs', 'test', '--testTimeout', '60000', '--reporter', 'verbose']],
    ['runtime', ['scripts/run.mjs', 'runtime']],
    ['build', ['scripts/run.mjs', 'build']],
    ['preflight', ['scripts/preflight.mjs']],
  ];
  for (const [name, argv] of commands) {
    const fd = openSync(join(out, name + '.log'), 'wx');
    const started = new Date().toISOString();
    const r = spawnSync(process.execPath, argv, {
      cwd: checkout,
      env: candidateEnv,
      stdio: ['ignore', fd, fd],
      timeout: 1800000,
      windowsHide: true,
    });
    closeSync(fd);
    receipts.push({
      name,
      command: ['node', ...argv],
      exit_code: r.status,
      started_at: started,
      finished_at: new Date().toISOString(),
      patch_sha256: sha(diff.stdout),
      evidence_hash: evidence.body_hash,
    });
    writeFileSync(join(out, 'test-receipts.json'), JSON.stringify(receipts, null, 2));
    console.log(name + ': ' + (r.status === 0 ? 'passed' : 'failed'));
    if (r.status !== 0) break;
  }
}
const finalDiff = spawnSync(
  git,
  [
    'diff',
    '--binary',
    '--',
    'src/models.ts',
    'tests/generated-wrapper.test.ts',
    'tests/fixtures/models-wrapper.synthetic.json',
  ],
  { cwd: checkout, env: candidateEnv, encoding: 'utf8', windowsHide: true },
);
if (finalDiff.status !== 0 || sha(finalDiff.stdout) !== sha(diff.stdout))
  throw new Error('candidate_changed_during_verification');
const allPassed = receipts.length === 5 && receipts.every((r) => r.exit_code === 0);
const checks = {
  ...plan.checks,
  regression_pass: allPassed,
  new_contract_pass: allPassed,
  parser_version_changed: true,
  rollback_available: true,
  upstream_semantics_confirmed: demo ? true : null,
  current_source_authorization_verified: demo ? true : null,
};
const { projection: _privateProjection, ...result } = plan;
const report = {
  ...result,
  base_commit: base,
  branch,
  worktree: checkout,
  patch_sha256: sha(diff.stdout),
  candidate_source_sha256: sha(readFileSync(file)),
  regression_result: allPassed ? 'passed' : receipts.length ? 'failed' : 'not_run',
  new_contract_result: allPassed ? 'passed' : 'not_run',
  reparse_result: 'passed_with_patched_parser',
  checks,
  gate: repairGate(checks),
  synthetic: demo,
  public_data_written: false,
  external_llm_called: false,
  receipts,
};
writeFileSync(join(out, 'repair-result.json'), JSON.stringify(report, null, 2) + '\n');
console.log(
  JSON.stringify(
    {
      output: out,
      branch,
      synthetic: demo,
      regression: report.regression_result,
      reparse: report.reparse_result,
      gate: report.gate,
    },
    null,
    2,
  ),
);
if (args.includes('--verify') && !allPassed) process.exitCode = 2;
