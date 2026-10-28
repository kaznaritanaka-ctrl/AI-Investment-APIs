import { sources } from '../src/sources';
import { collectSource } from '../src/pipeline';
import { handle } from '../src/api';
import type { CollectorEnv } from '../src/schema';

// Invented values only; the fetcher below never accesses the network.
const html = `<!doctype html><html><body><h2>Full table</h2><table>
<thead><tr><th>Provider</th><th>GPU</th><th>Hourly (USD)</th><th>Basis</th><th>Checked</th></tr></thead>
<tbody><tr><td>SyntheticCloud</td><td>GB300 NVL72</td><td>$12.340/GPU-hr</td><td>Invented rack offer</td><td>2026-10-26</td></tr>
<tr><td>ImaginaryCompute</td><td>Mystery GPU</td><td>$3.50/GPU-hr</td><td>Invented test offer</td><td>2026-10-27</td></tr>
<tr><td>ExampleCloud</td><td>HGX B300</td><td>$6.00/GPU-hr</td><td>Invented node offer</td><td>2026-10-27</td></tr></tbody>
</table></body></html>`;
const now = '2026-10-29T18:17:00.000Z';

export async function effectstoryRuntime(env: CollectorEnv) {
  const source = sources.find((s) => s.source_id === 'effectstory');
  if (!source) throw new Error('effectstory_source_missing');
  const requests: { url: string; method: string; user_agent: string | null }[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    requests.push({
      url: String(url),
      method: init?.method ?? 'GET',
      user_agent: new Headers(init?.headers).get('user-agent'),
    });
    return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  };
  const results = [];
  for (let i = 0; i < 5; i++) {
    const result = await collectSource({ ...env, COLLECTION_CRON: '17 18 * * *' }, source, now, {
      synthetic: true,
      now: () => now,
      network: { fetcher },
    });
    results.push(result);
    if (result.state === 'complete' || result.state === 'failed') break;
  }
  const response = await handle(
    new Request('https://local.test/v1/latest?dataset=gpu_rental&source=effectstory'),
    { PUBLIC_DB: env.PUBLIC_DB },
    now,
  );
  return Response.json({ results, requests, status: response.status, body: await response.json() });
}
