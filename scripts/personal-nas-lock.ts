import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

// Linux containers have different hostnames/PID namespaces. A kernel lock on the
// shared local filesystem survives neither process death nor a container restart.
// Keep the inode: unlinking it would let another process lock a different file.
export async function linuxNasLock(root: string) {
  for (const name of ['cycle.lock', 'reap.lock']) {
    try {
      await lstat(join(root, name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    // Never guess that an older client has stopped, or delete its lease.
    throw new Error('nas_legacy_lease_review_required');
  }
  const handle = await open(
    join(root, 'cycle.flock'),
    constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    if (!(await handle.stat()).isFile()) throw new Error('nas_lock_file_invalid');
    await new Promise<void>((resolve, reject) => {
      // FD 3 shares the parent's open file description. After flock exits the
      // parent retains the lock until close/exit; there is no orphan lease holder.
      const child = spawn('/usr/bin/flock', ['--exclusive', '--nonblock', '-E', '73', '3'], {
        shell: false,
        env: {},
        stdio: ['ignore', 'ignore', 'ignore', handle.fd],
      });
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      child.once('error', () => {
        clearTimeout(timer);
        reject(new Error('nas_kernel_lock_unavailable'));
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(code === 73 ? 'nas_cycle_leased' : 'nas_kernel_lock_unavailable'));
      });
    });
    return async () => {
      await handle.close();
    };
  } catch (error) {
    await handle.close();
    throw error;
  }
}
