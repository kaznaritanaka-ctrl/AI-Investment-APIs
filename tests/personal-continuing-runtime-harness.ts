import { continuingFixture, reviewFixture } from './personal-continuing-fixture';
import { gpuTime } from './personal-fixture';
import { robots, terms } from './public-gpu-fixture-config';
import {
  collectPersonalGpu,
  readPersonalGpu,
  maintainPersonalGpu,
  type PersonalEnv,
} from '../src/research/personal';
import { renewPersonalReview } from '../src/research/personal-review';
import { createPersonalSnapshot } from '../src/research/personal-snapshot';
export async function continuingRuntime(env: PersonalEnv, html: string[]) {
  const counts: number[] = [],
    states: string[] = [],
    snapshots: number[] = [];
  let calls = 0;
  for (const [i, source] of (['highreso_public', 'rebro_public'] as const).entries()) {
    const c = await continuingFixture(source);
    const fetcher: typeof fetch = async (url) => {
      calls++;
      const u = String(url),
        robot = u.endsWith('/robots.txt');
      return new Response(
        robot ? robots : u.endsWith('/terms') || u.endsWith('/rules/') ? terms : html[i],
        { headers: { 'content-type': robot ? 'text/plain' : 'text/html' } },
      );
    };
    const opt = { allow_network: true, fetcher, now: () => gpuTime };
    await collectPersonalGpu(env, c, opt);
    snapshots.push(
      (await createPersonalSnapshot(env, c, opt)).snapshot.tables.research_gpu_observations.length,
    );
    const future = { now: () => '2037-10-18T01:00:00.000Z' };
    states.push((await maintainPersonalGpu(env, c, future)).state);
    await renewPersonalReview(env, c, await reviewFixture(env, c, future.now()), future);
    counts.push((await readPersonalGpu(env, c, future)).results.length);
  }
  return {
    counts,
    states,
    snapshots,
    calls,
    public_binding: 'PUBLIC_DB' in env,
    remaining: await env.PRIVATE_DB.prepare(
      'SELECT COUNT(*) n FROM research_gpu_observations',
    ).first(),
  };
}
