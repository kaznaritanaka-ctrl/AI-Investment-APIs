import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
await build({
  absWorkingDir: process.cwd(),
  tsconfig: './tsconfig.json',
  entryPoints: ['./scripts/live-smoke.ts'],
  bundle: true,
  packages: 'external',
  platform: 'node',
  format: 'esm',
  outfile: 'work/live-smoke.mjs',
  logLevel: 'warning',
});
const r = spawnSync(process.execPath, ['work/live-smoke.mjs', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env,
  windowsHide: true,
});
if (r.error) throw r.error;
process.exitCode = r.status ?? 1;
