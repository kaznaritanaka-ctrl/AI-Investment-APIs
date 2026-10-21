import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const temp = resolve(process.env.AI_APIS_TEMP_DIR ?? 'work/tmp');
mkdirSync(temp, { recursive: true });
const env = {
  ...process.env,
  TEMP: temp,
  TMP: temp,
  TMPDIR: temp,
  WRANGLER_LOG_PATH: resolve('work/wrangler.log'),
  WRANGLER_SEND_METRICS: 'false',
};
const mode = process.argv[2],
  extra = process.argv.slice(3);
const commands = {
  check: [
    [
      'node_modules/prettier/bin/prettier.cjs',
      '--check',
      'src/**/*.ts',
      'tests/**/*.ts',
      'scripts/**/*.ts',
      'scripts/**/*.mjs',
    ],
    ['node_modules/typescript/bin/tsc', '--noEmit'],
    ['scripts/check-boundaries.mjs'],
  ],
  test: [
    ['node_modules/vitest/vitest.mjs', 'run', ...extra],
    ['--test', 'scripts/resilience.test.mjs'],
  ],
  build: [
    [
      'node_modules/wrangler/bin/wrangler.js',
      'deploy',
      '--dry-run',
      '--config',
      'wrangler.collector.jsonc',
      '--outdir',
      'dist/collector',
    ],
    [
      'node_modules/wrangler/bin/wrangler.js',
      'deploy',
      '--dry-run',
      '--config',
      'wrangler.api.jsonc',
      '--outdir',
      'dist/api',
    ],
  ],
  runtime: [['scripts/runtime-smoke.mjs']],
  live: [['scripts/live-runner.mjs', ...extra]],
  dev: [
    ['node_modules/wrangler/bin/wrangler.js', 'dev', '--config', 'wrangler.api.jsonc', ...extra],
  ],
};
if (!Object.hasOwn(commands, mode)) throw new Error('Unknown command');
for (const args of commands[mode]) {
  const r = spawnSync(process.execPath, args, { env, stdio: 'inherit', windowsHide: true });
  if (r.error) throw r.error;
  if (r.status !== 0) process.exit(r.status ?? 1);
}
