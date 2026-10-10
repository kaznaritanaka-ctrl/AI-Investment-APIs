import { build } from 'esbuild';
import { mkdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const output = 'deploy/nas-backup/vendor/backup-s3.mjs';
await mkdir('deploy/nas-backup/vendor', { recursive: true });
await build({
  entryPoints: ['scripts/backup-s3.mjs'],
  outfile: output,
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  legalComments: 'inline',
  minify: false,
});
console.log(
  JSON.stringify({
    artifact: output,
    sha256: createHash('sha256')
      .update(await readFile(output))
      .digest('hex'),
    dependency_source: 'existing_pnpm_lockfile',
    production_access: false,
  }),
);
