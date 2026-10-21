import { lstat, readFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

try {
  const args = process.argv.slice(2);
  if (
    args.length !== 6 ||
    args[0] !== '--report' ||
    args[2] !== '--slot' ||
    args[4] !== '--directory'
  )
    throw new Error('arguments_invalid');
  const stat = await lstat(args[1]);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024)
    throw new Error('input_invalid');
  const input = JSON.parse(await readFile(args[1], 'utf8'));
  await mkdir('work/operations-cases-tool', { recursive: true });
  await build({
    entryPoints: ['scripts/operations-case-store.ts'],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: 'work/operations-cases-tool/index.mjs',
    logLevel: 'silent',
  });
  const { enqueueOperationsCases } = await import(
    pathToFileURL(resolve('work/operations-cases-tool/index.mjs'))
  );
  const result = await enqueueOperationsCases(
    input,
    args[3],
    resolve(args[5]),
    new Date().toISOString(),
  );
  console.log(JSON.stringify(result));
  if (result.state === 'refresh_required' || result.state === 'limited') process.exitCode = 2;
} catch {
  console.error('operations_case_input_invalid_or_unavailable');
  process.exitCode = 1;
}
