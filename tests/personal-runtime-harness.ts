import { personalFixture, gpuTime } from './personal-fixture';
import { robots, terms } from './public-gpu-fixture-config';
import {
  collectPersonalGpu,
  readPersonalGpu,
  maintainPersonalGpu,
  type PersonalEnv,
} from '../src/research/personal';
export async function personalRuntime(env: PersonalEnv, highresoHtml: string, rebroHtml: string) {
  const counts = [],
    origins = [];
  let calls = 0;
  for (const source of ['highreso_public', 'rebro_public'] as const) {
    const c = await personalFixture(source);
    const fetcher: typeof fetch = async (url) => {
      calls++;
      const u = String(url),
        robot = u.endsWith('/robots.txt');
      return new Response(
        robot
          ? robots
          : u.endsWith('/terms') || u.endsWith('/rules/')
            ? terms
            : source === 'highreso_public'
              ? highresoHtml
              : rebroHtml,
        { headers: { 'content-type': robot ? 'text/plain' : 'text/html' } },
      );
    };
    const opt = { allow_network: true, fetcher, now: () => gpuTime };
    await collectPersonalGpu(env, c, opt);
    counts.push((await readPersonalGpu(env, c, opt)).results.length);
    origins.push(c.config.source.policy.rights.private_storage);
    await collectPersonalGpu(env, c, opt);
    await maintainPersonalGpu(env, c, { now: () => '2026-10-28T01:00:00.000Z' });
  }
  return {
    counts,
    origins,
    calls,
    remaining: await env.PRIVATE_DB.prepare(
      'SELECT COUNT(*) n FROM research_gpu_observations',
    ).first(),
    public_binding: 'PUBLIC_DB' in env,
  };
}
