import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { canCollect, canPublish } from '../src/policy';
import { rightsKeys } from '../src/schema';
import {
  assertResearchAllowed,
  assertResearchExport,
  ResearchConfigSchema,
} from '../src/research/schema';
import { parseEia, parseJepx, researchRequest } from '../src/research/electricity';
import { fetchBounded } from '../src/network';
import {
  eiaQuery,
  jepxQuery,
  researchFixture,
  researchSource,
  researchTime,
} from './research-helpers';
import { sources } from '../src/sources';

describe('private research contracts (synthetic, no live HTTP)', () => {
  it('keeps both proposals disabled and all nine grants unpromoted; not in the production registry', () => {
    for (const id of ['eia_retail_co_ind', 'jepx_tokyo']) {
      const c = ResearchConfigSchema.parse(
        JSON.parse(readFileSync('config/proposals/research/' + id + '.json', 'utf8')),
      );
      expect(c.source.enabled).toBe(false);
      expect(Object.keys(c.source.policy.rights).sort()).toEqual([...rightsKeys].sort());
      expect(Object.values(c.source.policy.rights)).not.toContain('allowed');
      expect(sources.some((s) => s.source_id === id)).toBe(false);
    }
    const collector = readFileSync('wrangler.collector.jsonc', 'utf8');
    expect(collector).toContain('"AGENT_ENABLED": "false"');
    expect(collector).toContain('"17 18 * * *"');
    expect(collector).toContain('"47 18 * * *"');
    expect(collector).toContain('"*/5 18-23 * * *"');
    expect(readFileSync('src/collector.ts', 'utf8')).not.toContain('research/');
    expect(readFileSync('wrangler.api.jsonc', 'utf8')).not.toMatch(/PRIVATE_DB|EVIDENCE/);
  });
  it('treats null license as unknown while enforcing each private grant and independent export gates', () => {
    const c = researchSource();
    expect(c.source.license_url).toBeNull();
    expect(canCollect(c.source, researchTime)).toBe(true);
    expect(() => assertResearchAllowed(c, researchTime, c.terms.version)).not.toThrow();
    expect(canPublish(c.source, researchTime)).toBe(false);
    for (const purpose of ['public', 'external_llm', 'raw'] as const)
      expect(() => assertResearchExport(c, purpose)).toThrow('research_export_not_supported');
    for (const right of ['automated_collection', 'private_storage', 'internal_analysis'] as const) {
      const blocked = structuredClone(c);
      blocked.source.policy.rights[right] = 'review_required';
      expect(() => assertResearchAllowed(blocked, researchTime, c.terms.version)).toThrow(
        'policy_blocked',
      );
    }
  });
  it('blocks changed terms, expired policy, unreviewed retention and limits including backup copies', () => {
    const c = researchSource();
    expect(() => assertResearchAllowed(c, researchTime, 'changed-terms')).toThrow(
      'terms_review_required',
    );
    expect(() => assertResearchAllowed(c, c.source.policy.valid_until!, c.terms.version)).toThrow(
      'policy_blocked',
    );
    const retention = structuredClone(c);
    retention.source.policy.retention_limit_days = 100; // 90 normalized + 30 backup exceeds this.
    expect(() => assertResearchAllowed(retention, researchTime, c.terms.version)).toThrow(
      'retention_review_required',
    );
    retention.retention.reviewed_ref = null;
    expect(() => assertResearchAllowed(retention, researchTime, c.terms.version)).toThrow(
      'research_review_required',
    );
    c.terms.review_after = researchTime;
    expect(() => assertResearchAllowed(c, researchTime, c.terms.version)).toThrow(
      'terms_review_required',
    );
  });
  it('parses scoped EIA monthly strings and omits unknown dates and credential-echo envelopes', () => {
    const page = parseEia(researchSource(), eiaQuery, researchFixture('eia.synthetic.json'), 0);
    expect(page.coverage).toBe('complete');
    expect(page.records[0]).toMatchObject({
      amount_decimal: '12.3456',
      original_unit: 'cents per kilowatthour',
      source_date: null,
      source_published_at: null,
      period: '2026-07',
      market: 'retail_average',
    });
    expect(page.records[1]).toMatchObject({ amount_decimal: null, missing_reason: 'not_reported' });
    expect(JSON.stringify(page)).not.toContain('SYNTHETIC_DO_NOT_PERSIST');
    const changed = JSON.parse(researchFixture('eia.synthetic.json'));
    changed.response.data[0]['price-units'] = 'dollars per megawatthour';
    expect(() => parseEia(researchSource(), eiaQuery, JSON.stringify(changed), 0)).toThrow();
    changed.response.data[0]['price-units'] = 'cents per kilowatthour';
    changed.response.total = '3';
    expect(() => parseEia(researchSource(), eiaQuery, JSON.stringify(changed), 0)).toThrow(
      'eia_pagination_mismatch',
    );
    expect(() => parseEia(researchSource(), { ...eiaQuery, from: '2020-01' }, '{}', 0)).toThrow(
      'research_window_limit',
    );
  });
  it('refuses EIA credential URLs and arbitrary endpoints; JEPX uses a fixed fiscal-year request', () => {
    expect(() => researchRequest(researchSource(), eiaQuery, 0)).toThrow(
      'credential_url_disallowed',
    );
    const c = researchSource('jepx_spot');
    expect(researchRequest(c, { kind: 'jepx_spot', delivery_date: '2026-02-01' }, 0).url).toBe(
      'https://www.jepx.jp/js/csv_read.php?dir=spot_summary&file=spot_summary_2025.csv',
    );
    c.source.endpoint = 'https://example.invalid/private';
    expect(() => researchRequest(c, jepxQuery, 0)).toThrow('endpoint_not_allowed');
    c.source.source_url = 'https://example.invalid/?credential=not-permitted';
    expect(() => ResearchConfigSchema.parse(c)).toThrow();
  });
  it('keeps JEPX half hours, local day, units, negative values, real zero and missing prices separate', () => {
    const c = researchSource('jepx_spot'),
      csv = researchFixture('jepx.synthetic.csv');
    const page = parseJepx(c, jepxQuery, csv, 0);
    expect(page.coverage).toBe('complete');
    expect(page.records).toHaveLength(48);
    expect(page.records[0]).toMatchObject({
      amount_decimal: '-0.05',
      interval_start: '2026-10-14T15:00:00.000Z',
      source_date: '2026-10-15',
      timezone: 'Asia/Tokyo',
      original_unit: 'JPY/kWh',
    });
    expect(page.records[1].amount_decimal).toBe('0');
    expect(page.records[2].amount_decimal).toBeNull();
    expect(page.records[47].interval_end).toBe('2026-10-15T15:00:00.000Z');
    const short = csv.trim().split('\n').slice(0, 2).join('\n');
    expect(parseJepx(c, jepxQuery, short, 0)).toMatchObject({
      coverage: 'partial',
      reasons: ['missing_intervals'],
    });
    expect(() => parseJepx(c, jepxQuery, short + '\n' + short.split('\n')[1], 0)).toThrow(
      'jepx_duplicate_interval',
    );
    expect(() => parseJepx(c, jepxQuery, csv.replace('東京', '大阪'), 0)).toThrow(
      'jepx_header_changed',
    );
    expect(parseJepx(c, { ...jepxQuery, delivery_date: '2026-10-16' }, csv, 0)).toMatchObject({
      coverage: 'partial',
      reasons: ['source_empty'],
      records: [],
    });
    c.limits.max_input_rows = 10;
    expect(() => parseJepx(c, jepxQuery, csv, 0)).toThrow('csv_row_limit');
  });
  it('reuses finite transport retries, enforces bytes/redirects/timeout and does not relax JSON content checks', async () => {
    const c = researchSource('jepx_spot'),
      plan = researchRequest(c, jepxQuery, 0);
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 429, headers: { 'retry-after': '0' } }))
      .mockResolvedValueOnce(
        new Response(researchFixture('jepx.synthetic.csv'), {
          headers: { 'content-type': 'text/csv' },
        }),
      );
    const network = { fetcher, now: () => researchTime, sleep: async () => {}, random: () => 0 };
    expect((await fetchBounded(c.source, plan, network, 'csv')).status).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const limited = vi
      .fn()
      .mockImplementation(
        async () => new Response(null, { status: 429, headers: { 'retry-after': '60' } }),
      );
    await expect(
      fetchBounded(c.source, plan, { ...network, fetcher: limited }, 'csv'),
    ).rejects.toMatchObject({ message: 'rate_limited', retry_at: '2026-10-15T01:01:00.000Z' });
    expect(limited).toHaveBeenCalledTimes(1);
    const redirect = vi
      .fn()
      .mockImplementation(
        async () =>
          new Response(null, { status: 302, headers: { location: 'https://example.invalid/' } }),
      );
    await expect(
      fetchBounded(c.source, plan, { ...network, fetcher: redirect }, 'csv'),
    ).rejects.toThrow('redirect_blocked');
    const tooBig = vi.fn().mockImplementation(
      async () =>
        new Response('x', {
          headers: { 'content-type': 'text/csv', 'content-length': '6000001' },
        }),
    );
    await expect(
      fetchBounded(c.source, plan, { ...network, fetcher: tooBig }, 'csv'),
    ).rejects.toThrow('response_too_large');
    const wrongType = vi
      .fn()
      .mockImplementation(
        async () => new Response('x', { headers: { 'content-type': 'text/csv' } }),
      );
    await expect(fetchBounded(c.source, plan, { ...network, fetcher: wrongType })).rejects.toThrow(
      'unexpected_content_type',
    );
    const hanging = vi.fn().mockImplementation(() => new Promise(() => {}));
    await expect(
      fetchBounded(c.source, plan, { ...network, fetcher: hanging, timeout_ms: 2 }, 'csv'),
    ).rejects.toThrow('timeout');
    expect(hanging).toHaveBeenCalledTimes(3);
  });
});
