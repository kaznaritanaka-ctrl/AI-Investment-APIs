import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
await mkdir('work', { recursive: true });
const temp = resolve('work/tmp');
await mkdir(temp, { recursive: true });
process.env.TEMP = temp;
process.env.TMP = temp;
process.env.TMPDIR = temp;
process.env.WRANGLER_SEND_METRICS = 'false';
await build({
  entryPoints: ['scripts/personal-supervisor.ts'],
  bundle: true,
  packages: 'external',
  platform: 'node',
  format: 'esm',
  outfile: 'work/personal-automation.mjs',
  logLevel: 'silent',
});
try {
  const { main } = await import('../work/personal-automation.mjs');
  const result = await main(process.argv.slice(2));
  if (result !== undefined) console.log(JSON.stringify(result));
  if (Array.isArray(result) && result.some((r) => r.state === 'blocked')) process.exitCode = 2;
} catch (error) {
  const reason =
    error instanceof Error && /^[a-z][a-z0-9_:-]{0,100}$/.test(error.message)
      ? error.message
      : 'personal_automation_failed';
  console.error(JSON.stringify({ state: 'blocked', reason, production: false }));
  process.exitCode = 2;
}
