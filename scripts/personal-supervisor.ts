import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { z } from 'zod';
import { inspectPersonalContract } from '../src/research/personal-contract';
import {
  collectPersonalGpu,
  stopPersonalCollection,
  revokePersonalUse,
} from '../src/research/personal';
import { errorCode } from '../src/util';
import { renewPersonalReview } from '../src/research/personal-review';
import { restorePersonalSnapshot } from '../src/research/personal-snapshot';
import { personalContinuingEnv } from './personal-continuing-env';
import {
  checkedLocalPath,
  separatePaths,
  initializePersonalVault,
  inspectPersonalVault,
  parseBackupKey,
  personalBackupTick,
  loadPersonalBackup,
  withVaultLock,
} from './personal-vault';

const ref = z.string().trim().min(1).max(500);
export const PersonalAutomationSchema = z
  .object({
    version: z.literal('personal-automation-v1'),
    status: z.enum(['draft', 'approved_for_local_operation']),
    owner_setup_approval_ref: ref.nullable(),
    enabled: z.boolean(),
    interval_seconds: z.number().int().min(60).max(3600),
    sources: z
      .array(
        z
          .object({
            source_id: z.enum(['highreso_public', 'rebro_public']),
            contract_path: ref,
            primary_path: ref,
            vault_path: ref,
            backup_key_env: z.string().regex(/^PERSONAL_BACKUP_KEY_[A-Z0-9_]+$/),
            protected_key_path: ref,
          })
          .strict(),
      )
      .min(1)
      .max(2),
  })
  .strict()
  .refine(
    (v) => new Set(v.sources.map((s) => s.source_id)).size === v.sources.length,
    'personal_automation_duplicate_source',
  );
export type PersonalAutomation = z.infer<typeof PersonalAutomationSchema>;
export async function runIsolatedMaintenance<T>(
  entries: readonly T[],
  tick: (entry: T) => Promise<unknown>,
) {
  const results = [];
  for (const entry of entries)
    try {
      results.push({ state: 'completed', result: await tick(entry) });
    } catch (error) {
      results.push({ state: 'blocked', reason: errorCode(error) });
    }
  return results;
}
function escapeXml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}
export function personalTaskXml(
  configPath: string,
  scriptPath: string,
  at: string,
  intervalSeconds = 300,
) {
  if (
    !Number.isInteger(intervalSeconds) ||
    intervalSeconds < 60 ||
    intervalSeconds > 3600 ||
    !Number.isFinite(Date.parse(at))
  )
    throw new Error('personal_task_schedule_invalid');
  // Registration/enabling is a separate owner-approved operation. No credentials in XML.
  const args = `-NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -WindowStyle Hidden -File "${scriptPath}" -ConfigPath "${configPath}"`;
  if (/["\r\n]/.test(configPath + scriptPath)) throw new Error('personal_task_path_invalid');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><RegistrationInfo><Description>Local personal-history maintenance and encrypted backups; no acquisition</Description></RegistrationInfo><Triggers><TimeTrigger><Repetition><Interval>PT${intervalSeconds}S</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition><StartBoundary>${escapeXml(at)}</StartBoundary><Enabled>true</Enabled></TimeTrigger><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers><Principals><Principal id="Owner"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><StartWhenAvailable>true</StartWhenAvailable><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><ExecutionTimeLimit>PT30M</ExecutionTimeLimit><Enabled>false</Enabled></Settings><Actions Context="Owner"><Exec><Command>powershell.exe</Command><Arguments>${escapeXml(args)}</Arguments></Exec></Actions></Task>`;
}
export async function main(args: string[]) {
  const [mode, flag, path, ...extra] = args;
  if (
    flag !== '--config' ||
    !path ||
    !['plan', 'init', 'once', 'watch', 'collect', 'renew', 'restore', 'stop', 'revoke'].includes(
      mode,
    )
  )
    throw new Error('personal_automation_usage_invalid');
  const configPath = await checkedLocalPath(resolve(path));
  const config = PersonalAutomationSchema.parse(JSON.parse(await readFile(configPath, 'utf8')));
  for (const entry of config.sources) {
    await checkedLocalPath(entry.contract_path);
    await checkedLocalPath(entry.primary_path);
    await checkedLocalPath(entry.vault_path);
    await checkedLocalPath(entry.protected_key_path);
    separatePaths(resolve(entry.primary_path), resolve(entry.vault_path));
  }
  for (let i = 0; i < config.sources.length; i++)
    for (let j = i + 1; j < config.sources.length; j++)
      for (const a of [config.sources[i].primary_path, config.sources[i].vault_path])
        for (const b of [config.sources[j].primary_path, config.sources[j].vault_path])
          separatePaths(resolve(a), resolve(b));
  if (mode === 'plan') {
    if (extra.length) throw new Error('personal_automation_usage_invalid');
    return {
      state: 'plan_only',
      source_count: config.sources.length,
      enabled: config.enabled,
      task_xml: personalTaskXml(
        configPath,
        resolve('scripts/personal-task.ps1'),
        new Date().toISOString(),
        config.interval_seconds,
      ),
      registered: false,
      network: false,
    };
  }
  if (
    config.status !== 'approved_for_local_operation' ||
    !config.owner_setup_approval_ref ||
    !config.enabled
  )
    throw new Error('personal_automation_unapproved');
  if (['once', 'watch'].includes(mode) && extra.length)
    throw new Error('personal_automation_usage_invalid');
  if (
    (mode === 'init' && extra.length !== 2) ||
    (mode === 'collect' && (extra.length !== 3 || extra[2] !== '--allow-network')) ||
    (mode === 'renew' && (extra.length !== 4 || extra[2] !== '--review')) ||
    (['stop', 'revoke'].includes(mode) &&
      (extra.length !== 4 || extra[2] !== '--reason-ref' || !ref.safeParse(extra[3]).success)) ||
    (mode === 'restore' &&
      (extra.length !== 6 || extra[2] !== '--snapshot' || extra[4] !== '--destination'))
  )
    throw new Error('personal_automation_usage_invalid');
  const entries = ['once', 'watch'].includes(mode)
    ? config.sources
    : config.sources.filter((e) => e.source_id === extra[1]);
  if (!['once', 'watch'].includes(mode) && (extra[0] !== '--source' || entries.length !== 1))
    throw new Error('personal_automation_source_required');
  const perform = async (entry: PersonalAutomation['sources'][number]) => {
    const raw = JSON.parse(await readFile(entry.contract_path, 'utf8'));
    const { contract: c } = await inspectPersonalContract(
      raw,
      new Date().toISOString(),
      'development',
      'maintain',
    );
    if (c.version !== 'personal-gpu-v2' || c.config.source.source_id !== entry.source_id)
      throw new Error('personal_automation_contract_mismatch');
    const keyValue = process.env[entry.backup_key_env];
    const key = keyValue ? parseBackupKey(keyValue) : undefined;
    if (mode === 'init') {
      if (extra.length !== 2) throw new Error('personal_automation_usage_invalid');
      if (!key) throw new Error('personal_backup_key_unavailable');
      await initializePersonalVault(entry.vault_path, c, key);
      return { state: 'vault_initialized', data_origin: 'live', network: false };
    }
    await inspectPersonalVault(entry.vault_path, c);
    const local = await personalContinuingEnv(
      c,
      entry.primary_path,
      entry.vault_path,
      'development',
    );
    try {
      if (mode === 'stop')
        return await withVaultLock(entry.vault_path, () =>
          stopPersonalCollection(local.env, c, extra[3]),
        );
      if (mode === 'revoke') {
        await withVaultLock(entry.vault_path, () => revokePersonalUse(local.env, c, extra[3]));
        return await personalBackupTick(local.env, c, entry.vault_path, undefined);
      }
      if (mode === 'collect') {
        if (extra.length !== 3 || extra[2] !== '--allow-network')
          throw new Error('personal_network_opt_in_required');
        if (!key) throw new Error('personal_backup_key_unavailable');
        await inspectPersonalVault(entry.vault_path, c, key);
        const result = await withVaultLock(entry.vault_path, () =>
          collectPersonalGpu(local.env, c, { allow_network: true }),
        );
        await personalBackupTick(local.env, c, entry.vault_path, key);
        return result;
      }
      if (mode === 'renew') {
        if (extra.length !== 4 || extra[2] !== '--review')
          throw new Error('personal_automation_usage_invalid');
        const review = JSON.parse(
          await readFile(await checkedLocalPath(resolve(extra[3])), 'utf8'),
        );
        return await withVaultLock(entry.vault_path, () =>
          renewPersonalReview(local.env, c, review),
        );
      }
      if (mode === 'restore') {
        if (extra.length !== 6 || extra[2] !== '--snapshot' || extra[4] !== '--destination' || !key)
          throw new Error('personal_automation_usage_invalid');
        const destination = await checkedLocalPath(resolve(extra[5]));
        separatePaths(destination, resolve(entry.primary_path));
        separatePaths(destination, resolve(entry.vault_path));
        return await withVaultLock(entry.vault_path, async () => {
          const snapshot = await loadPersonalBackup(entry.vault_path, c, key, extra[3]);
          const target = await personalContinuingEnv(
            c,
            destination,
            entry.vault_path,
            'development',
          );
          try {
            return await restorePersonalSnapshot(target.env, c, snapshot);
          } finally {
            await target.dispose();
          }
        });
      }
      return await personalBackupTick(local.env, c, entry.vault_path, key);
    } finally {
      await local.dispose();
    }
  };
  if (mode !== 'watch') return runIsolatedMaintenance(entries, perform);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    let last = '';
    while (!controller.signal.aborted) {
      const results = await runIsolatedMaintenance(entries, perform),
        summary = JSON.stringify(results, (key, value) => (key === 'at' ? undefined : value));
      if (summary !== last) {
        console.log(summary);
        last = summary;
      }
      try {
        await setTimeout(config.interval_seconds * 1000, undefined, { signal: controller.signal });
      } catch {
        if (!controller.signal.aborted) throw new Error('personal_automation_timer_failed');
      }
    }
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}
