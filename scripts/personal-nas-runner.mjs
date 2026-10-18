import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const temp = resolve('work/tmp');
await mkdir(temp, { recursive: true });
process.env.TEMP = temp;
process.env.TMP = temp;
process.env.TMPDIR = temp;
const output = resolve('work/personal-nas.bundle.mjs');
await build({
  entryPoints: ['scripts/personal-nas-cli.ts'],
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  logLevel: 'silent',
});
try {
  await (await import(pathToFileURL(output).href)).nasMain(process.argv.slice(2));
} catch {
  console.error(
    'personal_nas_failed: check offline configuration and custody; no secret or upstream response logged',
  );
  process.exitCode = 1;
}
