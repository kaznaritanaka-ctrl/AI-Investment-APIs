import { it, expect, vi, describe, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { personalLocalEnv } from '../scripts/personal-local-env';
import { cloudFixture } from './personal-cloud-fixture';
import { collectPersonalGpu } from '../src/research/personal';
import {
  cloudPersonalEnv,
  exportCloudPersonal,
  cloudControlKey,
} from '../src/research/personal-cloud';
import { gpuFetcher, gpuTime } from './public-gpu-helpers';
import {
  personalNasCycle,
  personalNasSources,
  nasFreshness,
  restoreNasGeneration,
} from '../scripts/personal-nas';
import {
  createPersonalR2Reader,
  personalObjectKey,
  NasReadError,
  type NasReader,
} from '../scripts/personal-nas-transport';

it('reports unknown, warning and stale separately without manufacturing zero or authorizing new collection', () => {
  expect(nasFreshness(null, gpuTime)).toEqual({ state: 'unknown', age_hours: null });
  expect(nasFreshness('2026-10-17T00:00:00.000Z', '2026-10-18T02:00:00.000Z').state).toBe(
    'warning',
  );
  expect(nasFreshness('2026-10-16T00:00:00.000Z', '2026-10-18T00:00:00.000Z').state).toBe('stale');
});

it('rejects stale, malformed and partial control/manifest before crypto or data admission; first failure backoff persists', async () => {
  await mkdir('work/nas-synthetic', { recursive: true });
  const base = await mkdtemp(resolve('work/nas-synthetic/protocol-'));
  const { contract, binding } = await cloudFixture();
  const config = {
    source_id: 'highreso_public',
    contract_hash: binding.contract_hash,
    retention_days: 7,
    max_copies: 8,
  };
  const control = {
    version: 'personal-cloud-control-v1',
    source_id: 'highreso_public',
    contract_hash: binding.contract_hash,
    checked_at: gpuTime,
    sequence: 0,
    review_hash: binding.contract_hash,
    storage_state: 'continuing',
    storage_ends_at: null,
    review_after: contract.decision.terms.review_after,
    analysis_until: contract.decision.analysis_until,
    denied: false,
    latest_manifest: null,
    records: {},
  };
  const options = {
    root: base,
    ageBinary: 'must-not-run',
    recipient: 'must-not-run',
    identityFile: 'must-not-read',
    now: () => gpuTime,
  };
  const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
  expect(
    await personalNasCycle(
      { get: async () => bytes({ ...control, checked_at: '2026-10-01T00:00:00.000Z' }) },
      config,
      { ...options, root: join(base, 'stale') },
    ),
  ).toMatchObject({ state: 'failed', code: 'nas_current_control_stale_or_scope' });
  expect(
    await personalNasCycle({ get: async () => bytes({ wrong: 'schema' }) }, config, {
      ...options,
      root: join(base, 'malformed'),
    }),
  ).toMatchObject({ state: 'failed' });
  const key =
    'personal-research/backups/highreso_public/' +
    binding.contract_hash +
    '/2026-10-18/manifest.json';
  const headKey = 'research-control/personal-heads/highreso_public/synthetic-initial.json';
  const head = {
    contract_hash: binding.contract_hash,
    sequence: 0,
    review_hash: binding.contract_hash,
    approved_at: contract.decision.approved_at,
    review_after: contract.decision.terms.review_after,
    analysis_until: contract.decision.analysis_until,
    storage_state: 'continuing',
    storage_ends_at: null,
  };
  const nativeRoot = 'personal-research/control/highreso_public/';
  const records = {
    [headKey]: JSON.stringify(head),
    [headKey.replace('personal-heads/', 'personal-attempts/')]: JSON.stringify({
      contract_hash: binding.contract_hash,
      run_id: 'c'.repeat(64),
      source_id: 'highreso_public',
      started_at: gpuTime,
    }),
  };
  const partialRead = vi.fn(async (path: string) =>
    path === key
      ? bytes({ complete: false })
      : path === cloudControlKey('highreso_public')
        ? bytes({ ...control, latest_manifest: key, records })
        : path === nativeRoot + headKey
          ? bytes(head)
          : null,
  );
  expect(
    await personalNasCycle(
      {
        get: partialRead,
      },
      config,
      { ...options, root: join(base, 'partial') },
    ),
  ).toMatchObject({ state: 'failed' });
  expect(partialRead).toHaveBeenCalledWith(key);
  const limited = vi.fn(async () => {
      throw new NasReadError('nas_rate_limited', 3600);
    }),
    opt = { ...options, root: join(base, 'first-failure') };
  expect(await personalNasCycle({ get: limited }, config, opt)).toMatchObject({ state: 'failed' });
  expect(await personalNasCycle({ get: limited }, config, opt)).toMatchObject({ state: 'backoff' });
  expect(limited).toHaveBeenCalledTimes(1);
});

it('only signs fixed source R2 GETs, bounds responses and honors Retry-After without retrying a denied request', async () => {
  const config = {
    account_id: 'a'.repeat(32),
    bucket: 'synthetic-only',
    source_id: 'highreso_public',
    allow_network: false,
  };
  const credentials = {
    accessKeyId: 'SYNTHETIC_NOT_A_CREDENTIAL',
    secretAccessKey: 'SYNTHETIC_NOT_A_SECRET',
  };
  const fetcher = vi.fn(
    async () => new Response(null, { status: 429, headers: { 'retry-after': '7200' } }),
  );
  const key = cloudControlKey('highreso_public');
  await expect(createPersonalR2Reader(config, credentials, fetcher).get(key)).rejects.toThrow(
    'opt_in',
  );
  expect(fetcher).not.toHaveBeenCalled();
  const reader = createPersonalR2Reader({ ...config, allow_network: true }, credentials, fetcher);
  for (const path of [
    'https://evil.test/',
    'evidence/ecb/a',
    'personal-research/control/rebro_public/current.json',
    'personal-research/backups/highreso_public/../../secrets',
  ])
    await expect(reader.get(path)).rejects.toThrow('forbidden');
  await expect(reader.get(key)).rejects.toMatchObject({
    code: 'nas_rate_limited',
    retryAfterSeconds: 7200,
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(personalObjectKey(key)).toBe(true);
  await expect(
    createPersonalR2Reader(
      { ...config, allow_network: true },
      credentials,
      async () => new Response('x'.repeat(131073)),
    ).get(key),
  ).rejects.toThrow('too_large');
  await expect(
    createPersonalR2Reader({ ...config, allow_network: true }, credentials, async () => {
      throw new Error(credentials.secretAccessKey);
    }).get(key),
  ).rejects.not.toThrow(credentials.secretAccessKey);
});

describe(
  'R2 -> real age -> NAS directory -> fresh local D1 (synthetic only)',
  { timeout: 120000 },
  () => {
    let local: Awaited<ReturnType<typeof personalLocalEnv>>,
      root: string,
      age: string,
      identity: string,
      recipient: string;
    beforeEach(async () => {
      local = await personalLocalEnv('synthetic-store');
      await mkdir('work/nas-synthetic', { recursive: true });
      root = await mkdtemp(resolve('work/nas-synthetic/run-'));
      age = resolve(
        process.env.AGE_BINARY ??
          'work/tools/age-v1.3.2/age/age' + (process.platform === 'win32' ? '.exe' : ''),
      );
      identity = join(root, 'synthetic-only.key');
      const keygen = spawnSync(
        join(dirname(age), 'age-keygen' + (process.platform === 'win32' ? '.exe' : '')),
        ['-o', identity],
        { windowsHide: true, stdio: 'pipe' },
      );
      if (keygen.status !== 0)
        throw new Error(
          'Verified age test tooling required: node scripts/setup-test-age.mjs --allow-download (no real keys)',
        );
      recipient = keygen.stderr.toString().match(/age1[a-z0-9]{58}/)![0];
    });
    afterEach(async () => {
      await local?.mf.dispose();
    });
    const setup = async (source: 'highreso_public' | 'rebro_public' = 'highreso_public') => {
      const { contract, binding } = await cloudFixture(source),
        env = cloudPersonalEnv(local.env, contract, binding);
      await collectPersonalGpu(env, contract, {
        now: () => gpuTime,
        allow_network: true,
        fetcher: gpuFetcher(source),
      });
      await exportCloudPersonal(env, local.env.EVIDENCE, contract, { now: () => gpuTime });
      const reader: NasReader = {
        get: async (key) => {
          const o = await local.env.EVIDENCE.get(key);
          return o ? new Uint8Array(await o.arrayBuffer()) : null;
        },
      };
      const config = {
        source_id: source,
        contract_hash: binding.contract_hash,
        retention_days: 7,
        max_copies: 8,
      };
      const options = {
        root: join(root, 'vault'),
        ageBinary: age,
        recipient,
        identityFile: identity,
        now: () => gpuTime,
      };
      return { reader, config, options };
    };
    it('encrypts, decrypts, restores, retries idempotently and detects ciphertext damage', async () => {
      const { reader, config, options } = await setup();
      expect(await personalNasCycle(reader, config, options)).toMatchObject({
        state: 'verified',
        observation_count: 4,
      });
      expect(await personalNasCycle(reader, config, options)).toMatchObject({ state: 'current' });
      const destination = join(root, 'restored-staging');
      expect(
        await restoreNasGeneration(
          reader,
          config,
          options,
          destination,
          'synthetic restore review',
        ),
      ).toMatchObject({ state: 'restored_staging', observation_count: 4 });
      expect(
        JSON.parse(await readFile(join(destination, 'restore-complete.json'), 'utf8')),
      ).toMatchObject({ source_id: config.source_id, observation_count: 4, remote_writes: false });
      // Persistent staging really survives process disposal and remains append-only.
      const restored = await personalLocalEnv('synthetic-store', 'test', destination);
      try {
        expect(
          await restored.env.PRIVATE_DB.prepare(
            'SELECT COUNT(*) AS n FROM research_gpu_observations',
          ).first('n'),
        ).toBe(4);
      } finally {
        await restored.mf.dispose();
      }
      await expect(
        restoreNasGeneration(reader, config, options, destination, 'synthetic restore review'),
      ).rejects.toThrow('EEXIST');
      await expect(
        restoreNasGeneration(
          { get: async () => null },
          config,
          options,
          join(root, 'untrusted-restore'),
          'synthetic restore review',
        ),
      ).rejects.toThrow('nas_current_control_missing');
      const sealed = join(options.root, config.source_id, 'sealed'),
        files = await readdir(sealed);
      expect(files.filter((f) => f.endsWith('.age'))).toHaveLength(1);
      const path = join(
          sealed,
          files.find((f) => f.endsWith('.age'))!,
        ),
        cipher = await readFile(path);
      expect(cipher.toString()).not.toContain('domain_json');
      expect(cipher.toString()).not.toContain('contract_json');
      cipher[cipher.length - 1] ^= 1;
      await writeFile(path, cipher);
      expect(await personalNasCycle(reader, config, options)).toMatchObject({
        state: 'failed',
        code: 'nas_cipher_integrity',
      });
      const state = JSON.parse(
        await readFile(join(options.root, config.source_id, 'state.json'), 'utf8'),
      );
      expect(state.last_verified_at).toBe(gpuTime);
      expect(state.failures).toBe(1);
      // A revocation arriving after the initial check must remain remembered even
      // though the cycle fails before its encrypted copy can be admitted.
      const race = await setup('rebro_public');
      const denyKey =
        'personal-research/control/rebro_public/research-control/revocations/rebro_public.json';
      let controls = 0;
      const racingReader = {
        get: async (key: string) => {
          if (key === cloudControlKey('rebro_public') && ++controls === 2)
            await local.env.EVIDENCE.put(
              denyKey,
              JSON.stringify({ source_id: 'rebro_public', revoked_at: gpuTime }),
            );
          return race.reader.get(key);
        },
      };
      expect(await personalNasCycle(racingReader, race.config, race.options)).toMatchObject({
        state: 'failed',
        code: 'nas_storage_blocked',
      });
      expect(
        JSON.parse(await readFile(join(race.options.root, 'rebro_public', 'state.json'), 'utf8'))
          .denied,
      ).toBe(true);
      await local.env.EVIDENCE.delete(denyKey);
      expect(
        await personalNasCycle(race.reader, race.config, {
          ...race.options,
          now: () => new Date(Date.parse(gpuTime) + 360000).toISOString(),
        }),
      ).toMatchObject({ state: 'failed', code: 'nas_control_rollback' });
    });
    it('fails closed on stale/missing control, persists rate backoff, isolates sources, deletes revoked copies', async () => {
      const { reader, config, options } = await setup('rebro_public');
      expect(await personalNasCycle(reader, config, options)).toMatchObject({
        state: 'verified',
        observation_count: 2,
      });
      const limited = vi.fn(async () => {
        throw new NasReadError('nas_rate_limited', 7200);
      });
      expect(await personalNasCycle({ get: limited }, config, options)).toMatchObject({
        state: 'failed',
        code: 'nas_rate_limited',
      });
      expect(await personalNasCycle({ get: limited }, config, options)).toMatchObject({
        state: 'backoff',
      });
      expect(limited).toHaveBeenCalledTimes(1);
      const later = '2026-10-19T01:00:00.000Z',
        key = cloudControlKey(config.source_id),
        control = await (await local.env.EVIDENCE.get(key))!.json<any>();
      const revocation =
        'personal-research/control/rebro_public/research-control/revocations/rebro_public.json';
      // Summary intentionally remains unrevoked: the native marker must win immediately.
      await local.env.EVIDENCE.put(
        revocation,
        JSON.stringify({ source_id: 'rebro_public', revoked_at: later }),
      );
      expect(
        await personalNasCycle(reader, config, { ...options, now: () => later }),
      ).toMatchObject({ state: 'failed', code: 'nas_storage_blocked' });
      expect(
        (await readdir(join(options.root, config.source_id, 'sealed'))).filter((f) =>
          f.endsWith('.age'),
        ),
      ).toHaveLength(0);
      await local.env.EVIDENCE.delete(revocation);
      await local.env.EVIDENCE.put(
        key,
        JSON.stringify({ ...control, checked_at: '2026-10-20T01:00:00.000Z' }),
      );
      expect(
        await personalNasCycle(reader, config, {
          ...options,
          now: () => '2026-10-20T01:00:00.000Z',
        }),
      ).toMatchObject({ state: 'failed', code: 'nas_control_rollback' });
      const results = await personalNasSources(
        [config, { ...config, source_id: 'highreso_public' }],
        () => ({ get: async () => null }),
        { ...options, now: () => '2026-10-21T01:00:00.000Z' },
      );
      expect(results).toHaveLength(2);
      expect(results.every((r) => r.state === 'failed')).toBe(true);
      expect(results[1]).toMatchObject({ code: 'nas_current_control_missing' });
    });
  },
);
