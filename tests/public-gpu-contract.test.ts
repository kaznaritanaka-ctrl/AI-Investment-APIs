import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { sources } from '../src/sources';
import highreso from '../config/proposals/research/highreso_public.json';
import rebro from '../config/proposals/research/rebro_public.json';
import {
  ResearchConfigSchema,
  assertResearchAllowed,
  assertResearchExport,
} from '../src/research/schema';
import {
  parsePublicGpu,
  gpuRecordFingerprint,
  termsFingerprint,
} from '../src/research/public-gpu-html';
import { fetchPublicGpuPage } from '../src/research/public-gpu-network';
import { publicGpuEndpoints, PUBLIC_GPU_UA } from '../src/research/public-gpu-contract';
import { publicGpuSource, gpuHtml, gpuTime, gpuFetcher, terms } from './public-gpu-helpers';

describe('fixed public GPU HTML contracts (entirely synthetic)', () => {
  it.each([highreso, rebro])(
    'keeps $adapter disabled and independently rights/retention gated',
    (proposal) => {
      const c = ResearchConfigSchema.parse(proposal);
      expect(c.source.enabled).toBe(false);
      expect(Object.values(c.source.policy.rights)).not.toContain('allowed');
      expect(c.retention.normalized_mode).toBe('unapproved');
      expect(c.public_access?.reviewed_ref).toBeNull();
      expect(() => assertResearchAllowed(c, gpuTime, c.terms.version)).toThrow('policy_blocked');
      for (const purpose of ['public', 'external_llm', 'raw'] as const)
        expect(() => assertResearchExport(c, purpose)).toThrow('research_export_not_supported');
    },
  );
  it('preserves main license records, independent private gates and the disabled production boundary', async () => {
    const review = readFileSync('docs/license-review-20261021.md', 'utf8');
    for (const proposal of [highreso, rebro]) {
      const c = ResearchConfigSchema.parse(proposal);
      const anchor = c.adapter === 'highreso_public' ? 'gpusoroban' : 'rebro';
      expect(c.source.license_url).toBeNull();
      expect(c.source.rights_checked_at).toBe('2026-10-21T00:00:00.000Z');
      expect(c.source.rights_evidence_ref).toBe('docs/license-review-20261021.md#' + anchor);
      expect(review).toContain('<a id="' + anchor + '"></a>');
      expect(c.source.known_limitations.join(' ')).toContain('2026-10-21 license review:');
      expect(sources.some((s) => s.source_id === c.source.source_id)).toBe(false);
    }
    for (const right of ['automated_collection', 'private_storage', 'internal_analysis'] as const) {
      const c = await publicGpuSource();
      c.source.policy.rights[right] = 'review_required';
      const fetcher = vi.fn();
      await expect(fetchPublicGpuPage(c, { fetcher, now: () => gpuTime })).rejects.toThrow(
        'policy_blocked',
      );
      expect(fetcher).not.toHaveBeenCalled();
    }
    expect(readFileSync('src/collector-handlers.ts', 'utf8')).not.toMatch(/research\//);
  });
  it('rejects arbitrary endpoints, expanded scope, missing access/retention approvals', async () => {
    const c = await publicGpuSource();
    expect(() => assertResearchAllowed(c, gpuTime, c.terms.version)).not.toThrow();
    for (const change of [
      { source: { ...c.source, endpoint: 'https://example.test/private' } },
      { scope: { kind: 'highreso_public', models: ['A100', 'A100'] } },
      { limits: { ...c.limits, max_pages: 2 } },
    ])
      expect(ResearchConfigSchema.safeParse({ ...c, ...change }).success).toBe(false);
    c.public_access!.reviewed_ref = null;
    expect(() => assertResearchAllowed(c, gpuTime, c.terms.version)).toThrow(
      'public_access_review_required',
    );
    c.public_access!.reviewed_ref = 'synthetic';
    c.retention.normalized_mode = 'unapproved';
    expect(() => assertResearchAllowed(c, gpuTime, c.terms.version)).toThrow(
      'retention_review_required',
    );
  });
  it('keeps instance hourly/monthly units, decimal text, unknown location/form and missing price', async () => {
    const c = await publicGpuSource();
    const page = await parsePublicGpu(c, gpuHtml('highreso_public'), gpuTime, true);
    expect(page.records).toHaveLength(4);
    expect(page.records[0]).toMatchObject({
      instance_id: 'synthetic-a100',
      storage_gb: '777',
      identity: { accelerator_model: 'A100', vram_gb: '80', form_factor: 'unknown' },
      offer: {
        amount_decimal: '1234.56',
        unit: 'node_hour',
        sale_unit: 'instance',
        gpu_count: 2,
        observation_kind: 'rental_quote',
        tax_status: 'included',
        region: null,
        source_period: null,
        transaction_at: null,
        availability: 'unknown',
        observed_at: gpuTime,
      },
    });
    expect(page.records[1].offer).toMatchObject({
      unit: 'month',
      amount_decimal: '87654',
      contract: 'monthly',
    });
    expect(page.records[2].offer).toMatchObject({
      amount_decimal: null,
      missing_reason: 'not_reported',
    });
    expect(JSON.stringify(page)).not.toContain('SYNTHETIC_DO_NOT_PERSIST');
    const next = await parsePublicGpu(
      c,
      gpuHtml('highreso_public'),
      '2026-10-19T01:00:00.000Z',
      true,
    );
    expect(await gpuRecordFingerprint(next.records[0])).toBe(
      await gpuRecordFingerprint(page.records[0]),
    );
  });
  it('keeps selected reported case basis, month precision and per-GPU unit separate from quantity', async () => {
    const c = await publicGpuSource('rebro_public');
    const page = await parsePublicGpu(c, gpuHtml('rebro_public'), gpuTime, true);
    expect(page.records).toHaveLength(2);
    expect(page.records[0]).toMatchObject({
      reported_quantity: 3,
      offer: {
        observation_kind: 'buy_execution_report',
        basis: 'selected_public_case',
        source_period: '2025-02',
        source_period_precision: 'month',
        transaction_at: null,
        source_published_at: null,
        amount_decimal: '234567',
        unit: 'gpu',
        gpu_count: 1,
        tax_status: 'unknown',
        condition: 'unknown',
      },
    });
    expect(page.records[1]).toMatchObject({
      reported_quantity: null,
      offer: { amount_decimal: null, missing_reason: 'not_reported' },
    });
    expect(JSON.stringify(page)).not.toContain('SYNTHETIC_DO_NOT_PERSIST');
    await expect(
      parsePublicGpu(c, gpuHtml('rebro_public').replace('買取実績', '査定参考価格'), gpuTime, true),
    ).rejects.toThrow('public_gpu_execution_basis_unconfirmed');
  });
  it.each([
    'missing',
    'truncated',
    'price',
    'quantity',
    'month',
    'challenge',
    'subsection',
    'span',
  ])('rejects %s without inventing records', async (variant) => {
    const c = await publicGpuSource('rebro_public');
    let html = gpuHtml('rebro_public');
    if (variant === 'missing') html = '<html><body>No table</body></html>';
    if (variant === 'truncated') html = html.slice(0, html.indexOf('</table>'));
    if (variant === 'price') html = html.replace('234,567円', '234,567円から');
    if (variant === 'quantity') html = html.replace('3枚', '約3枚');
    if (variant === 'month') html = html.replace('2025年2月', '2025年13月');
    if (variant === 'challenge') html = '<html>Verify you are human</html>';
    if (variant === 'subsection') html = html.replace('<table>', '<h3>査定提示価格</h3><table>');
    if (variant === 'span') html = html.replace('<td>3枚', '<td colspan="2">3枚');
    await expect(parsePublicGpu(c, html, gpuTime, true)).rejects.toThrow();
  });
  it('uses exactly three fixed GETs, identifying UA, no redirects or credentials', async () => {
    const c = await publicGpuSource();
    const fetcher = vi.fn(gpuFetcher('highreso_public'));
    await fetchPublicGpuPage(c, { fetcher, now: () => gpuTime });
    const urls = publicGpuEndpoints.highreso_public;
    expect(fetcher.mock.calls.map((call) => call[0])).toEqual([urls.robots, urls.terms, urls.page]);
    for (const [, init] of fetcher.mock.calls) {
      expect(init).toMatchObject({ method: 'GET', redirect: 'manual' });
      expect(new Headers(init?.headers).get('user-agent')).toBe(PUBLIC_GPU_UA);
      expect(new Headers(init?.headers).has('authorization')).toBe(false);
    }
    expect(new Headers(fetcher.mock.calls[2][1]?.headers).get('accept')).toBe('text/html');
  });
  it.each([401, 403, 429, 500])('does not retry HTTP %s within the run', async (status) => {
    const c = await publicGpuSource();
    const fetcher = vi.fn(
      async () => new Response('', { status, headers: { 'retry-after': '5' } }),
    );
    await expect(fetchPublicGpuPage(c, { fetcher, now: () => gpuTime })).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('hashes visible terms and blocks changed terms/robots before price acquisition', async () => {
    const c = await publicGpuSource();
    expect(await termsFingerprint(terms + '<script>dynamic</script>')).toBe(
      c.public_access!.terms_sha256,
    );
    const original = gpuFetcher('highreso_public');
    for (const target of ['robots.txt', 'terms']) {
      const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) =>
        String(url).endsWith(target)
          ? new Response(
              target === 'terms'
                ? terms.replace('fixture', 'changed')
                : 'User-agent: *\nDisallow: /',
              { headers: { 'content-type': target === 'terms' ? 'text/html' : 'text/plain' } },
            )
          : original(url, init),
      );
      await expect(fetchPublicGpuPage(c, { fetcher, now: () => gpuTime })).rejects.toThrow(
        'review_required',
      );
      expect(fetcher.mock.calls.some(([url]) => String(url) === c.source.endpoint)).toBe(false);
    }
  });
});
