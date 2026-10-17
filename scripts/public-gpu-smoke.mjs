import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
// One-time local acceptance only. Never a daily manual production procedure.
if (!process.argv.includes('--allow-network')) throw new Error('explicit_network_opt_in_required');
mkdirSync('work', { recursive: true });
await build({
  entryPoints: ['scripts/public-gpu-smoke.ts'],
  bundle: true,
  packages: 'external',
  platform: 'node',
  format: 'esm',
  outfile: 'work/public-gpu-smoke.mjs',
  logLevel: 'warning',
});
const r = spawnSync(process.execPath, ['work/public-gpu-smoke.mjs', ...process.argv.slice(2)], {
  stdio: 'inherit',
  windowsHide: true,
  env: {
    ...process.env,
    WRANGLER_SEND_METRICS: 'false',
    WRANGLER_LOG_PATH: resolve('work/wrangler.log'),
  },
});
if (r.error) throw r.error;
process.exit(r.status ?? 1);
