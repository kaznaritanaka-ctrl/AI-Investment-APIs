import { syncNasExport } from '../src/research/nas-export';
import { exportFixture } from './nas-export-fixture';
import { guardedNasReader } from '../scripts/personal-nas-transport';
import { beforeEach, afterEach, it, describe, expect, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { personalLocalEnv } from '../scripts/personal-local-env';
import { dailyNasCycle, restoreDailyNas, type DailyNasOptions } from '../scripts/daily-nas';
import { dailyFixture, heartbeat, receiptSecret } from './daily-helpers';
import {
  collectDaily,
  exportDailyHistory,
  dailyMonitor,
  type DailyEnv,
} from '../src/research/personal-daily';
import { gpuFetcher, gpuTime } from './public-gpu-helpers';
import { dailyRoot, verifyReceipt } from '../src/research/daily-protocol';
import {
  createNasReceiptWriter,
  personalObjectKey,
  type NasReader,
} from '../scripts/personal-nas-transport';

it('health transport is fixed PUT to a separate bucket, bounded and opt-in; data reads stay GET-only', async () => {
  const fetcher = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 200 }),
    ),
    credentials = { accessKeyId: 'synthetic', secretAccessKey: 'synthetic' };
  const c = {
    account_id: 'a'.repeat(32),
    bucket: 'synthetic-health-only',
    source_id: 'rebro_public',
    allow_network: false,
  };
  await expect(createNasReceiptWriter(c, credentials, fetcher)({})).rejects.toThrow('opt_in');
  expect(fetcher).not.toHaveBeenCalled();
  await createNasReceiptWriter(
    { ...c, allow_network: true },
    credentials,
    fetcher,
  )({
    receipt: {
      version: 1,
      source_id: 'rebro_public',
      issued_at: gpuTime,
      status: 'empty',
      code: 'none',
      pending: 0,
      last_backup_at: null,
      last_restored_at: null,
      last_inventory_at: null,
      latest_observed_at: null,
    },
    signature: '0'.repeat(64),
  });
  await expect(
    createNasReceiptWriter(
      { ...c, allow_network: true },
      credentials,
      fetcher,
    )({ raw_private_data: 'forbidden' }),
  ).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0][0]).toBe(
    'https://' +
      'a'.repeat(32) +
      '.r2.cloudflarestorage.com/synthetic-health-only/daily/receipts/rebro_public.json',
  );
  expect((fetcher.mock.calls[0] as any)[1].method).toBe('PUT');
  expect(personalObjectKey('personal-daily/rebro_public/catalog/1.json')).toBe(true);
  expect(personalObjectKey('personal-daily/rebro_public/../../secret')).toBe(false);
});
describe(
  'multi-run NAS backup, restore and signed Cloud heartbeat (synthetic)',
  { timeout: 120000 },
  () => {
    let local: Awaited<ReturnType<typeof personalLocalEnv>>,
      env: DailyEnv,
      reader: NasReader,
      root: string,
      opt: DailyNasOptions,
      at: string;
    beforeEach(async () => {
      local = await personalLocalEnv('synthetic-store');
      env = {
        ...local.env,
        NAS_HEALTH: (await local.mf.getR2Bucket('NAS_HEALTH')) as unknown as R2Bucket,
        NAS_RECEIPT_SECRET: receiptSecret,
      };
      await mkdir('work/nas-synthetic', { recursive: true });
      root = await mkdtemp(resolve('work/nas-synthetic/daily-'));
      const binary = resolve(
          'work/tools/age-v1.3.2/age/age' + (process.platform === 'win32' ? '.exe' : ''),
        ),
        identity = join(root, 'synthetic.key');
      const generated = spawnSync(
        join(dirname(binary), 'age-keygen' + (process.platform === 'win32' ? '.exe' : '')),
        ['-o', identity],
        { stdio: 'pipe', windowsHide: true },
      );
      if (generated.status !== 0) throw new Error('Verified age tooling required');
      at = gpuTime;
      reader = {
        get: async (key) => {
          const o = await env.EVIDENCE.get(key);
          return o ? new Uint8Array(await o.arrayBuffer()) : null;
        },
      };
      opt = {
        root: join(root, 'sealed'),
        ageBinary: binary,
        identityFile: identity,
        recipient: generated.stderr.toString().match(/age1[a-z0-9]{58}/)![0],
        account_id: 'a'.repeat(32),
        bucket: 'synthetic-personal-only',
        store_id: 'synthetic-store',
        data_origin: 'synthetic',
        now: () => at,
        receiptSecret,
        sendReceipt: async (envelope) => {
          await env.NAS_HEALTH!.put('daily/receipts/rebro_public.json', JSON.stringify(envelope));
        },
      };
    });
    afterEach(async () => {
      await local?.mf.dispose();
    });
    it('backs up two days across non-contiguous catalog pages, restores both and blocks after revocation', async () => {
      const { c, pin } = await dailyFixture();
      for (const day of [gpuTime, '2026-10-19T01:00:00.000Z']) {
        at = day;
        if (day !== gpuTime)
          await env.PRIVATE_DB.prepare(
            "UPDATE sqlite_sequence SET seq=64 WHERE name='personal_daily_runs'",
          ).run();
        await heartbeat(env, 'rebro_public', at);
        await collectDaily(env, c, pin, {
          now: () => at,
          fetcher: gpuFetcher('rebro_public'),
          allow_network: true,
        });
        await exportDailyHistory(env, 'rebro_public', at);
      }
      // Oldest run refresh can be selected first. Drain the remaining bounded export.
      for (let i = 0; i < 2; i++) await exportDailyHistory(env, 'rebro_public', at);
      const output = (await local.mf.getR2Bucket('NAS_EXPORT')) as unknown as R2Bucket;
      const transport = exportFixture('synthetic-health-only');
      const exportBase = {
        EVIDENCE: env.EVIDENCE,
        NAS_EXPORT: output,
        NAS_HEALTH: env.NAS_HEALTH,
        PERSONAL_EXPORT_PINS: JSON.stringify(transport),
      };
      for (let i = 0; i < 4; i++)
        await syncNasExport(exportBase, transport, 'rebro_public', 'daily', at);
      reader = guardedNasReader(
        {
          get: async (key) => {
            const o = await output.get(key);
            return o ? new Uint8Array(await o.arrayBuffer()) : null;
          },
        },
        transport,
        'rebro_public',
        'daily',
        () => at,
      );
      const firstPage = await dailyNasCycle(reader, 'rebro_public', opt);
      expect(firstPage.receipt.last_inventory_at).toBeNull();
      const result = await dailyNasCycle(reader, 'rebro_public', opt);
      expect(result.state).toBe('ok');
      expect(result.receipt.last_restored_at).toBe(at);
      expect(result.receipt.last_inventory_at).toBe(at);
      const signed = JSON.parse(
        await (await env.NAS_HEALTH!.get('daily/receipts/rebro_public.json'))!.text(),
      );
      expect(await verifyReceipt(signed, receiptSecret, at)).toMatchObject({ status: 'ok' });
      expect((await dailyMonitor(env, c, at)).state).toBe('healthy');
      expect(
        (await readdir(join(opt.root, 'rebro_public'))).filter((f) => f.endsWith('.age')),
      ).toHaveLength(2);
      const dest = join(root, 'staging');
      let restore;
      for (let i = 0; i < 5; i++) {
        restore = await restoreDailyNas(
          reader,
          'rebro_public',
          opt,
          dest,
          'SYNTHETIC restore approval',
        );
        if (restore.state === 'complete') break;
      }
      expect(restore).toMatchObject({ state: 'complete', runs: 2 });
      const restored = await personalLocalEnv('synthetic-store', 'test', dest);
      try {
        expect(
          await restored.env.PRIVATE_DB.prepare(
            'SELECT COUNT(*) n FROM personal_daily_observations',
          ).first('n'),
        ).toBe(4);
      } finally {
        await restored.mf.dispose();
      }
      await expect(
        restoreDailyNas(reader, 'rebro_public', opt, dest, 'SYNTHETIC restore approval'),
      ).rejects.toThrow('already_complete');
      at = '2026-10-19T02:00:00.000Z';
      await env.EVIDENCE.put(dailyRoot('rebro_public') + 'revoked.json', '{}');
      for (let i = 0; i < 4; i++)
        await syncNasExport(exportBase, transport, 'rebro_public', 'daily', at);
      expect((await dailyNasCycle(reader, 'rebro_public', opt)).state).toBe('failed');
      at = '2026-10-19T03:00:00.000Z';
      await dailyNasCycle(reader, 'rebro_public', opt);
      expect(
        (await readdir(join(opt.root, 'rebro_public'))).filter((f) => f.endsWith('.age')),
      ).toHaveLength(0);
      expect((await dailyMonitor(env, c, at)).collection_allowed).toBe(false);
    });
    it('never reports a full inventory for missing pages or successful backups for damaged ciphertext, and emits failure health on outage', async () => {
      const { c, pin } = await dailyFixture();
      await heartbeat(env, 'rebro_public', at);
      await collectDaily(env, c, pin, {
        now: () => at,
        fetcher: gpuFetcher('rebro_public'),
        allow_network: true,
      });
      await exportDailyHistory(env, 'rebro_public', at);
      const missing: NasReader = {
        get: (key) => (key.endsWith('/catalog/0.json') ? Promise.resolve(null) : reader.get(key)),
      };
      const partial = await dailyNasCycle(missing, 'rebro_public', opt);
      expect(partial.state).toBe('failed');
      expect(partial.receipt.last_inventory_at).toBeNull();
      at = '2026-10-18T02:00:00.000Z';
      expect((await dailyNasCycle(reader, 'rebro_public', opt)).state).toBe('ok');
      const dir = join(opt.root, 'rebro_public'),
        file = (await readdir(dir)).find((f) => f.endsWith('.age'))!,
        cipher = await readFile(join(dir, file));
      cipher[cipher.length - 1] ^= 1;
      await writeFile(join(dir, file), cipher);
      at = '2026-10-19T03:00:00.000Z';
      expect((await dailyNasCycle(reader, 'rebro_public', opt)).state).toBe('failed');
      at = '2026-10-19T04:00:00.000Z';
      expect(
        (
          await dailyNasCycle(
            {
              get: async () => {
                throw new Error('SYNTHETIC offline');
              },
            },
            'rebro_public',
            opt,
          )
        ).state,
      ).toBe('failed');
      expect((await dailyMonitor(env, c, at)).collection_allowed).toBe(false);
    });
  },
);
