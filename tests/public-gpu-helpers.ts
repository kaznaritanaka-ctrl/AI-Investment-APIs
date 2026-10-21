import type { PublicGpuAdapter } from '../src/research/public-gpu-contract';
import { researchFixture } from './research-helpers';
import { publicGpuSource, gpuTime, robots, terms } from './public-gpu-fixture-config';
export { publicGpuSource, gpuTime, robots, terms };
export const gpuHtml = (adapter: PublicGpuAdapter) =>
  researchFixture(
    adapter === 'highreso_public' ? 'highreso.synthetic.html' : 'rebro.synthetic.html',
  );
export const gpuOptions = (
  c: Awaited<ReturnType<typeof publicGpuSource>>,
  at = gpuTime,
  html = gpuHtml(c.adapter as PublicGpuAdapter),
) => ({ current_terms_version: c.terms.version, now: () => at, synthetic_text: html });
export function gpuFetcher(adapter: PublicGpuAdapter, html = gpuHtml(adapter)): typeof fetch {
  return (async (url) => {
    const u = String(url);
    return new Response(
      u.endsWith('/robots.txt')
        ? robots
        : u.endsWith('/terms') || u.endsWith('/rules/') || u.endsWith('/5401872')
          ? terms
          : html,
      {
        headers: {
          'content-type': u.endsWith('/robots.txt') ? 'text/plain' : 'text/html; charset=utf-8',
        },
      },
    );
  }) as typeof fetch;
}
