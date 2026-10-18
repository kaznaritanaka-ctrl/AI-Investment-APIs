import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { lstat, readFile } from 'node:fs/promises';

// Native age only; no shell, plugin identities or inherited Cloudflare credentials.
export async function ageBuffer(binary: string, args: string[], input: Uint8Array) {
  if (!isAbsolute(binary) || input.length > 600000) throw new Error('nas_age_input_invalid');
  const env = Object.fromEntries(
    ['SystemRoot', 'WINDIR', 'TEMP', 'TMP']
      .filter((k) => process.env[k])
      .map((k) => [k, process.env[k]]),
  );
  const child = spawn(binary, args, {
    windowsHide: true,
    shell: false,
    env,
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const parts: Buffer[] = [];
  let size = 0;
  const timer = setTimeout(() => child.kill(), 30000);
  return new Promise<Buffer>((resolve, reject) => {
    let settled = false;
    const fail = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      reject(new Error('nas_age_failed'));
    };
    child.once('error', fail);
    child.stdin.on('error', fail);
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 600000) fail();
      else parts.push(chunk);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return fail();
      if (!settled) {
        settled = true;
        resolve(Buffer.concat(parts));
      }
    });
    child.stdin.end(input);
  });
}
export function sealNas(binary: string, recipient: string, input: Uint8Array) {
  if (!/^age1[a-z0-9]{58}$/.test(recipient)) throw new Error('nas_native_recipient_required');
  return ageBuffer(binary, ['--encrypt', '--recipient', recipient], input);
}
export async function openNas(binary: string, identity: string, input: Uint8Array) {
  if (!isAbsolute(identity)) throw new Error('nas_absolute_identity_required');
  const stat = await lstat(identity);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384)
    throw new Error('nas_native_identity_required');
  const lines = (await readFile(identity, 'utf8'))
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('#'));
  if (lines.length !== 1 || !/^AGE-SECRET-KEY-1[0-9A-Z]{58}$/.test(lines[0]))
    throw new Error('nas_native_identity_required');
  return ageBuffer(binary, ['--decrypt', '--identity', identity], input);
}
