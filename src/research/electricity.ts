import { z } from 'zod';
import { decimal, isoDate } from '../util';
import {
  ResearchPageSchema,
  signedDecimal,
  validateQuery,
  type ResearchConfig,
  type ResearchQuery,
  type ElectricityRecord,
} from './schema';

export const EIA_ENDPOINT = 'https://api.eia.gov/v2/electricity/retail-sales/data/';
export const JEPX_ENDPOINT = 'https://www.jepx.jp/js/csv_read.php';

export function researchRequest(config: ResearchConfig, input: ResearchQuery, page: number) {
  const q = validateQuery(config, input);
  if (!Number.isInteger(page) || page < 0 || page >= config.limits.max_pages)
    throw new Error('research_page_limit');
  if (q.kind === 'eia_retail') {
    // Official API requires api_key in the URL, which issue #15 explicitly forbids.
    // Never invent a header-based authentication endpoint or read a Secret here.
    throw new Error('credential_url_disallowed');
  }
  if (config.source.endpoint !== JEPX_ENDPOINT || config.source.authentication_required !== false)
    throw new Error('endpoint_not_allowed');
  const year =
    Number(q.delivery_date.slice(0, 4)) - (Number(q.delivery_date.slice(5, 7)) < 4 ? 1 : 0);
  return {
    url: JEPX_ENDPOINT + '?dir=spot_summary&file=spot_summary_' + year + '.csv',
    method: 'GET' as const,
    headers: {},
  };
}
function boundedText(config: ResearchConfig, text: string) {
  if (new TextEncoder().encode(text).length > config.source.max_bytes)
    throw new Error('response_too_large');
}
const eiaEnvelope = z.object({
  response: z.object({
    total: z.string().regex(/^\d+$/),
    frequency: z.literal('monthly'),
    data: z.array(
      z.object({
        period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
        stateid: z.literal('CO'),
        sectorid: z.literal('IND'),
        price: z.string().nullable(),
        'price-units': z.literal('cents per kilowatthour'),
      }),
    ),
  }),
});
// The API's request/params envelope can echo credentials. Only typed data is projected.
export function parseEia(config: ResearchConfig, input: ResearchQuery, text: string, page: number) {
  const q = validateQuery(config, input);
  if (q.kind !== 'eia_retail' || config.source.endpoint !== EIA_ENDPOINT)
    throw new Error('research_scope_mismatch');
  if (!Number.isInteger(page) || page < 0 || page >= config.limits.max_pages)
    throw new Error('research_page_limit');
  boundedText(config, text);
  const r = eiaEnvelope.parse(JSON.parse(text)).response;
  const total = Number(r.total),
    offset = page * config.limits.page_size;
  if (
    !Number.isSafeInteger(total) ||
    total > 12 ||
    r.data.length !== Math.min(config.limits.page_size, Math.max(0, total - offset)) ||
    (page > 0 && offset >= total)
  )
    throw new Error('eia_pagination_mismatch');
  let last = '';
  const records: ElectricityRecord[] = r.data.map((row) => {
    if (row.period < q.from || row.period > q.to || row.period <= last)
      throw new Error('eia_scope_or_order_changed');
    last = row.period;
    const value = row.price === null ? null : decimal(row.price);
    return {
      record_key: 'CO/IND/' + row.period,
      market: 'retail_average',
      country: 'US',
      region: 'CO',
      sector: 'IND',
      period: row.period,
      interval: 'month',
      interval_start: null,
      interval_end: null,
      timezone: 'not_applicable_month',
      amount_decimal: value,
      missing_reason: value === null ? 'not_reported' : null,
      currency: 'USD',
      original_unit: 'cents per kilowatthour',
      tax_status: 'unknown',
      source_date: null,
      source_published_at: null,
      source_effective_at: null,
      basis: 'official_retail_statistic',
    };
  });
  const more = offset + records.length < total,
    capped = more && page + 1 >= config.limits.max_pages;
  return ResearchPageSchema.parse({
    page,
    records,
    reported_total: total,
    next_page: more && !capped ? page + 1 : null,
    coverage: more || !total ? 'partial' : 'complete',
    reasons: !total ? ['source_empty'] : more ? [capped ? 'page_limit' : 'more_pages'] : [],
  });
}
// RFC4180 cells, bounded by the downloaded byte limit; no eval, links or HTML parsing.
function csvRows(text: string, limit: number): string[][] {
  const rows: string[][] = [];
  let row: string[] = [],
    value = '',
    quoted = false,
    afterQuote = false;
  for (let i = 0; i <= text.length; i++) {
    const c = i === text.length ? '\n' : text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        value += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
        afterQuote = true;
      } else if (i === text.length) throw new Error('csv_unclosed_quote');
      else value += c;
    } else if (c === '"' && !value && !afterQuote) quoted = true;
    else if (c === ',' || c === '\n' || c === '\r') {
      row.push(value);
      value = '';
      afterQuote = false;
      if (c !== ',') {
        if (row.some((x) => x !== '')) rows.push(row);
        row = [];
        if (c === '\r' && text[i + 1] === '\n') i++;
        if (rows.length > limit + 1) throw new Error('csv_row_limit');
      }
    } else {
      if (afterQuote || c === '"') throw new Error('csv_invalid_quote');
      value += c;
    }
  }
  return rows;
}
export function parseJepx(
  config: ResearchConfig,
  input: ResearchQuery,
  text: string,
  page: number,
) {
  const q = validateQuery(config, input);
  if (q.kind !== 'jepx_spot' || config.source.endpoint !== JEPX_ENDPOINT || page !== 0)
    throw new Error('research_scope_mismatch');
  boundedText(config, text);
  const [header, ...rows] = csvRows(text.replace(/^\uFEFF/, ''), config.limits.max_input_rows);
  // Official JS uses columns 0/1/8. Verify meaning as well as position before using it.
  const h = header?.map((v) => v.normalize('NFKC').replace(/\s/g, ''));
  if (
    !h ||
    h.length < 15 ||
    h.length > 30 ||
    h[0] !== '受渡日' ||
    h[1] !== '時刻コード' ||
    h[8] !== 'エリアプライス東京(円/kWh)'
  )
    throw new Error('jepx_header_changed');
  const records: ElectricityRecord[] = [],
    seen = new Set<number>();
  for (const row of rows) {
    if (row.length !== header.length) throw new Error('jepx_row_shape');
    const day = row[0].replaceAll('/', '-');
    if (!isoDate(day)) throw new Error('jepx_date_invalid');
    if (day !== q.delivery_date) continue;
    if (!/^(?:[1-9]|[1-3]\d|4[0-8])$/.test(row[1])) throw new Error('jepx_interval_invalid');
    const slot = Number(row[1]);
    if (seen.has(slot)) throw new Error('jepx_duplicate_interval');
    seen.add(slot);
    const start = Date.parse(day + 'T00:00:00+09:00') + (slot - 1) * 1800000;
    const value = row[8] === '' ? null : signedDecimal(row[8]);
    records.push({
      record_key: 'Tokyo/' + day + '/' + slot,
      market: 'wholesale_day_ahead',
      country: 'JP',
      region: 'Tokyo',
      sector: null,
      period: day,
      interval: '30_minutes',
      interval_start: new Date(start).toISOString(),
      interval_end: new Date(start + 1800000).toISOString(),
      timezone: 'Asia/Tokyo',
      amount_decimal: value,
      missing_reason: value === null ? 'not_reported' : null,
      currency: 'JPY',
      original_unit: 'JPY/kWh',
      tax_status: 'unknown',
      source_date: day,
      source_published_at: null,
      source_effective_at: null,
      basis: 'exchange_published_price',
    });
  }
  records.sort((a, b) => a.interval_start!.localeCompare(b.interval_start!));
  return ResearchPageSchema.parse({
    page,
    records,
    reported_total: null,
    next_page: null,
    coverage: records.length === 48 ? 'complete' : 'partial',
    reasons: records.length === 48 ? [] : records.length ? ['missing_intervals'] : ['source_empty'],
  });
}
export function parseElectricity(
  config: ResearchConfig,
  q: ResearchQuery,
  text: string,
  page: number,
) {
  return config.adapter === 'eia_retail'
    ? parseEia(config, q, text, page)
    : parseJepx(config, q, text, page);
}
