import { readFile, lstat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { checkedLocalPath, separatePaths } from './personal-vault';
import { createPersonalR2Reader, createNasReceiptWriter } from './personal-nas-transport';
import { dailyNasCycle, restoreDailyNas, type DailyNasOptions } from './daily-nas';
import { dailySource } from '../src/research/daily-protocol';
const path = z.string().refine(isAbsolute),
  ref = z.string().trim().min(1).max(500);
const Config = z
  .object({
    version: z.literal('daily-nas-runtime-v1'),
    enabled: z.literal(true),
    owner_activation_ref: ref,
    native_custody_review_ref: ref,
    recovery_custody_review_ref: ref,
    monitoring_permission_ref: ref,
    account_id: z.string().regex(/^[a-f0-9]{32}$/),
    data_bucket: z.string().regex(/^[a-z0-9][a-z0-9-]{2,62}$/),
    health_bucket: z.string().regex(/^[a-z0-9][a-z0-9-]{2,62}$/),
    root: path,
    age_binary: path,
    recipient: z.string().regex(/^age1[a-z0-9]{58}$/),
    identity_file: path,
    data_read_credentials_file: path,
    health_write_credentials_file: path,
    receipt_secret_file: path,
    sources: z
      .array(z.object({ source_id: dailySource, store_id: z.string().min(1) }).strict())
      .min(1)
      .max(2),
  })
  .strict()
  .refine(
    (c) =>
      c.data_bucket !== c.health_bucket &&
      new Set(c.sources.map((s) => s.source_id)).size === c.sources.length,
  );
const Credentials = z
  .object({
    accessKeyId: z.string().regex(/^[a-f0-9]{32}$/),
    secretAccessKey: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export async function dailyNasMain(args: string[]) {
  const [mode, file, ...flags] = args;
  if (mode === 'daily-plan') {
    console.log(
      JSON.stringify({
        enabled: false,
        network: false,
        history_ttl_days: null,
        scheduled_tasks_installed: false,
        required: [
          'approved daily contract',
          'private migration 0013',
          'data bucket Object Read',
          'separate health bucket Object Read/Write',
          'receipt HMAC Secret',
          'NAS custody approval',
          'hourly timer approval',
        ],
      }),
    );
    return;
  }
  const restore =
    mode === 'daily-restore' &&
    flags.length === 7 &&
    flags[0] === '--source' &&
    flags[2] === '--destination' &&
    flags[4] === '--approval-ref' &&
    flags[6] === '--allow-network';
  if (!file || (!(mode === 'daily-once' && flags.join(' ') === '--allow-network') && !restore))
    throw new Error('nas_explicit_run_required');
  const c = Config.parse(JSON.parse(await readFile(file, 'utf8')));
  for (const file of [
    c.identity_file,
    c.data_read_credentials_file,
    c.health_write_credentials_file,
    c.receipt_secret_file,
  ]) {
    await checkedLocalPath(file);
    separatePaths(file, c.root);
    const stat = await lstat(file);
    if (
      !stat.isFile() ||
      stat.size > 16384 ||
      (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
    )
      throw new Error('nas_credential_custody_required');
  }
  const data = Credentials.parse(JSON.parse(await readFile(c.data_read_credentials_file, 'utf8'))),
    health = Credentials.parse(JSON.parse(await readFile(c.health_write_credentials_file, 'utf8'))),
    secret = (await readFile(c.receipt_secret_file, 'utf8')).trim();
  if (data.accessKeyId === health.accessKeyId || secret.length < 32)
    throw new Error('nas_separate_credentials_required');
  for (const source of c.sources) {
    if (restore && source.source_id !== flags[1]) continue;
    const reader = createPersonalR2Reader(
      {
        account_id: c.account_id,
        bucket: c.data_bucket,
        source_id: source.source_id,
        allow_network: true,
      },
      data,
    );
    const options: DailyNasOptions = {
      root: c.root,
      ageBinary: c.age_binary,
      recipient: c.recipient,
      identityFile: c.identity_file,
      account_id: c.account_id,
      bucket: c.data_bucket,
      store_id: source.store_id,
      data_origin: 'live',
      now: () => new Date().toISOString(),
      receiptSecret: secret,
      sendReceipt: createNasReceiptWriter(
        {
          account_id: c.account_id,
          bucket: c.health_bucket,
          source_id: source.source_id,
          allow_network: true,
        },
        health,
      ),
    };
    try {
      let result;
      if (restore) {
        // One explicit recovery request drives bounded checkpointed stages to completion.
        do {
          result = await restoreDailyNas(
            reader,
            source.source_id,
            options,
            path.parse(flags[3]),
            ref.parse(flags[5]),
          );
        } while (result.state === 'partial');
      } else result = await dailyNasCycle(reader, source.source_id, options);
      console.log(JSON.stringify({ source_id: source.source_id, ...result }));
      if (['failed', 'receipt_failed'].includes(result.state)) process.exitCode = 1;
    } catch {
      console.log(JSON.stringify({ source_id: source.source_id, state: 'failed' }));
      process.exitCode = 1;
    }
  }
  if (restore && !c.sources.some((s) => s.source_id === flags[1]))
    throw new Error('nas_restore_source_required');
}
