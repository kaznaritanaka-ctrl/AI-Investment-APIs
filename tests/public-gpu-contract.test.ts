import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
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
import {
  assessResearchRetention,
  plusDays,
  retentionSnapshot,
  type RetainedRun,
} from '../src/research/retention';
import { publicGpuSource, gpuHtml, gpuTime, gpuFetcher, terms } from './public-gpu-helpers';

describe('fixed public GPU HTML contracts (entirely synthetic)', () => {
  it.each([highreso, rebro])(
    'applies the Highreso approval and Rebro deferral with independent export gates',
    (proposal) => {
      const c = ResearchConfigSchema.parse(proposal);
      expect(c.source.enabled).toBe(c.adapter === 'highreso_public');
      for (const right of ['automated_collection', 'private_storage', 'internal_analysis'] as const)
        expect(c.source.policy.rights[right]).toBe(
          c.adapter === 'highreso_public' ? 'allowed' : 'review_required',
        );
      for (const right of [
        'raw_redistribution',
        'normalized_redistribution',
        'derived_redistribution',
        'public_display',
        'external_llm_processing',
        'commercial_redistribution',
      ] as const)
        expect(c.source.policy.rights[right]).toBe('denied');
      if (c.adapter === 'highreso_public') {
        expect(c.retention.normalized_mode).toBe('fixed_days');
        expect(c.retention.normalized_days).toBe(365);
        expect(c.retention.time_travel_days).toBe(30);
        expect(c.retention.backup_days).toBe(30);
        expect(c.source.policy.valid_until).toBeNull();
        expect(c.terms.review_after).toBe('2027-01-15T00:00:00.000Z');
        expect(c.public_access?.terms_sha256).toMatch(/^[a-f0-9]{64}$/);
        expect(c.public_access?.next_terms_sha256).toMatch(/^[a-f0-9]{64}$/);
        expect(c.owner_approval_ref).toContain('2026-10-21T13:45Z');
        for (const at of ['2026-10-22T00:00:00.000Z', '2026-11-01T00:00:00.000Z'])
          expect(() => assertResearchAllowed(c, at, c.terms.version)).not.toThrow();
      } else {
        expect(c.retention.normalized_mode).toBe('unapproved');
        expect(c.public_access?.terms_sha256).toBeNull();
        expect(c.owner_approval_ref).toBeNull();
        expect(c.source.known_limitations.join(' ')).toContain('見送り（deferred）');
        c.source.enabled = true;
        expect(() => assertResearchAllowed(c, '2026-10-22T00:00:00.000Z', c.terms.version)).toThrow(
          'policy_blocked',
        );
      }
      expect(readFileSync('wrangler.collector.jsonc', 'utf8')).toContain(
        '"PRIVATE_GPU_RESEARCH_ENABLED": "true"',
      );
      expect(() => assertResearchAllowed(c, gpuTime, c.terms.version)).toThrow('policy_blocked');
      for (const purpose of ['public', 'external_llm', 'raw'] as const)
        expect(() => assertResearchExport(c, purpose)).toThrow('research_export_not_supported');
    },
  );
  it('preserves reviewed license records, independent private gates and public/Admin separation', async () => {
    const review = readFileSync('docs/license-review-20261021.md', 'utf8');
    for (const proposal of [highreso, rebro]) {
      const c = ResearchConfigSchema.parse(proposal);
      const anchor = c.adapter === 'highreso_public' ? 'gpusoroban' : 'rebro';
      expect(c.source.license_url).toBeNull();
      expect(c.source.rights_checked_at).toBe(
        c.adapter === 'highreso_public' ? '2026-10-21T13:46:00.000Z' : '2026-10-21T12:06:00.000Z',
      );
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
    expect(readFileSync('src/collector-handlers.ts', 'utf8')).toContain('./research/collector');
    // Traverse the API and Admin import graphs, including indirect imports.
    const seen = new Set<string>();
    const visit = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      expect(file).not.toMatch(/research\//);
      const body = readFileSync(file, 'utf8');
      for (const match of body.matchAll(/(?:from\s*|import\s*)['"](\.[^'"]+)['"]/g)) {
        const target = resolve(dirname(file), match[1]);
        if (target.endsWith('.json')) continue;
        visit(target + '.ts');
      }
    };
    for (const root of ['src/api.ts', 'src/admin-entrypoint.ts']) visit(resolve(root));
  });
  it('expires approved Highreso history after 365 days while keeping the 30-day backup distinction', () => {
    const c = ResearchConfigSchema.parse(highreso);
    const recorded = '2026-10-22T00:00:00.000Z';
    const run: RetainedRun = {
      run_id: 'a'.repeat(64),
      source_id: c.source.source_id,
      config_hash: 'b'.repeat(64),
      recorded_at: recorded,
      state: 'complete',
      evidence_expires_at: plusDays(recorded, 7),
      evidence_purged_at: null,
      normalized_mode: 'fixed_days',
      normalized_expires_at: plusDays(recorded, 365),
      all_copies_expires_at: plusDays(recorded, 395),
      retention_snapshot_json: JSON.stringify(retentionSnapshot(c)),
      lease_until: null,
    };
    const reminder = assessResearchRetention(c, run, c.terms.review_after, c.terms.version, true);
    expect(reminder.state).toBe('review_due');
    expect(reminder.next_action).toBe('review_terms');
    expect(reminder.normalized_deadline).toBe(plusDays(recorded, 365));
    const expired = assessResearchRetention(c, run, plusDays(recorded, 365), c.terms.version, true);
    expect(expired.state).toBe('retention_expired');
    expect(expired.next_action).toBe('delete');
    expect(expired.read_allowed).toBe(false);
    expect(expired.all_copies_deadline).toBe(plusDays(recorded, 395));
  });
  it('keeps the reviewed Highreso transition beyond November 1 while preserving every remaining gate', async () => {
    const c = await publicGpuSource();
    c.terms = structuredClone(highreso.terms);
    c.source.policy.evidence_version = c.terms.version;
    for (const at of [
      '2026-10-31T14:59:59.000Z',
      '2026-10-31T15:00:00.000Z',
      '2026-11-02T00:00:00.000Z',
    ])
      expect(() => assertResearchAllowed(c, at, c.terms.version)).not.toThrow();
    expect(c.terms.evidence_refs).toContain('https://soroban.highreso.jp/5401872');
    const pending = ResearchConfigSchema.parse(highreso);
    pending.wire_contract_review_ref = null;
    expect(() =>
      assertResearchAllowed(pending, '2026-11-02T00:00:00.000Z', pending.terms.version),
    ).toThrow('research_review_required');
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
  it('prefers /terms after November with the reviewed new fingerprint; notice is an explicit bounded fallback', async () => {
    const c = await publicGpuSource();
    const nextTerms = terms.replace('fixture', 'November fixture');
    c.public_access!.next_terms_sha256 = await termsFingerprint(nextTerms);
    const original = gpuFetcher('highreso_public');
    let november = false;
    const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) =>
      november && (String(url).endsWith('/terms') || String(url).endsWith('/5401872'))
        ? new Response(nextTerms, { headers: { 'content-type': 'text/html' } })
        : original(url, init),
    );
    await fetchPublicGpuPage(c, { fetcher, now: () => '2026-10-31T14:59:59.000Z' });
    expect(fetcher.mock.calls[1][0]).toBe(publicGpuEndpoints.highreso_public.terms);
    fetcher.mockClear();
    november = true;
    await fetchPublicGpuPage(c, { fetcher, now: () => '2026-10-31T15:00:00.000Z' });
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      publicGpuEndpoints.highreso_public.robots,
      publicGpuEndpoints.highreso_public.terms,
      publicGpuEndpoints.highreso_public.page,
    ]);
    expect(fetcher).toHaveBeenCalledTimes(3);
    // A missing primary fails closed with no price GET. Review can select the
    // fixed fallback on a new policy/day, without spending a fourth request.
    const missing = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) =>
      String(url).endsWith('/terms') ? new Response('', { status: 404 }) : fetcher(url, init),
    );
    await expect(
      fetchPublicGpuPage(c, { fetcher: missing, now: () => '2026-11-02T00:00:00.000Z' }),
    ).rejects.toThrow('http_404');
    expect(missing).toHaveBeenCalledTimes(2);
    c.public_access!.highreso_terms_fallback = true;
    fetcher.mockClear();
    await fetchPublicGpuPage(c, { fetcher, now: () => '2026-11-02T00:00:00.000Z' });
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      publicGpuEndpoints.highreso_public.robots,
      'https://soroban.highreso.jp/5401872',
      publicGpuEndpoints.highreso_public.page,
    ]);
    c.public_access!.next_terms_sha256 = null;
    fetcher.mockClear();
    await expect(
      fetchPublicGpuPage(c, { fetcher, now: () => '2026-10-31T15:00:00.000Z' }),
    ).rejects.toThrow('public_access_review_required');
    expect(fetcher).not.toHaveBeenCalled();
    const b = await publicGpuSource('rebro_public');
    b.public_access!.highreso_terms_fallback = true;
    expect(ResearchConfigSchema.safeParse(b).success).toBe(false);
    b.public_access!.highreso_terms_fallback = undefined;
    b.public_access!.next_terms_sha256 = await termsFingerprint(nextTerms);
    expect(ResearchConfigSchema.safeParse(b).success).toBe(false);
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
