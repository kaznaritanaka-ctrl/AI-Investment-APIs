import { syncNasExport } from '../src/research/nas-export';
import { exportFixture } from './nas-export-fixture';
import { cloudFixture } from './personal-cloud-fixture';
import {
  cloudPersonalEnv,
  exportCloudPersonal,
  cloudControlKey,
  cleanCloudPersonal,
} from '../src/research/personal-cloud';
import { type PersonalEnv } from '../src/research/personal';
import { stable } from '../src/util';
import { robots, terms, gpuTime } from './public-gpu-fixture-config';
import { personalCloudScheduled } from '../src/research/personal-cloud-scheduled';
export async function cloudRuntime(base: PersonalEnv & { NAS_EXPORT: R2Bucket }, html: string[]) {
  const results = [];
  let calls = 0;
  for (const [index, source] of (['highreso_public', 'rebro_public'] as const).entries()) {
    const { contract, binding } = await cloudFixture(source),
      env = cloudPersonalEnv(base, contract, binding);
    const fetcher: typeof fetch = async (url) => {
      calls++;
      const u = String(url),
        robot = u.endsWith('/robots.txt');
      return new Response(
        robot ? robots : u.endsWith('/terms') || u.endsWith('/rules/') ? terms : html[index],
        { headers: { 'content-type': robot ? 'text/plain' : 'text/html' } },
      );
    };
    await base.EVIDENCE.put(
      'personal-research/control/contracts/' + source + '.json',
      stable(contract),
    );
    const dispatched = await personalCloudScheduled(
      {
        ...base,
        PERSONAL_EXPORT_PINS: JSON.stringify(exportFixture()),
        PERSONAL_MAINTENANCE_ENABLED: 'true',
        PERSONAL_INITIAL_COLLECTION_ENABLED: 'true',
        PERSONAL_CLOUD_PINS: JSON.stringify({
          account_id: binding.account_id,
          private_database_id: binding.private_database_id,
          bucket: binding.bucket,
          contracts: [{ source_id: source, contract_hash: binding.contract_hash }],
        }),
      } as any,
      { now: () => gpuTime, fetcher },
    );
    if (dispatched[0]?.state !== 'complete') throw new Error('synthetic_initial_dispatch_failed');
    const result = await exportCloudPersonal(env, base.EVIDENCE, contract, { now: () => gpuTime });
    await syncNasExport(
      { ...base, PERSONAL_EXPORT_PINS: JSON.stringify(exportFixture()) },
      exportFixture(),
      source,
      'initial',
      gpuTime,
    );
    const control = await (await base.NAS_EXPORT.get(cloudControlKey(source)))!.json<any>();
    const manifest = await (await base.NAS_EXPORT.get(control.latest_manifest))!.json<any>();
    results.push({
      state: result.state,
      complete: manifest.complete,
      parts: manifest.chunks.length,
      public_binding: 'PUBLIC_DB' in env,
    });
    await cleanCloudPersonal(base.EVIDENCE, source, '2026-10-26T01:00:00.000Z');
  }
  return {
    results,
    calls,
    disabled: await personalCloudScheduled({} as any),
    remaining: await base.PRIVATE_DB.prepare(
      'SELECT COUNT(*) n FROM research_gpu_observations',
    ).first(),
  };
}
