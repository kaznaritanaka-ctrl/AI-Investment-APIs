import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateBackupStatus, signBackupStatus } from './backup-status.mjs';

const sha = (v) => createHash('sha256').update(v).digest('hex');
const fail = (code) => {
  throw new Error(code);
};

export async function sendBackupStatus(
  config,
  status,
  secret,
  {
    approvedConfigHash,
    allowNetwork = false,
    allowSend = false,
    now = Date.now(),
    fetcher = fetch,
  } = {},
) {
  validateBackupStatus(status, now);
  if (
    config?.schema_version !== 'backup-notification-v1' ||
    config.enabled !== true ||
    allowNetwork !== true ||
    allowSend !== true ||
    sha(JSON.stringify(config)) !== approvedConfigHash ||
    !/^[a-zA-Z0-9_./:#-]{1,180}$/.test(config.approval_ref ?? '') ||
    !Number.isFinite(Date.parse(config.window_start)) ||
    !Number.isFinite(Date.parse(config.window_end)) ||
    Date.parse(config.window_start) > now ||
    Date.parse(config.window_end) <= now ||
    Date.parse(config.window_end) - Date.parse(config.window_start) > 3600000
  )
    fail('notification_individual_approval_required');
  let url;
  try {
    url = new URL(config.endpoint);
  } catch {
    fail('notification_endpoint_invalid');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    url.pathname !== '/v1/backup-status' ||
    !/^[a-z0-9.-]+$/.test(url.hostname)
  )
    fail('notification_endpoint_invalid');
  const signed = signBackupStatus(status, secret, now);
  let response;
  try {
    response = await fetcher(url.href, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
      headers: { 'content-type': 'application/json', 'x-backup-signature': signed.signature },
      body: signed.body,
    });
  } catch {
    fail('notification_delivery_failed');
  }
  if (response.status !== 200) fail('notification_delivery_failed');
  const parts = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > 1024) fail('notification_ack_invalid');
    parts.push(Buffer.from(chunk));
  }
  let ack;
  try {
    ack = JSON.parse(Buffer.concat(parts));
  } catch {
    fail('notification_ack_invalid');
  }
  if (ack?.status !== 'accepted' || ack.body_sha256 !== signed.body_sha256)
    fail('notification_ack_invalid');
  return {
    status: 'delivered',
    body_sha256: signed.body_sha256,
    delivered_at: new Date(now).toISOString(),
    backup_data_sent: false,
  };
}

async function readJson(path) {
  const st = await lstat(path);
  if (!st.isFile() || st.isSymbolicLink() || st.size > 4096) fail('notification_input_invalid');
  return JSON.parse(await readFile(path, 'utf8'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [send, network, hashFlag, approvedConfigHash, configFile, reportFile, ...rest] =
      process.argv.slice(2);
    if (
      send !== '--send' ||
      network !== '--allow-network' ||
      hashFlag !== '--config-sha256' ||
      !approvedConfigHash ||
      !configFile ||
      !reportFile ||
      rest.length
    )
      fail('notification_individual_approval_required');
    const secretFile = process.env.BACKUP_STATUS_SIGNING_KEY_FILE;
    if (!isAbsolute(secretFile ?? '')) fail('notification_key_file_required');
    const st = await lstat(secretFile);
    if (
      !st.isFile() ||
      st.isSymbolicLink() ||
      st.nlink !== 1 ||
      st.size > 128 ||
      (process.platform !== 'win32' && st.mode & 0o077)
    )
      fail('notification_key_file_required');
    const result = await sendBackupStatus(
      await readJson(configFile),
      await readJson(reportFile),
      (await readFile(secretFile, 'utf8')).trim(),
      { approvedConfigHash, allowNetwork: true, allowSend: true },
    );
    console.log(JSON.stringify(result));
  } catch {
    console.error(JSON.stringify({ status: 'notification_failed', delivered: false }));
    process.exitCode = 1;
  }
}
