// Explicit tooling setup, never called by test/build. Pinned upstream release and checksums.
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
if (!process.argv.includes('--allow-download'))
  throw new Error('Explicit --allow-download required');
const windows = process.platform === 'win32';
if (!['win32', 'linux'].includes(process.platform) || process.arch !== 'x64')
  throw new Error('Unsupported test-tool platform');
const name = windows ? 'age-v1.3.2-windows-amd64.zip' : 'age-v1.3.2-linux-amd64.tar.gz';
const expected = windows
  ? 'f48d8f8f9ebe903ab5027ed067652f2cc1db94bc206976430133b905dcd8e8c7'
  : 'cbe24006683f8eb669266162894b9a522a1af52f2665fbc63a4bb032ed26ac10';
const response = await fetch(
  'https://github.com/FiloSottile/age/releases/download/v1.3.2/' + name,
  { signal: AbortSignal.timeout(60000) },
);
if (!response.ok) throw new Error('Test tool download failed');
const bytes = Buffer.from(await response.arrayBuffer());
if (bytes.length > 50000000 || createHash('sha256').update(bytes).digest('hex') !== expected)
  throw new Error('Test tool checksum mismatch');
const root = resolve('work/tools/age-v1.3.2');
await mkdir(root, { recursive: true });
const archive = resolve('work/tools/' + name);
await writeFile(archive, bytes);
const result = spawnSync('tar', ['-xf', archive, '-C', root], {
  windowsHide: true,
  stdio: 'inherit',
});
if (result.status !== 0) throw new Error('Test tool extraction failed');
console.log('Verified age 1.3.2 installed under ignored work/tools; no real keys created.');
