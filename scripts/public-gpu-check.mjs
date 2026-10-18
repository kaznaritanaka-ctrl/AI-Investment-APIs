import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--config' || !args[1])) {
  console.error('usage: node scripts/public-gpu-check.mjs [--config <path>]');
  process.exit(2);
}
// No local-env, Miniflare, HTTP or disk bundle. Inspect each source independently.
const bundled = await build({
  absWorkingDir: root,
  entryPoints: ['scripts/public-gpu-preparation.ts'],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent',
});
const { inspectPublicGpuPreparation } = await import(
  'data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].contents).toString('base64')
);
const paths = args.length
  ? [resolve(args[1])]
  : ['highreso_public', 'rebro_public'].map((id) =>
      resolve(root, 'config/proposals/research', `${id}.json`),
    );
const now = new Date().toISOString();
const results = [];
for (const path of paths) {
  let config;
  try {
    config = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    // No path, raw config, error stack or source data in output.
    config = null;
  }
  results.push(inspectPublicGpuPreparation(config, now));
}
console.log(JSON.stringify({ checked_at: now, results }, null, 2));
if (results.some((r) => r.status !== 'configuration_passed')) process.exitCode = 2;
