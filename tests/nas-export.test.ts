import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { personalLocalEnv } from '../scripts/personal-local-env';
import { cloudFixture } from './personal-cloud-fixture';
import { exportFixture } from './nas-export-fixture';
import { gpuFetcher, gpuTime } from './public-gpu-helpers';
import { collectPersonalGpu } from '../src/research/personal';
import {
  cloudPersonalEnv,
  cloudControlKey,
  exportCloudPersonal,
  syncCloudControl,
} from '../src/research/personal-cloud';
import { nasExportBinding, syncNasExport } from '../src/research/nas-export';
import { NasExportBinding, exportGateKey } from '../src/research/nas-export-protocol';
import { guardedNasReader, createPersonalR2Reader } from '../scripts/personal-nas-transport';
import { hash, stable } from '../src/util';
import { readFileSync } from 'node:fs';
import { PersonalCloudSchema } from '../src/research/personal-contract';
import { ResearchConfigSchema } from '../src/research/schema';

it('records the owner exception/continuing retention without granting execution or changing either source grant', async () => {
  const folder = 'docs/personal-execution-20261018/';
  const approval = JSON.parse(readFileSync(folder + 'private-start-approval.review.json', 'utf8'));
  expect(approval.owner_exception_approval_ref).toContain('Owner message');
  expect(approval.owner_long_term_retention_approval_ref).toContain('Owner message');
  expect(approval.execution_approved).toBe(false);
  expect(approval.provider_permission).toBe('unconfirmed');
  for (const source of ['highreso_public', 'rebro_public']) {
    const c = JSON.parse(readFileSync(folder + source + '.cloud-method-v2-draft.json', 'utf8'));
    expect(c.config.method_version).toBe('domestic-gpu-html-v2');
    expect(await hash(stable(ResearchConfigSchema.parse(c.config)))).toBe(c.config_sha256);
    expect(c.decision.retention.normalized_days).toBeNull();
    expect(c.decision.retention.continuing_storage.owner_approval_ref).toBe(
      approval.owner_long_term_retention_approval_ref,
    );
    expect(c.decision.owner_execution_approval_ref).toBeNull();
    expect(c.config.source.enabled).toBe(false);
    expect(c.config.source.policy.rights.private_storage).toBe('review_required');
    expect(PersonalCloudSchema.safeParse(c).success).toBe(false);
  }
});

it('requires a separately pinned destination, rejects shared/health buckets and leaves production off', () => {
  const pin = exportFixture();
  expect(NasExportBinding.safeParse({ ...pin, export_bucket: pin.origin_bucket }).success).toBe(
    false,
  );
  expect(NasExportBinding.safeParse({ ...pin, health_bucket: pin.export_bucket }).success).toBe(
    false,
  );
  const origin = {
    account_id: pin.account_id,
    private_database_id: pin.private_database_id,
    bucket: pin.origin_bucket,
  };
  const evidence = {} as R2Bucket;
  expect(() =>
    nasExportBinding({ EVIDENCE: evidence, PERSONAL_EXPORT_PINS: stable(pin) }, origin),
  ).toThrow();
  expect(() =>
    nasExportBinding(
      { EVIDENCE: evidence, NAS_EXPORT: evidence, PERSONAL_EXPORT_PINS: stable(pin) },
      origin,
    ),
  ).toThrow('binding');
  expect(() =>
    nasExportBinding(
      { EVIDENCE: evidence, NAS_EXPORT: {} as R2Bucket, PERSONAL_EXPORT_PINS: stable(pin) },
      { ...origin, bucket: 'wrong-origin' },
    ),
  ).toThrow('binding');
  for (const file of ['wrangler.collector.jsonc', 'wrangler.api.jsonc']) {
    const c = JSON.parse(readFileSync(file, 'utf8'));
    expect(c.r2_buckets?.some((b: any) => b.binding === 'NAS_EXPORT')).not.toBe(true);
    expect(c.vars.PERSONAL_EXPORT_PINS).toBeUndefined();
    expect(c.vars.PERSONAL_INITIAL_COLLECTION_ENABLED).toBeUndefined();
  }
});

describe('dedicated export projection, synthetic buckets only', { timeout: 120000 }, () => {
  let local: Awaited<ReturnType<typeof personalLocalEnv>>;
  beforeAll(async () => {
    local = await personalLocalEnv('synthetic-store');
  });
  afterAll(async () => {
    await local.mf.dispose();
  });
  it('blocks incomplete control sweeps and interrupted parts, retries without source HTTP, preserves contract hash and denies stale/old pins', async () => {
    const { contract, binding } = await cloudFixture();
    const env = cloudPersonalEnv(local.env, contract, binding),
      pin = exportFixture();
    const out = (await local.mf.getR2Bucket('NAS_EXPORT')) as unknown as R2Bucket;
    const base = {
      EVIDENCE: local.env.EVIDENCE,
      NAS_EXPORT: out,
      PERSONAL_EXPORT_PINS: stable(pin),
    };
    const finish = async (b = base) => {
      for (let i = 0; i < 12; i++) {
        const r = await syncNasExport(b, pin, 'highreso_public', 'initial', gpuTime);
        if (r.state === 'complete') return r;
      }
      throw new Error('synthetic checkpoint stuck');
    };
    const source = 'highreso_public',
      root = 'personal-research/control/' + source + '/';
    const fetcher = vi.fn(gpuFetcher(source));
    await collectPersonalGpu(env, contract, { now: () => gpuTime, fetcher, allow_network: true });
    await exportCloudPersonal(env, base.EVIDENCE, contract, { now: () => gpuTime });
    await base.EVIDENCE.put('poc/private-evidence.json', 'SYNTHETIC PRIVATE SENTINEL');
    await base.EVIDENCE.put(
      'personal-research/evidence/highreso_public/raw.html',
      'SYNTHETIC HTML SENTINEL',
    );
    // Enough synthetic native head controls to require a durable paginated checkpoint.
    for (let i = 0; i < 24; i++)
      await base.EVIDENCE.put(
        root +
          'research-control/personal-heads/highreso_public/synthetic-old-' +
          (await hash(String(i))) +
          '.json',
        stable({
          contract_hash: binding.contract_hash,
          sequence: 0,
          review_hash: binding.contract_hash,
          approved_at: contract.decision.approved_at,
          review_after: contract.decision.terms.review_after,
          analysis_until: contract.decision.analysis_until,
          storage_state: 'continuing',
          storage_ends_at: null,
        }),
      );
    const raw = {
      get: async (key: string) => {
        const o = await out.get(key);
        return o ? new Uint8Array(await o.arrayBuffer()) : null;
      },
    };
    const reader = guardedNasReader(raw, pin, source, 'initial', () => gpuTime);
    expect((await syncNasExport(base, pin, source, 'initial', gpuTime)).state).toBe(
      'control_partial',
    );
    await expect(reader.get(cloudControlKey(source))).rejects.toThrow('control_unavailable');
    const current = await (await base.EVIDENCE.get(cloudControlKey(source)))!.json<any>();
    const manifest = await (await base.EVIDENCE.get(current.latest_manifest))!.json<any>();
    const key = manifest.chunks[0].key,
      saved = await (await base.EVIDENCE.get(key))!.arrayBuffer();
    await base.EVIDENCE.delete(key);
    await expect(finish()).rejects.toThrow('part_missing');
    expect(await out.get(current.latest_manifest)).toBeNull();
    await expect(reader.get(cloudControlKey(source))).rejects.toThrow('control_unavailable');
    await base.EVIDENCE.put(key, saved);
    let interrupt = true;
    const broken = new Proxy(out, {
      get(target, p) {
        const v = Reflect.get(target, p);
        return p === 'put'
          ? async (key: string, ...args: any[]) => {
              if (interrupt && key.endsWith('/manifest.json')) {
                interrupt = false;
                throw new Error('synthetic write interruption');
              }
              return Reflect.apply(v, target, [key, ...args]);
            }
          : typeof v === 'function'
            ? v.bind(target)
            : v;
      },
    });
    await expect(finish({ ...base, NAS_EXPORT: broken })).rejects.toThrow('interruption');
    await expect(reader.get(key)).rejects.toThrow('control_unavailable');
    expect((await finish()).state).toBe('complete');
    expect(await reader.get(key)).toEqual(new Uint8Array(saved));
    const gateBefore = await raw.get(exportGateKey(source, 'initial'));
    expect((await syncNasExport(base, pin, source, 'initial', gpuTime)).state).toBe('current');
    expect(await raw.get(exportGateKey(source, 'initial'))).toEqual(gateBefore);
    const projected = JSON.parse(
      Buffer.from((await reader.get(cloudControlKey(source)))!).toString(),
    );
    expect(projected.contract_hash).toBe(binding.contract_hash);
    expect(await hash(stable(contract))).toBe(binding.contract_hash);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(await out.get('poc/private-evidence.json')).toBeNull();
    expect(await out.get('personal-research/evidence/highreso_public/raw.html')).toBeNull();
    expect(
      (await out.list()).objects.every(
        (o) =>
          !o.key.includes('/snapshot.json') &&
          !o.key.includes('/contracts/') &&
          !o.key.includes('/lease.json'),
      ),
    ).toBe(true);
    await expect(
      guardedNasReader(
        raw,
        { ...pin, export_bucket: 'synthetic-old-destination' },
        source,
        'initial',
        () => gpuTime,
      ).get(key),
    ).rejects.toThrow('control_unavailable');
    await expect(
      guardedNasReader(raw, pin, source, 'initial', () => '2026-10-21T00:00:00.000Z').get(key),
    ).rejects.toThrow('control_unavailable');
    const gate = JSON.parse(
      Buffer.from((await raw.get(exportGateKey(source, 'initial')))!).toString(),
    );
    await out.put(exportGateKey(source, 'initial'), stable({ ...gate, ready: false }));
    await expect(reader.get(key)).rejects.toThrow('control_unavailable');
    const selectedHead =
      root + Object.keys(current.records).find((k) => k.includes('/personal-heads/'))!;
    const headBody = await (await base.EVIDENCE.get(selectedHead))!.text();
    await base.EVIDENCE.delete(selectedHead);
    await expect(finish()).rejects.toThrow('control_missing');
    await expect(reader.get(key)).rejects.toThrow('control_unavailable');
    await base.EVIDENCE.put(selectedHead, headBody);
    // Explicit source cancellation is sticky and does not erase unrelated origin evidence.
    await env.EVIDENCE.put('research-control/revocations/highreso_public.json', '{}');
    await syncCloudControl(env, base.EVIDENCE, contract, gpuTime);
    await finish();
    expect(
      JSON.parse(Buffer.from((await reader.get(cloudControlKey(source)))!).toString()).denied,
    ).toBe(true);
    expect(await out.get(key)).toBeNull();
    expect(await base.EVIDENCE.get('poc/private-evidence.json')).not.toBeNull();
  });
});

it('uses only the dedicated S3 bucket and rejects legacy scope before signing (simulated IAM, not live proof)', async () => {
  const pin = exportFixture('synthetic-health-only'),
    source = 'rebro_public';
  const credentials = { accessKeyId: 'SYNTHETIC', secretAccessKey: 'SYNTHETIC' };
  const transport = {
    account_id: pin.account_id,
    bucket: pin.export_bucket,
    source_id: source,
    allow_network: true,
    transport: pin,
    kind: 'daily' as const,
  };
  const at = new Date().toISOString();
  const gate = {
    version: 1,
    generation: crypto.randomUUID(),
    source_id: source,
    kind: 'daily',
    transport_hash: await hash(stable(pin)),
    checked_at: at,
    ready: true,
  };
  const mockIam = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (!path.startsWith('/' + pin.export_bucket + '/') || init?.method !== 'GET')
      return new Response(null, { status: 403 });
    return path.endsWith('/current.json') ? Response.json(gate) : new Response('{}');
  });
  expect(() =>
    createPersonalR2Reader({ ...transport, bucket: pin.origin_bucket }, credentials, mockIam),
  ).toThrow('scope');
  expect(() =>
    createPersonalR2Reader({ ...transport, transport: undefined } as any, credentials, mockIam),
  ).toThrow();
  const reader = createPersonalR2Reader(transport, credentials, mockIam);
  await reader.get('personal-daily/rebro_public/catalog.json');
  expect(mockIam).toHaveBeenCalledTimes(3);
  for (const bucket of [pin.origin_bucket, pin.health_bucket])
    expect(
      (await mockIam('https://example.test/' + bucket + '/object', { method: 'GET' })).status,
    ).toBe(403);
  expect(
    (await mockIam('https://example.test/' + pin.export_bucket + '/object', { method: 'PUT' }))
      .status,
  ).toBe(403);
});
