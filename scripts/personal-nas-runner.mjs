import { build } from 'esbuild';
import { mkdir, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const temp = resolve('work/tmp');
await mkdir(temp, { recursive: true });
process.env.TEMP = temp;
process.env.TMP = temp;
process.env.TMPDIR = temp;
// Overlapping scheduler runs must not overwrite another process's imported bundle.
// Keep it directly under work so bundled migration paths still resolve correctly.
const output = resolve('work/personal-nas-' + randomUUID() + '.bundle.mjs');
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
} finally {
  await unlink(output);
}
