import { readFile, lstat } from 'node:fs/promises';
import { z } from 'zod';
import { isAbsolute } from 'node:path';
import { NasSourceSchema, personalNasSources, restoreNasGeneration } from './personal-nas';
import { createPersonalR2Reader } from './personal-nas-transport';
import { checkedLocalPath, separatePaths } from './personal-vault';
import { NasExportBinding } from '../src/research/nas-export-protocol';
import { dailyNasMain } from './daily-nas-cli';
const path = z.string().refine(isAbsolute);
const ref = z.string().trim().min(1).max(500);
const Deployment = z
  .object({
    version: z.literal('personal-nas-runtime-v2'),
    enabled: z.literal(true),
    owner_activation_ref: ref,
    native_custody_review_ref: ref,
    recovery_custody_review_ref: ref,
    transport: NasExportBinding,
    account_id: z.string().regex(/^[a-f0-9]{32}$/),
    bucket: z.string().regex(/^[a-z0-9][a-z0-9-]{2,62}$/),
    root: path,
    age_binary: path,
    recipient: z.string().regex(/^age1[a-z0-9]{58}$/),
    restore_identity_file: path,
    s3_credentials_file: path,
    sources: z.array(NasSourceSchema).min(1).max(2),
  })
  .strict()
  .refine((v) => new Set(v.sources.map((s) => s.source_id)).size === v.sources.length);
export async function nasMain(args: string[]) {
  if (args[0]?.startsWith('daily-')) return dailyNasMain(args);
  const [mode, configFile, ...flags] = args;
  if (mode === 'plan') {
    console.log(
      JSON.stringify({
        enabled: false,
        network: false,
        nas_changed: false,
        required: [
          'owner_activation_ref',
          'native_custody_review_ref',
          'recovery_custody_review_ref',
          'account_id',
          'bucket',
          'source contract hashes',
          'dedicated root',
          'age public recipient',
          'separate restore identity',
          'dedicated export bucket Object Read credentials',
          'personal-nas-export-v1 transport pin and live IAM isolation review',
        ],
        poll_hours: 1,
        restore_check_hours: 24,
        history_ttl_days: null,
        backup_generation_days: 90,
      }),
    );
    return;
  }
  const restore =
    mode === 'restore' &&
    flags.length === 7 &&
    flags[0] === '--source' &&
    flags[2] === '--destination' &&
    flags[4] === '--approval-ref' &&
    flags[6] === '--allow-network';
  if (!configFile || (!(mode === 'once' && flags.join(' ') === '--allow-network') && !restore))
    throw new Error('nas_explicit_run_required');
  const input = JSON.parse(await readFile(configFile, 'utf8'));
  const c = Deployment.parse(input);
  if (c.transport.export_bucket !== c.bucket || c.transport.account_id !== c.account_id)
    throw new Error('nas_export_transport_scope');
  // Only configuration with separate native custody approval can activate a NAS run.
  // This is not a substitute for OS ACL/UID admission; the shipped template is disabled.
  const credentialsPath = await checkedLocalPath(c.s3_credentials_file),
    identity = await checkedLocalPath(c.restore_identity_file);
  for (const file of [credentialsPath, identity]) {
    const stat = await lstat(file);
    if (
      !stat.isFile() ||
      stat.size > 16384 ||
      (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
    )
      throw new Error('nas_credential_custody_required');
    try {
      separatePaths(file, c.root);
    } catch {
      throw new Error('nas_separate_credential_custody_required');
    }
  }
  const secret = z
    .object({
      accessKeyId: z.string().regex(/^[a-f0-9]{32}$/),
      secretAccessKey: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict()
    .parse(JSON.parse(await readFile(credentialsPath, 'utf8')));
  const options = {
    root: c.root,
    ageBinary: c.age_binary,
    recipient: c.recipient,
    identityFile: identity,
    now: () => new Date().toISOString(),
  };
  if (restore) {
    ref.parse(flags[5]);
    const source = c.sources.find((s) => s.source_id === flags[1]);
    if (!source) throw new Error('nas_restore_source_required');
    const result = await restoreNasGeneration(
      createPersonalR2Reader(
        { ...c, source_id: source.source_id, kind: 'initial', allow_network: true },
        secret,
      ),
      source,
      options,
      path.parse(flags[3]),
      flags[5],
    );
    console.log(JSON.stringify({ event: 'personal_nas_restore', ...result }));
    return;
  }
  const results = await personalNasSources(
    c.sources,
    (source) =>
      createPersonalR2Reader(
        { ...c, source_id: source.source_id, kind: 'initial', allow_network: true },
        secret,
      ),
    options,
  );
  console.log(
    JSON.stringify({
      event: 'personal_nas_cycle',
      finished_at: new Date().toISOString(),
      sources: results,
    }),
  );
  if (results.some((r) => r.state === 'failed')) process.exitCode = 1;
}
