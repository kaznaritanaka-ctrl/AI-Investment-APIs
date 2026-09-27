import type { Source } from './schema';
export type Partition = NonNullable<Source['gpu']>['partitions'][number];
export type RequestPlan = {
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
};
const hosts: Record<string, string> = {
  lambda: 'https://cloud.lambda.ai/api/v1/instance-types',
  sakura_dok: 'https://secure.sakura.ad.jp/cloud/zone/is1a/api/managed-container/1.0/unit_prices/',
  ebay_browse: 'https://api.ebay.com/buy/browse/v1/item_summary/search',
  price_of_compute: 'https://priceofcompute.com/api/v1/prices/',
};
export const EBAY_OAUTH = 'https://api.ebay.com/identity/v1/oauth2/token';
export function gpuRequestPlan(
  s: Source,
  p: Partition,
  page: number,
  scheduled: string,
): RequestPlan {
  const g = s.gpu;
  if (!g || !Number.isSafeInteger(page) || page < 0 || page >= g.max_pages)
    throw new Error('page_budget_exceeded');
  const endpoint = hosts[s.adapter];
  if (!endpoint || s.endpoint !== endpoint) throw new Error('endpoint_not_allowed');
  const url = new URL(endpoint);
  let headers: Record<string, string> = {};
  if (s.adapter === 'ebay_browse') {
    if (Object.keys(p.query).some((k) => !['q', 'filter', 'sort', 'marketplace'].includes(k)))
      throw new Error('query_not_allowed');
    if (!['EBAY_US', 'EBAY_GB', 'EBAY_DE'].includes(p.query.marketplace))
      throw new Error('marketplace_not_configured');
    if (!p.query.q || p.query.q.length > 200 || (p.query.filter?.length ?? 0) > 500)
      throw new Error('query_not_allowed');
    for (const k of ['q', 'filter', 'sort']) if (p.query[k]) url.searchParams.set(k, p.query[k]);
    url.searchParams.set('limit', String(g.page_size));
    url.searchParams.set('offset', String(page * g.page_size));
    if (page * g.page_size >= 10000) throw new Error('provider_result_cap');
    headers = { 'X-EBAY-C-MARKETPLACE-ID': p.query.marketplace };
  } else if (s.adapter === 'sakura_dok') {
    if (Object.keys(p.query).length) throw new Error('query_not_allowed');
    const date = new Date(scheduled);
    const jp = new Date(date.getTime() + 9 * 3600000).toISOString().slice(0, 10);
    const [year, month, day] = jp.split('-');
    for (const [key, value] of Object.entries({
      year,
      month,
      day,
      page: String(page + 1),
      page_size: String(g.page_size),
    }))
      url.searchParams.set(key, value);
  } else if (s.adapter === 'price_of_compute') {
    if (
      page !== 0 ||
      Object.keys(p.query).some((k) => k !== 'sku') ||
      !['a100-pcie-80gb', 'a100-sxm-80gb', 'h100-pcie', 'h100-sxm', 'b200', 'b300'].includes(
        p.query.sku,
      )
    )
      throw new Error('query_not_allowed');
    url.pathname += p.query.sku;
  } else if (page !== 0 || Object.keys(p.query).length) throw new Error('query_not_allowed');
  return { url: url.toString(), method: 'GET', headers };
}
export function validateNextURL(
  s: Source,
  p: Partition,
  page: number,
  scheduled: string,
  next: string | null,
) {
  if (next === null || next === '') return;
  const expected = new URL(gpuRequestPlan(s, p, page + 1, scheduled).url),
    actual = new URL(next, s.endpoint!);
  if (
    actual.username ||
    actual.password ||
    actual.hash ||
    actual.origin !== expected.origin ||
    actual.pathname !== expected.pathname
  )
    throw new Error('pagination_destination_blocked');
  for (const key of new Set([...actual.searchParams.keys(), ...expected.searchParams.keys()])) {
    if (
      actual.searchParams.getAll(key).length !== expected.searchParams.getAll(key).length ||
      actual.searchParams.get(key) !== expected.searchParams.get(key)
    )
      throw new Error('pagination_scope_changed');
  }
}
