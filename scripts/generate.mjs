import { build } from 'esbuild';
import { z } from 'zod';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
await mkdir('work', { recursive: true });
for (const [entry, out] of [
  ['src/schema.ts', 'work/schema.mjs'],
  ['src/openapi.ts', 'work/openapi.mjs'],
])
  await build({
    absWorkingDir: process.cwd(),
    entryPoints: [resolve(entry)],
    tsconfig: './tsconfig.json',
    bundle: true,
    packages: 'external',
    platform: 'node',
    format: 'esm',
    outfile: out,
    logLevel: 'warning',
  });
const { SourceSchema } = await import(pathToFileURL(resolve('work/schema.mjs')).href);
const { openapi } = await import(pathToFileURL(resolve('work/openapi.mjs')).href);
await writeFile(
  'config/source.schema.json',
  JSON.stringify(z.toJSONSchema(SourceSchema), null, 2) + '\n',
);
await writeFile('openapi.json', JSON.stringify(openapi, null, 2) + '\n');
console.log('Generated source schema and OpenAPI.');
