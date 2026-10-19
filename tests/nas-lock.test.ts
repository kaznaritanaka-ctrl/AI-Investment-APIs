import { it, expect } from 'vitest';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { sourceLock } from '../scripts/personal-nas';

async function root() {
  await mkdir('work/nas-lock-synthetic', { recursive: true });
  return mkdtemp(resolve('work/nas-lock-synthetic/run-'));
}
it('excludes simultaneous clients and allows a new cycle after release', async () => {
  const dir = await root();
  const release = await sourceLock(dir);
  try {
    await expect(sourceLock(dir)).rejects.toThrow('nas_cycle_leased');
    const other = await sourceLock(await root());
    await other();
  } finally {
    await release();
  }
  await (
    await sourceLock(dir)
  )();
});

it.skipIf(process.platform !== 'linux')(
  'releases a Linux lease after abrupt process death without hostname or PID recovery',
  async () => {
    const dir = await root();
    const bundle = join(dir, 'lock.mjs');
    await build({
      entryPoints: ['scripts/personal-nas-lock.ts'],
      outfile: bundle,
      bundle: true,
      platform: 'node',
      format: 'esm',
      logLevel: 'silent',
    });
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const {linuxNasLock}=await import(${JSON.stringify(pathToFileURL(bundle).href)}); await linuxNasLock(${JSON.stringify(dir)}); console.log('locked'); setInterval(()=>{},1000);`,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );
    const closed = once(child, 'close');
    try {
      await new Promise<void>((done, fail) => {
        child.stdout.once('data', (b) =>
          b.toString().trim() === 'locked' ? done() : fail(new Error('unexpected child output')),
        );
        child.once('error', fail);
        child.once('exit', () => fail(new Error('child exited before lock')));
      });
      await expect(sourceLock(dir)).rejects.toThrow('nas_cycle_leased');
      child.kill('SIGKILL');
      await closed;
      await (
        await sourceLock(dir)
      )();
      // Persistent lock inode is safe; no daily stale-file removal is required.
      expect(await readFile(join(dir, 'cycle.flock'), 'utf8')).toBe('');
    } finally {
      child.kill('SIGKILL');
      await closed;
    }
  },
);

it.skipIf(process.platform !== 'linux')(
  'preserves legacy PID leases instead of adopting an unknown client',
  async () => {
    const dir = await root();
    const legacy = JSON.stringify({ host: 'prior-container', pid: 1 });
    await writeFile(join(dir, 'cycle.lock'), legacy);
    await expect(sourceLock(dir)).rejects.toThrow('nas_legacy_lease_review_required');
    expect(await readFile(join(dir, 'cycle.lock'), 'utf8')).toBe(legacy);
  },
);
