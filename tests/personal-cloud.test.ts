import { it, expect, describe, beforeEach, afterEach, vi } from 'vitest';
import { personalLocalEnv } from '../scripts/personal-local-env';
import { cloudFixture } from './personal-cloud-fixture';
import { continuingFixture, reviewFixture } from './personal-continuing-fixture';
import { collectPersonalGpu, readPersonalGpu, maintainPersonalGpu } from '../src/research/personal';
import { inspectPersonalContract, PersonalCloudSchema } from '../src/research/personal-contract';
import { inspectPersonalAuthority } from '../src/research/personal-cloud-authority';
import {
  cloudPersonalEnv,
  exportCloudPersonal,
  cleanCloudPersonal,
  syncCloudControl,
  cloudControlKey,
} from '../src/research/personal-cloud';
import { personalCloudScheduled } from '../src/research/personal-cloud-scheduled';
import { gpuFetcher, gpuTime } from './public-gpu-helpers';
import { personalRunId, renewPersonalReview } from '../src/research/personal-review';
import { sourceRevocationKey } from '../src/research/retention';
import { hash, stable } from '../src/util';
import { verifyNasRestore } from '../scripts/personal-nas-restore';
import { readFileSync } from 'node:fs';

describe('Cloud personal projection (synthetic only)', { timeout: 120000 }, () => {
  let local: Awaited<ReturnType<typeof personalLocalEnv>>;
  beforeEach(async () => {
    local = await personalLocalEnv('synthetic-store');
  });
  afterEach(async () => {
    await local.mf.dispose();
  });
  it('keeps both cloud execution templates unapproved and non-executable with unchanged source hashes', async () => {
    for (const source of ['highreso_public', 'rebro_public']) {
      const draft = JSON.parse(
        readFileSync('docs/personal-execution-20261018/' + source + '.cloud-draft.json', 'utf8'),
      );
      expect(PersonalCloudSchema.safeParse(draft).success).toBe(false);
      expect(draft.status).toBe('draft_pending_owner_approval');
      expect(draft.cloud.account_id).toBeNull();
      expect(draft.decision.retention.backup.key_id).toBeNull();
      expect(draft.config.source.enabled).toBe(false);
      expect(draft.decision.provider_permission).toBe('unconfirmed');
      expect(await hash(stable(draft.config))).toBe(draft.config_sha256);
    }
  });
  it('keeps initial Cloud dispatch separately off, pins the contract and isolates another missing source', async () => {
    const { contract: c, binding } = await cloudFixture();
    await local.env.EVIDENCE.put(
      'personal-research/control/contracts/highreso_public.json',
      stable(c),
    );
    const pins = {
      account_id: binding.account_id,
      private_database_id: binding.private_database_id,
      bucket: binding.bucket,
      contracts: [
        { source_id: 'highreso_public', contract_hash: binding.contract_hash },
        { source_id: 'rebro_public', contract_hash: 'c'.repeat(64) },
      ],
    };
    const base = {
      ...local.env,
      PERSONAL_MAINTENANCE_ENABLED: 'true',
      PERSONAL_CLOUD_PINS: JSON.stringify(pins),
    } as any;
    const fetcher = vi.fn(gpuFetcher('highreso_public')),
      opt = { now: () => gpuTime, fetcher };
    expect(await personalCloudScheduled(base, opt)).toMatchObject([
      { state: 'no_run', acquisition: 'not_requested' },
      { state: 'maintenance_failed' },
    ]);
    expect(fetcher).not.toHaveBeenCalled();
    base.PERSONAL_INITIAL_COLLECTION_ENABLED = 'true';
    expect(await personalCloudScheduled(base, opt)).toMatchObject([
      { state: 'complete', acquisition: 'complete' },
      { state: 'maintenance_failed' },
    ]);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(await personalCloudScheduled(base, opt)).toMatchObject([
      { state: 'complete', acquisition: 'complete' },
      { state: 'maintenance_failed' },
    ]);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(c.config.source.enabled).toBe(false);
  });
  it('keeps local/normal production guards, disabled maintenance, pinned scope and public boundary', async () => {
    const { contract: c, binding } = await cloudFixture();
    const env = cloudPersonalEnv(local.env, c, binding);
    await expect(inspectPersonalContract(c, gpuTime, 'production', 'maintain')).rejects.toThrow(
      'production_forbidden',
    );
    await expect(
      inspectPersonalAuthority({ ...env, PERSONAL_CLOUD: undefined }, c, gpuTime, 'maintain'),
    ).rejects.toThrow();
    await expect(
      inspectPersonalAuthority(env, await continuingFixture(), gpuTime, 'maintain'),
    ).rejects.toThrow();
    await expect(
      inspectPersonalAuthority({ ...env, ENVIRONMENT: 'production' }, c, gpuTime, 'maintain'),
    ).rejects.toThrow('synthetic_boundary');
    await expect(
      inspectPersonalAuthority(
        { ...env, PERSONAL_CLOUD: { ...binding, account_id: 'b'.repeat(32) } },
        c,
        gpuTime,
        'maintain',
      ),
    ).rejects.toThrow('scope_mismatch');
    await expect(
      inspectPersonalAuthority(
        { ...env, PUBLIC_DB: local.env.PRIVATE_DB } as any,
        c,
        gpuTime,
        'maintain',
      ),
    ).rejects.toThrow('cloud_boundary');
    expect(
      PersonalCloudSchema.safeParse({ ...c, cloud: { ...c.cloud, d1_time_travel_days: 30 } })
        .success,
    ).toBe(false);
    expect(await personalCloudScheduled({} as any)).toEqual([]);
    expect((await local.env.EVIDENCE.list()).objects).toHaveLength(0);
  });
  it('exports only complete private projection, resumes interrupted manifest, restores current authority and preserves attempts', async () => {
    const { contract: c, binding } = await cloudFixture();
    const env = cloudPersonalEnv(local.env, c, binding);
    const fetched = vi.fn(gpuFetcher('highreso_public')),
      opt = { now: () => gpuTime, allow_network: true, fetcher: fetched };
    await collectPersonalGpu(env, c, opt);
    let fail = true;
    const interrupted = new Proxy(local.env.EVIDENCE, {
      get(target, key) {
        const value = Reflect.get(target, key);
        return key === 'put'
          ? async (name: string, ...args: any[]) => {
              if (fail && name.endsWith('/manifest.json')) {
                fail = false;
                throw new Error('SYNTHETIC interruption');
              }
              return Reflect.apply(value, target, [name, ...args]);
            }
          : typeof value === 'function'
            ? value.bind(target)
            : value;
      },
    });
    await expect(exportCloudPersonal(env, interrupted, c, opt)).rejects.toThrow('interruption');
    expect(await local.env.EVIDENCE.get(cloudControlKey('highreso_public'))).toBeNull();
    expect((await exportCloudPersonal(env, local.env.EVIDENCE, c, opt)).state).toBe('complete');
    const control = await (await local.env.EVIDENCE.get(
      cloudControlKey('highreso_public'),
    ))!.json<any>();
    const manifest = await (await local.env.EVIDENCE.get(control.latest_manifest))!.json<any>();
    const chunks = await Promise.all(
      manifest.chunks.map(
        async (p: any) =>
          new Uint8Array(await (await local.env.EVIDENCE.get(p.key))!.arrayBuffer()),
      ),
    );
    const snapshot = JSON.parse(Buffer.concat(chunks).toString());
    expect(snapshot.tables.research_gpu_observations).toHaveLength(4);
    expect(snapshot.tables.research_runs[0].normalized_expires_at).toBeNull();
    expect(Object.keys(snapshot.tables)).not.toContain('research_pages');
    expect(await verifyNasRestore(snapshot, control, gpuTime)).toMatchObject({
      state: 'verified',
      observation_count: 4,
      short_evidence_restored: false,
    });
    await collectPersonalGpu(env, c, opt);
    expect(fetched).toHaveBeenCalledTimes(3);
    const changed = structuredClone(c);
    changed.decision.exception_id = 'synthetic-new-id';
    const changedEnv = cloudPersonalEnv(local.env, changed, {
      ...binding,
      contract_hash: await hash(stable(changed)),
    });
    await expect(collectPersonalGpu(changedEnv, changed, opt)).rejects.toThrow(
      'initial_attempt_locked',
    );
    expect(fetched).toHaveBeenCalledTimes(3);
    expect(c.config.source.enabled).toBe(false);
    expect(c.decision.provider_permission).toBe('unconfirmed');
    const later = '2037-10-18T01:00:00.000Z';
    expect((await maintainPersonalGpu(env, c, { now: () => later })).state).toBe('review_due');
    await renewPersonalReview(env, c, await reviewFixture(env, c as any, later), {
      now: () => later,
    });
    expect((await readPersonalGpu(env, c, { now: () => later })).results).toHaveLength(4);
    // A fresh generation still contains the original 11-year-old history, not only
    // observations inside the backup-generation retention window.
    expect(
      (await exportCloudPersonal(env, local.env.EVIDENCE, c, { now: () => later })).state,
    ).toBe('complete');
    expect(await personalRunId(c)).toBe(snapshot.run_id);
  });
  it('propagates revocation without restoring control and cleans only backup generations, not continuing history', async () => {
    const { contract: c, binding } = await cloudFixture('rebro_public'),
      env = cloudPersonalEnv(local.env, c, binding),
      opt = { now: () => gpuTime, allow_network: true, fetcher: gpuFetcher('rebro_public') };
    await collectPersonalGpu(env, c, opt);
    await exportCloudPersonal(env, local.env.EVIDENCE, c, opt);
    const future = '2026-10-26T01:00:00.000Z';
    let result;
    do {
      result = await cleanCloudPersonal(local.env.EVIDENCE, 'rebro_public', future);
    } while (result.more);
    expect(
      (
        await env.PRIVATE_DB.prepare(
          'SELECT COUNT(*) n FROM research_gpu_observations',
        ).first<any>()
      ).n,
    ).toBe(2);
    await env.EVIDENCE.put(
      sourceRevocationKey('rebro_public'),
      stable({ source_id: 'rebro_public', revoked_at: future }),
    );
    expect(
      (await exportCloudPersonal(env, local.env.EVIDENCE, c, { now: () => future })).state,
    ).toBe('purged');
    const control = await syncCloudControl(env, local.env.EVIDENCE, c, future);
    expect(control.denied).toBe(true);
    expect(control.latest_manifest).toBeNull();
    // Loss of native denial markers must not turn the independent current control back on.
    for (const key of Object.keys(control.records).filter((key) =>
      /research-control\/(revocations|deletions)\//.test(key),
    )) {
      await local.env.EVIDENCE.delete('personal-research/control/rebro_public/' + key);
    }
    expect((await syncCloudControl(env, local.env.EVIDENCE, c, future)).denied).toBe(true);
    expect(
      (
        await env.PRIVATE_DB.prepare(
          'SELECT COUNT(*) n FROM research_gpu_observations',
        ).first<any>()
      ).n,
    ).toBe(0);
  });
});
