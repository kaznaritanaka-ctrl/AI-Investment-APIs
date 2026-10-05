import { readFileSync, statSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== '--report' || args[2] !== '--slot')
    throw new Error('invalid_arguments');
  if (statSync(args[1]).size > 2 * 1024 * 1024) throw new Error('input_too_large');
  const input = JSON.parse(readFileSync(args[1], 'utf8'));
  mkdirSync('work/operations-handoff', { recursive: true });
  await build({
    entryPoints: ['src/operations-handoff.ts'],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: 'work/operations-handoff/index.mjs',
    logLevel: 'silent',
  });
  const { operationsHandoff } = await import(
    pathToFileURL(resolve('work/operations-handoff/index.mjs')).href
  );
  console.log(
    JSON.stringify(await operationsHandoff(input, args[3], new Date().toISOString()), null, 2),
  );
}
main().catch(() => {
  // Do not echo input paths, untrusted JSON, credentials or validation messages.
  console.error('operations_handoff_input_invalid_or_unavailable');
  process.exitCode = 1;
});
