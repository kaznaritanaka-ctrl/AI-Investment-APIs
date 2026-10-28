import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { z } from 'zod';
import { DecimalString } from './schema';
import { isoDate } from './util';

export const EFFECTSTORY_URL = 'https://effectstory.com/en/data/cloud-gpu-pricing';
export const EFFECTSTORY_ATTRIBUTION =
  'Data: EffectStory, Cloud GPU Hourly Pricing (https://effectstory.com/en/data/cloud-gpu-pricing), CC BY 4.0';
export const EffectStoryMetadata = z
  .object({ dropped_count: z.number().int().min(0).max(50) })
  .strict();
export const EffectStoryRow = z
  .object({
    gpu_label: z.string().min(1).max(256),
    basis: z.string().min(1).max(512),
    checked_date: z.iso.date(),
    source_url: z.literal(EFFECTSTORY_URL),
  })
  .strict();
const Row = EffectStoryRow.extend({
  provider: z.string().min(1).max(120),
  amount_decimal: DecimalString,
}).strict();

type Node = { tag: string; value?: string; children: Node[]; attrs: Record<string, string> };
const excluded = new Set(['script', 'style', 'noscript', 'template', 'iframe']);
const text = (n: Node): string =>
  excluded.has(n.tag) ? '' : (n.value ?? n.children.map(text).join(''));
function elements(n: Node, name: string): Node[] {
  if (excluded.has(n.tag)) return [];
  return [...(n.tag === name ? [n] : []), ...n.children.flatMap((c) => elements(c, name))];
}
// Keep published spelling and decimal precision; normalize only layout whitespace.
const clean = (s: string) => s.replace(/\s+/g, ' ').trim();
export function parseEffectStory(html: string, observed: string, maxRecords = 50) {
  if (new TextEncoder().encode(html).length > 2000000) throw new Error('response_too_large');
  if (/cf-chl-|g-recaptcha|h-captcha|verify you are human|just a moment/i.test(html))
    throw new Error('effectstory_access_challenge');
  if (/<!ENTITY|<!DOCTYPE[^>]*\[/i.test(html)) throw new Error('effectstory_html_shape');
  html = html.replace(/<!doctype\s+html\s*>/gi, '');
  if (/<!doctype/i.test(html)) throw new Error('effectstory_html_shape');
  // RSC/JSON-LD are untrusted and never interpreted or retained. Raw-text script
  // contents are removed before strict structural validation of the HTML subset.
  html = html.replace(/(<(script|style)\b[^>]*>)[\s\S]*?(<\/\2\s*>)/gi, '$1$3');
  const options = {
    preserveOrder: true,
    ignoreAttributes: false,
    attributeNamePrefix: '',
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: false,
    htmlEntities: true,
    allowBooleanAttributes: true,
    unpairedTags: [
      'area',
      'base',
      'br',
      'col',
      'embed',
      'hr',
      'img',
      'input',
      'link',
      'meta',
      'param',
      'source',
      'track',
      'wbr',
    ],
  };
  if (XMLValidator.validate('<effectstory-root>' + html + '</effectstory-root>', options) !== true)
    throw new Error('effectstory_html_shape');
  type Ordered = { [key: string]: Ordered[] | string | Record<string, string> };
  let count = 0;
  const convert = (items: Ordered[], depth = 0): Node[] => {
    if (depth > 100) throw new Error('effectstory_html_shape');
    return items.flatMap((item): Node[] => {
      if (++count > 30000) throw new Error('effectstory_html_shape');
      const tag = Object.keys(item).find((key) => key !== ':@')!;
      if (tag.startsWith('?') || tag.startsWith('!')) return [];
      return [
        {
          tag,
          ...(tag === '#text' ? { value: String(item[tag]) } : {}),
          children: Array.isArray(item[tag]) ? convert(item[tag], depth + 1) : [],
          attrs: Object.fromEntries(
            Object.entries(item[':@'] ?? {}).map(([k, v]) => [k, String(v)]),
          ),
        },
      ];
    });
  };
  const doc: Node = { tag: '', attrs: {}, children: convert(new XMLParser(options).parse(html)) };
  const headers = ['Provider', 'GPU', 'Hourly (USD)', 'Basis', 'Checked'];
  const tables = elements(doc, 'table').filter((table) => {
    const first = elements(table, 'tr')[0];
    return (
      first &&
      first.children
        .filter((n) => n.tag === 'th' || n.tag === 'td')
        .map((n) => clean(text(n)))
        .join('|') === headers.join('|')
    );
  });
  if (tables.length !== 1) throw new Error('effectstory_table_shape');
  const table = tables[0];
  if (
    elements(table, 'table').length !== 1 ||
    [...elements(table, 'td'), ...elements(table, 'th')].some((n) =>
      Object.entries(n.attrs).some(([k, v]) => ['rowspan', 'colspan'].includes(k) && v !== '1'),
    )
  )
    throw new Error('effectstory_table_shape');
  const rows = elements(table, 'tr').slice(1);
  if (!rows.length || rows.length > Math.min(maxRecords, 50))
    throw new Error('effectstory_record_limit');
  const records = rows.map((row) => {
    const cells = row.children.filter((n) => n.tag === 'td');
    if (cells.length !== 5 || row.children.some((n) => !['td', '#text'].includes(n.tag)))
      throw new Error('effectstory_table_shape');
    const [provider, gpu_label, price, basis, checked_date] = cells.map((n) => clean(text(n)));
    const money = /^\$(0|[1-9]\d*)(\.\d+)?\/GPU-hr$/.exec(price);
    if (!money || price.length > 100) throw new Error('effectstory_price_shape');
    if (!isoDate(checked_date) || checked_date > observed.slice(0, 10))
      throw new Error('effectstory_checked_date');
    return Row.parse({
      provider,
      gpu_label,
      amount_decimal: money[1] + (money[2] ?? ''),
      basis,
      checked_date,
      source_url: EFFECTSTORY_URL,
    });
  });
  // No stable upstream offer IDs: the observable provider/GPU/basis tuple defines
  // a series. Duplicate tuples are ambiguous and reject the entire snapshot.
  if (
    new Set(records.map((r) => JSON.stringify([r.provider, r.gpu_label, r.basis]))).size !==
    records.length
  )
    throw new Error('effectstory_duplicate_record');
  return records;
}
