import { build } from 'esbuild';
import { readFile, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
const args = process.argv.slice(2);
if (
  !['check', 'collect', 'read', 'maintain', 'watch', 'stop', 'revoke'].includes(args[0]) ||
  args[1] !== '--contract' ||
  !args[2]
) {
  console.error(
    'usage: personal-gpu.mjs <check|collect|read|maintain|watch|stop|revoke> --contract <path> [--allow-network|--basis-ref <ref>]',
  );
  process.exit(2);
}
if (args[0] === 'check') {
  if (args.length !== 3) process.exit(2);
  const bundled = await build({
    entryPoints: ['scripts/personal-preparation.ts'],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent',
  });
  const { inspectPersonalPreparation } = await import(
    'data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].contents).toString('base64')
  );
  let input;
  try {
    input = JSON.parse(await readFile(args[2], 'utf8'));
  } catch {
    input = null;
  }
  const result = await inspectPersonalPreparation(input, new Date().toISOString());
  console.log(JSON.stringify(result));
  if (result.status !== 'configuration_passed') process.exitCode = 2;
} else {
  await mkdir('work', { recursive: true });
  await build({
    entryPoints: ['scripts/personal-gpu.ts'],
    bundle: true,
    packages: 'external',
    platform: 'node',
    format: 'esm',
    outfile: 'work/personal-gpu.mjs',
    logLevel: 'warning',
  });
  const result = spawnSync(process.execPath, ['work/personal-gpu.mjs', ...args], {
    stdio: 'inherit',
    windowsHide: true,
    env: {
      ...process.env,
      WRANGLER_SEND_METRICS: 'false',
      WRANGLER_LOG_PATH: resolve('work/wrangler.log'),
    },
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
