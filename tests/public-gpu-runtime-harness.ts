import { collectPublicGpuDay } from '../src/research/public-gpu';
import { readResearchRun } from '../src/research/pipeline';
import { publicGpuSource, gpuTime, robots, terms } from './public-gpu-fixture-config';
import type { ResearchEnv } from '../src/research/pipeline';
export async function publicGpuRuntime(env: ResearchEnv, html: string, secondHtml: string) {
  const configs = [await publicGpuSource(), await publicGpuSource('rebro_public')];
  let calls = 0;
  const fetcher: typeof fetch = async (url) => {
    calls++;
    const u = String(url);
    return new Response(
      u.endsWith('/robots.txt')
        ? robots
        : u.endsWith('/terms') || u.endsWith('/rules/')
          ? terms
          : u.includes('highreso')
            ? html
            : secondHtml,
      { headers: { 'content-type': u.endsWith('/robots.txt') ? 'text/plain' : 'text/html' } },
    );
  };
  const options = (c: (typeof configs)[number]) => ({
    current_terms_version: c.terms.version,
    now: () => gpuTime,
    fetcher,
    allow_network: true,
  });
  const results = await collectPublicGpuDay(env, configs, gpuTime, options);
  const counts = [];
  for (const [i, r] of results.entries())
    counts.push(
      r.run_id
        ? (await readResearchRun(env, configs[i], r.run_id, options(configs[i]))).results.length
        : 0,
    );
  return Response.json({ results, calls, counts, external_http_requests: 0, synthetic: true });
}
