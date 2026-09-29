import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
if (process.argv.length !== 3 || process.argv[2] !== '--allow-network')
  throw new Error(
    'Explicit opt-in required: pnpm models:live --allow-network; reviewed active models scope also required',
  );
const temp = resolve(process.env.AI_APIS_TEMP_DIR ?? 'work/tmp');
mkdirSync(temp, { recursive: true });
await build({
  entryPoints: ['scripts/models-live.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  outfile: 'work/models-live.mjs',
  logLevel: 'warning',
});
const result = spawnSync(process.execPath, ['work/models-live.mjs', '--allow-network'], {
  stdio: 'inherit',
  windowsHide: true,
  env: { ...process.env, TEMP: temp, TMP: temp, TMPDIR: temp, WRANGLER_SEND_METRICS: 'false' },
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
