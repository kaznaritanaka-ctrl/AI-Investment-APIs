import { describe, it, expect, vi, afterEach } from 'vitest';
import { resolve, relative, isAbsolute } from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { personalLocalEnv } from '../scripts/personal-local-env';
import { personalContinuingEnv } from '../scripts/personal-continuing-env';
import {
  initializePersonalVault,
  inspectPersonalVault,
  personalBackupTick,
  loadPersonalBackup,
  decryptPersonalSnapshot,
  withVaultLock,
  parseBackupKey,
  separatePaths,
  verifyRestoreInMemory,
} from '../scripts/personal-vault';
import { runIsolatedMaintenance, personalTaskXml, main } from '../scripts/personal-supervisor';
import { collectPersonalGpu, readPersonalGpu, revokePersonalUse } from '../src/research/personal';
import { continuingFixture } from './personal-continuing-fixture';
import { gpuFetcher } from './public-gpu-helpers';
import { gpuTime } from './personal-fixture';

describe('local encrypted backup automation; synthetic only', () => {
  const roots: string[] = [];
  const key = Buffer.alloc(32, 7);
  const opt = (at = gpuTime) => ({
    allow_network: true,
    fetcher: vi.fn(gpuFetcher('highreso_public')),
    now: () => at,
  });
  async function temp() {
    await mkdir('work', { recursive: true });
    const root = await mkdtemp(resolve('work/personal-vault-test-'));
    roots.push(root);
    return root;
  }
  afterEach(async () => {
    for (const root of roots.splice(0)) {
      const p = relative(resolve('work'), root);
      if (p.startsWith('personal-vault-test-') && !isAbsolute(p) && !p.includes('..'))
        await rm(root, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });
  it('rotates encrypted copies automatically while retaining original history, verifies restoration, and deletes copies on revoke', async () => {
    const c = await continuingFixture(),
      root = resolve(await temp(), 'vault'),
      local = await personalLocalEnv('synthetic-store');
    try {
      await initializePersonalVault(root, c, key);
      await collectPersonalGpu(local.env, c, opt());
      const first = await personalBackupTick(local.env, c, root, key, opt());
      expect(first).toMatchObject({ created: true, verified: true, copies: 1 });
      const file = (await readdir(resolve(root, 'copies')))[0],
        encrypted = await readFile(resolve(root, 'copies', file), 'utf8');
      expect(encrypted).not.toContain('domain_json');
      expect(encrypted).not.toContain('recorded_at');
      expect(await personalBackupTick(local.env, c, root, key, opt())).toMatchObject({
        created: false,
        verified: false,
        copies: 1,
      });
      const snapshot = await loadPersonalBackup(root, c, key, file.replace('.pgb', ''));
      expect(await verifyRestoreInMemory(local.env, c, snapshot, opt())).toEqual({
        verified: true,
        count: 4,
      });
      await expect(decryptPersonalSnapshot(encrypted, c, Buffer.alloc(32, 8))).rejects.toThrow(
        'personal_backup_integrity_failed',
      );
      const corrupt = JSON.parse(encrypted);
      corrupt.tag = '0'.repeat(32);
      await expect(decryptPersonalSnapshot(JSON.stringify(corrupt), c, key)).rejects.toThrow(
        'personal_backup_integrity_failed',
      );
      await writeFile(resolve(root, 'copies', file + '.pending'), 'incomplete encrypted write');
      const day8 = '2026-10-26T01:00:00.000Z';
      await expect(personalBackupTick(local.env, c, root, undefined, opt(day8))).rejects.toThrow(
        'personal_backup_key_unavailable',
      );
      expect(await readdir(resolve(root, 'copies'))).toEqual([]);
      expect(await personalBackupTick(local.env, c, root, key, opt(day8))).toMatchObject({
        created: true,
        verified: true,
        copies: 1,
        state: 'review_due',
      });
      expect(
        await local.env.PRIVATE_DB.prepare(
          'SELECT COUNT(*) n FROM research_gpu_observations',
        ).first(),
      ).toEqual({ n: 4 });
      await revokePersonalUse(local.env, c, 'SYNTHETIC revoke', opt(day8));
      expect(
        await local.env.PRIVATE_DB.prepare(
          'SELECT backup_residual_until FROM research_runs',
        ).first(),
      ).toEqual({ backup_residual_until: '2026-11-02T01:00:00.000Z' });
      const lost = await personalLocalEnv('synthetic-store');
      try {
        expect(
          await personalBackupTick(
            { ...lost.env, EVIDENCE: local.env.EVIDENCE },
            c,
            root,
            undefined,
            opt(day8),
          ),
        ).toMatchObject({ state: 'purged', copies: 0 });
      } finally {
        await lost.mf.dispose();
      }
      expect(await readdir(resolve(root, 'copies'))).toEqual([]);
    } finally {
      await local.mf.dispose();
    }
  }, 120000);
  it('requires approved keys and source-specific vaults and holds a cross-process maintenance lock', async () => {
    const c = await continuingFixture(),
      root = resolve(await temp(), 'vault');
    await initializePersonalVault(root, c, key);
    await expect(initializePersonalVault(root, c, key)).rejects.toThrow('personal_vault_exists');
    await expect(
      inspectPersonalVault(root, await continuingFixture('rebro_public'), key),
    ).rejects.toThrow('personal_vault_scope_invalid');
    await expect(inspectPersonalVault(root, c, Buffer.alloc(32, 9))).rejects.toThrow(
      'personal_backup_key_mismatch',
    );
    expect(() => parseBackupKey(undefined)).toThrow('personal_backup_key_unavailable');
    expect(() => separatePaths(root, resolve(root, 'copies'))).toThrow(
      'personal_backup_path_overlap',
    );
    await withVaultLock(root, async () => {
      await expect(withVaultLock(root, async () => true)).rejects.toThrow('personal_vault_busy');
    });
    expect(await withVaultLock(root, async () => true)).toBe(true);
  }, 120000);
  it('persists current control separately from the data DB and resumes after ordinary process restart', async () => {
    const c = await continuingFixture(),
      base = await temp(),
      primary = resolve(base, 'primary'),
      vault = resolve(base, 'vault');
    await initializePersonalVault(vault, c, key);
    let local = await personalContinuingEnv(c, primary, vault, 'test');
    try {
      await collectPersonalGpu(local.env, c, opt());
      expect(await personalBackupTick(local.env, c, vault, key, opt())).toMatchObject({
        copies: 1,
      });
    } finally {
      await local.dispose();
    }
    local = await personalContinuingEnv(c, primary, vault, 'test');
    try {
      expect((await readPersonalGpu(local.env, c, opt())).results).toHaveLength(4);
      expect(await personalBackupTick(local.env, c, vault, key, opt())).toMatchObject({
        copies: 1,
        created: false,
      });
    } finally {
      await local.dispose();
    }
  }, 120000);
  it('isolates per-source failure and emits a disabled maintenance task without acquisition or credentials', async () => {
    expect(
      await runIsolatedMaintenance(['first', 'second'], async (e) => {
        if (e === 'first') throw new Error('personal_backup_key_unavailable');
        return { state: 'retained' };
      }),
    ).toEqual([
      { state: 'blocked', reason: 'personal_backup_key_unavailable' },
      { state: 'completed', result: { state: 'retained' } },
    ]);
    const xml = personalTaskXml(
      'C:\\private\\task.json',
      'C:\\repo\\scripts\\personal-task.ps1',
      gpuTime,
    );
    expect(xml).toContain('<Enabled>false</Enabled>');
    expect(xml).toContain('-WindowStyle Hidden');
    expect(xml).not.toContain('--allow-network');
    expect(xml).not.toContain('collect');
    const root = await temp(),
      path = resolve(root, 'draft.json');
    await writeFile(
      path,
      JSON.stringify({
        version: 'personal-automation-v1',
        status: 'draft',
        owner_setup_approval_ref: null,
        enabled: false,
        interval_seconds: 300,
        sources: [
          {
            source_id: 'highreso_public',
            contract_path: resolve(root, 'contract.json'),
            primary_path: resolve(root, 'data'),
            vault_path: resolve(root, 'vault'),
            backup_key_env: 'PERSONAL_BACKUP_KEY_HIGHRESO',
            protected_key_path: resolve(root, 'key.dpapi'),
          },
        ],
      }),
    );
    await expect(main(['once', '--config', path])).rejects.toThrow(
      'personal_automation_unapproved',
    );
    expect((await readdir(root)).sort()).toEqual(['draft.json']);
  }, 120000);
  it.skipIf(process.platform !== 'win32')(
    'loads a synthetic DPAPI key without daily prompts or printing plaintext',
    async () => {
      const root = await temp(),
        script = resolve(root, 'key-test.ps1');
      const quote = (v: string) => "'" + v.replaceAll("'", "''") + "'";
      await writeFile(
        script,
        `$ErrorActionPreference = 'Stop'
. ${quote(resolve('scripts/personal-key.ps1'))}
$synthetic = '07' * 32
$bytes = [Text.Encoding]::UTF8.GetBytes($synthetic)
$cipher = [Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
[System.IO.File]::WriteAllText(${quote(resolve(root, 'key.dpapi'))},'personal-key-dpapi-v1:'+ [Convert]::ToBase64String($cipher))
Import-PersonalBackupKey -Path ${quote(resolve(root, 'key.dpapi'))} -Variable PERSONAL_BACKUP_KEY_SYNTHETIC
if ($env:PERSONAL_BACKUP_KEY_SYNTHETIC -ne $synthetic) { throw 'synthetic_key_mismatch' }
[Environment]::SetEnvironmentVariable('PERSONAL_BACKUP_KEY_SYNTHETIC',$null,'Process')
Write-Output 'synthetic_dpapi_passed'
`,
      );
      const output = execFileSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'RemoteSigned', '-File', script],
        { encoding: 'utf8', windowsHide: true, timeout: 30000 },
      );
      expect(output).toContain('synthetic_dpapi_passed');
      expect(output).not.toContain('07'.repeat(32));
    },
    120000,
  );
});
