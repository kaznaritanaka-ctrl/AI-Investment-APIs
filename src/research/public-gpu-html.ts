import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { z } from 'zod';
import { GPUIdentity } from '../gpu';
import { hash, stable } from '../util';
import {
  DomesticGPUIntakeSchema,
  normalizeDomesticGPU,
  type DomesticGPUIntake,
} from './domestic-gpu';
import type { ResearchConfig } from './schema';

type Node = {
  tagName?: string;
  value?: string;
  childNodes: Node[];
  attrs: { name: string; value: string }[];
};
type Element = Node;
const children = (n: Node): Node[] => n.childNodes;
const tag = (n: Node) => n.tagName ?? '';
const clean = (s: string) => s.normalize('NFKC').replace(/\s+/g, ' ').trim();
function text(n: Node): string {
  if (['script', 'style', 'noscript', 'template', 'iframe'].includes(tag(n))) return '';
  return n.value ?? children(n).map(text).join(' ');
}
function elements(n: Node, name: string): Element[] {
  const result: Element[] = [],
    stack: Node[] = [n];
  while (stack.length) {
    const current = stack.pop()!;
    if (tag(current) === name) result.push(current as Element);
    if (!['script', 'style', 'noscript', 'template', 'iframe'].includes(tag(current)))
      stack.push(...children(current).slice().reverse());
  }
  return result;
}
function document(html: string) {
  if (new TextEncoder().encode(html).length > 1000000) throw new Error('response_too_large');
  if (/cf-chl-|g-recaptcha|h-captcha|verify you are human|just a moment/i.test(html))
    throw new Error('public_gpu_access_challenge');
  // Intentionally a strict HTML subset: no HTML5 error recovery, DTD/entity
  // declarations or implicit table closures. Unsupported live markup needs review.
  if (/<!ENTITY|<!DOCTYPE[^>]*\[/i.test(html)) throw new Error('public_gpu_table_schema_changed');
  html = html.replace(/<!doctype\s+html\s*>/gi, '');
  if (/<!doctype/i.test(html)) throw new Error('public_gpu_table_schema_changed');
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
    stopNodes: ['*.script', '*.style'],
  };
  // Validate before parsing: the XML parser alone repairs some truncated tables.
  if (XMLValidator.validate('<research-root>' + html + '</research-root>', options) !== true)
    throw new Error('public_gpu_table_schema_changed');
  type Ordered = { [key: string]: Ordered[] | string | Record<string, string> };
  let count = 0;
  const convert = (items: Ordered[], depth = 0): Node[] => {
    if (depth > 100) throw new Error('public_gpu_table_schema_changed');
    return items.flatMap((item): Node[] => {
      if (++count > 30000) throw new Error('research_page_limit');
      const name = Object.keys(item).find((k) => k !== ':@')!;
      if (name.startsWith('?') || name.startsWith('!')) return [];
      return [
        {
          ...(name === '#text' ? { value: String(item[name]) } : { tagName: name }),
          childNodes: Array.isArray(item[name]) ? convert(item[name], depth + 1) : [],
          attrs: Object.entries(item[':@'] ?? {}).map(([name, value]) => ({
            name,
            value: String(value),
          })),
        },
      ];
    });
  };
  return { childNodes: convert(new XMLParser(options).parse(html)), attrs: [] } as Node;
}
export const robotsFingerprint = (body: string) => hash(body.replace(/\r\n/g, '\n').trim());
export const termsFingerprint = (html: string) => hash(clean(text(document(html))));

export const PublicGpuRecordSchema = z
  .object({
    record_key: z.string().min(1).max(120),
    offer: DomesticGPUIntakeSchema,
    identity: GPUIdentity,
    instance_id: z.string().min(1).max(120).nullable(),
    reported_quantity: z.number().int().positive().nullable(),
    storage_gb: z
      .string()
      .regex(/^\d+(?:\.\d+)?$/)
      .nullable(),
    included_components: z.array(z.enum(['instance', 'storage', 'data_transfer'])),
    case_identity_basis: z.literal('public_content_occurrence_not_transaction').optional(),
  })
  .strict();
export type PublicGpuRecord = z.infer<typeof PublicGpuRecordSchema>;
export const PublicGpuPageSchema = z
  .object({
    page: z.literal(0),
    records: z.array(PublicGpuRecordSchema).max(48),
    reported_total: z.number().int().nonnegative(),
    next_page: z.null(),
    coverage: z.literal('complete'),
    reasons: z.array(z.string()),
    selection: z
      .object({
        method_version: z.literal('domestic-gpu-html-v2'),
        input_rows: z.number().int().nonnegative(),
        cohort_rows: z.number().int().nonnegative(),
        excluded_rows: z.number().int().nonnegative(),
        price_slots_per_row: z.union([z.literal(1), z.literal(2)]),
        cohort_models: z.array(z.string()).optional(),
        cohort_gpu_counts: z.array(z.number().int().positive()).optional(),
        excluded_by_reason: z
          .object({
            model: z.number().int().nonnegative(),
            gpu_count: z.number().int().nonnegative(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

function money(value: string): string | null {
  const s = clean(value).replace(/ /g, '');
  if (['', '-', '—', '未掲載', '要問合せ', '要問い合わせ'].includes(s)) return null;
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?円$/.test(s))
    throw new Error('public_gpu_price_schema_changed');
  return s.replace(/円|,/g, '');
}
function quantity(value: string): number | null {
  const s = clean(value).replace(/ /g, '');
  if (['', '-', '不明', '未掲載'].includes(s)) return null;
  const match = /^(\d+)枚$/.exec(s);
  if (!match || Number(match[1]) < 1 || Number(match[1]) > 10000)
    throw new Error('public_gpu_quantity_schema_changed');
  return Number(match[1]);
}
function rows(table: Element): string[][] {
  if (elements(table, 'table').length !== 1) throw new Error('public_gpu_nested_table');
  if (
    [...elements(table, 'td'), ...elements(table, 'th')].some((cell) =>
      cell.attrs.some((a) => ['rowspan', 'colspan'].includes(a.name) && a.value !== '1'),
    )
  )
    throw new Error('public_gpu_table_schema_changed');
  return elements(table, 'tr').map((row) =>
    children(row)
      .filter((c) => ['td', 'th'].includes(tag(c)))
      .map((c) => clean(text(c))),
  );
}
function base(c: ResearchConfig, observed: string, digest: string): DomesticGPUIntake {
  return {
    source_id: c.adapter === 'highreso_public' ? 'highreso' : 'rebro',
    record_key: '',
    reported_product: '',
    observation_kind: 'rental_quote',
    basis: 'provider_public_quote',
    listing_state: 'seen',
    observed_at: observed,
    source_published_at: null,
    source_period: null,
    source_period_precision: null,
    transaction_at: null,
    execution_evidence_ref: null,
    evidence_ref: c.source.source_url + '#sha256=' + digest,
    policy_version: c.source.policy.version,
    terms_version: c.terms.version,
    amount_decimal: null,
    missing_reason: 'not_reported',
    currency: 'JPY',
    unit: 'node_hour',
    sale_unit: 'instance',
    gpu_count: null,
    condition: 'unknown',
    country: null,
    region: null,
    region_evidence_ref: null,
    contract: 'unknown',
    dedicated_or_shared: 'unknown',
    interruptible: null,
    minimum_term: null,
    tax_status: 'unknown',
    availability: 'unknown',
    availability_evidence_ref: null,
    price_scope: 'public',
    synthetic: false,
  };
}
export async function parsePublicGpu(
  c: ResearchConfig,
  html: string,
  observed: string,
  synthetic: boolean,
) {
  if (c.scope.kind !== 'highreso_public' && c.scope.kind !== 'rebro_public')
    throw new Error('research_scope_mismatch');
  const doc = document(html),
    digest = await hash(html),
    records: PublicGpuRecord[] = [];
  const selected = (product: string) =>
    c.scope.kind !== 'eia_retail' &&
    c.scope.kind !== 'jepx_spot' &&
    c.scope.models.some((model) => new RegExp('\\b' + model + '\\b', 'i').test(product));
  const make = (
    offer: DomesticGPUIntake,
    extra: Pick<
      PublicGpuRecord,
      'instance_id' | 'reported_quantity' | 'storage_gb' | 'included_components'
    >,
  ) => {
    const normalized = normalizeDomesticGPU({ ...offer, synthetic });
    records.push(
      PublicGpuRecordSchema.parse({
        record_key: offer.record_key,
        offer: { ...offer, synthetic },
        identity: normalized.identity,
        ...extra,
      }),
    );
    if (records.length > c.limits.page_size) throw new Error('research_page_limit');
  };
  let matchedTables = 0,
    inputRows = 0,
    cohortRows = 0,
    excludedModel = 0,
    excludedCount = 0;
  const v2 = c.method_version === 'domestic-gpu-html-v2';
  if (c.adapter === 'highreso_public') {
    // Traverse document order, associating each table with only its preceding GPU spec block.
    const ordered: Node[] = [],
      walk = (n: Node) => {
        if (['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'table'].includes(tag(n))) {
          ordered.push(n);
          return;
        }
        if (!['script', 'style', 'template', 'noscript', 'iframe'].includes(tag(n)))
          children(n).forEach(walk);
      };
    walk(doc);
    let product: string | null = null,
      count: number | null = null,
      anchorLevel: number | null = null,
      headingLevel = 0,
      headingModel: string | null = null;
    const modelToken = (s: string) =>
      /\b(?:[ABHV]\d{2,3}|L\d{1,2}S?|RTX\s*\d{3,4})\b/i.exec(s)?.[0].toUpperCase() ?? null;
    // Only recognized subordinate headings keep the current GPU block. A peer,
    // a new GPU (even nested), or an unknown subsection must not inherit its SKU.
    const subordinate =
      /^(?:GPU仕様|仕様|ストレージサイズ|ストレージ|料金表?|インスタンス|OS|Linux|Ubuntu|Windows)(?:\s|$|[:：(（])/i;
    const pageText = clean(text(doc));
    const included = /料金には消費税、インスタンス、ストレージ、データ転送料が含まれます/.test(
      pageText.replace(/ /g, ''),
    );
    for (const n of ordered) {
      if (/^h[1-6]$/.test(tag(n))) {
        const label = clean(text(n)),
          level = Number(tag(n).slice(1)),
          model = modelToken(label);
        headingLevel = level;
        if (model || anchorLevel === null || level <= anchorLevel || !subordinate.test(label)) {
          product = null;
          count = null;
          anchorLevel = model ? level : null;
          headingModel = model;
        }
      }
      if (tag(n) === 'p') {
        const spec = /GPU[:：]\s*([^:：]+?)\s*[x×]\s*(\d+)\s*枚/i.exec(clean(text(n)));
        if (spec) {
          if (headingModel && modelToken(spec[1]) !== headingModel)
            throw new Error('public_gpu_table_schema_changed');
          product = spec[1].trim();
          count = Number(spec[2]);
          if (!headingLevel || !Number.isSafeInteger(count) || count < 1 || count > 10000)
            throw new Error('public_gpu_table_schema_changed');
          anchorLevel ??= headingLevel;
        }
      }
      if (tag(n) !== 'table') continue;
      const table = rows(n as Element),
        header = table[0]?.map((s) => s.replace(/ /g, ''));
      if (header?.[0] !== 'インスタンス') {
        if (product) throw new Error('public_gpu_table_schema_changed');
        continue;
      }
      matchedTables++;
      if (
        !product ||
        !header[1]?.match(/^従量課金\[1h・台\]$/) ||
        !header[2]?.match(/^月額課金\[月・台\]$/) ||
        header[3] !== 'ストレージ'
      )
        throw new Error('public_gpu_table_schema_changed');
      for (const cells of table.slice(1)) {
        inputRows++;
        if (inputRows > c.limits.max_input_rows) throw new Error('research_page_limit');
        if (cells.length !== header.length || !/^[a-z0-9][a-z0-9_-]+$/.test(cells[0]))
          throw new Error('public_gpu_table_schema_changed');
        if (!selected(product)) {
          excludedModel++;
          continue;
        }
        if (
          c.scope.kind === 'highreso_public' &&
          c.scope.gpu_counts &&
          (count === null || !c.scope.gpu_counts.includes(count))
        ) {
          excludedCount++;
          continue;
        }
        cohortRows++;
        const storage = /^(\d+(?:\.\d+)?)GB$/i.exec(cells[3].replace(/ /g, ''));
        if (!storage && cells[3] !== '-' && cells[3] !== '')
          throw new Error('public_gpu_storage_schema_changed');
        for (const [column, unit, contract] of [
          [1, 'node_hour', 'on_demand'],
          [2, 'month', 'monthly'],
        ] as const) {
          const amount = money(cells[column]);
          make(
            {
              ...base(c, observed, digest),
              record_key: cells[0] + ':' + unit,
              reported_product: product,
              gpu_count: count,
              amount_decimal: amount,
              missing_reason: amount === null ? 'not_reported' : null,
              unit,
              contract,
              tax_status: included ? 'included' : 'unknown',
            },
            {
              instance_id: cells[0],
              reported_quantity: null,
              storage_gb: storage?.[1] ?? null,
              included_components: included ? ['instance', 'storage', 'data_transfer'] : [],
            },
          );
        }
      }
    }
  } else {
    // Execution basis comes only from the visible, explicitly labelled results section.
    let section = '',
      execution = false;
    const walk = (n: Node) => {
      if (/^h[1-6]$/.test(tag(n))) {
        section = clean(text(n));
        execution = tag(n) === 'h2' && section === '買取実績';
      }
      if (tag(n) === 'table') {
        const table = rows(n as Element),
          header = table[0];
        if (header?.join('|') !== '買取時期|商品|数量|買取単価|お取引') return;
        if (!execution) throw new Error('public_gpu_execution_basis_unconfirmed');
        matchedTables++;
        for (const cells of table.slice(1)) {
          inputRows++;
          if (inputRows > c.limits.max_input_rows) throw new Error('research_page_limit');
          if (cells.length !== 5) throw new Error('public_gpu_table_schema_changed');
          if (!selected(cells[1])) {
            excludedModel++;
            continue;
          }
          cohortRows++;
          const month = /^(\d{4})年(\d{1,2})月$/.exec(cells[0]);
          if (!month || +month[2] < 1 || +month[2] > 12)
            throw new Error('public_gpu_period_schema_changed');
          const period = month[1] + '-' + month[2].padStart(2, '0');
          const key = publicCaseKey(period, cells[1]);
          const amount = money(cells[3]);
          make(
            {
              ...base(c, observed, digest),
              record_key: key,
              reported_product: cells[1],
              observation_kind: 'buy_execution_report',
              basis: 'selected_public_case',
              unit: 'gpu',
              sale_unit: 'single_gpu',
              gpu_count: 1,
              source_period: period,
              source_period_precision: 'month',
              execution_evidence_ref: c.source.source_url + '#買取実績',
              amount_decimal: amount,
              missing_reason: amount === null ? 'not_reported' : null,
            },
            {
              instance_id: null,
              reported_quantity: quantity(cells[2]),
              storage_gb: null,
              included_components: [],
            },
          );
          // cells[4] (counterparty category) is intentionally discarded.
        }
        return;
      }
      if (!['script', 'style', 'template', 'noscript', 'iframe'].includes(tag(n)))
        children(n).forEach(walk);
    };
    walk(doc);
    if (v2) {
      // No stable case ID is supplied. Preserve the public multiset, including
      // identical rows; never infer transaction identity from order or price.
      const occurrences = new Map<string, number>();
      for (const record of records) {
        const content = await hash(
          stable([
            record.offer.source_period,
            clean(record.offer.reported_product).toLowerCase(),
            record.reported_quantity,
            record.offer.amount_decimal,
          ]),
        );
        const occurrence = (occurrences.get(content) ?? 0) + 1;
        occurrences.set(content, occurrence);
        record.record_key = 'public-case:' + content + ':' + occurrence;
        record.offer.record_key = record.record_key;
        record.case_identity_basis = 'public_content_occurrence_not_transaction';
      }
    }
  }
  if (!matchedTables || (c.adapter === 'rebro_public' && matchedTables !== 1))
    throw new Error('public_gpu_table_missing');
  if (inputRows > c.limits.max_input_rows || records.length > c.limits.page_size)
    throw new Error('research_page_limit');
  if (new Set(records.map((r) => r.record_key)).size !== records.length)
    throw new Error('research_duplicate_record');
  return PublicGpuPageSchema.parse({
    page: 0,
    records,
    reported_total: records.length,
    next_page: null,
    coverage: 'complete',
    reasons: records.some((r) => r.offer.amount_decimal === null) ? ['price_not_reported'] : [],
    ...(v2
      ? {
          selection: {
            method_version: 'domestic-gpu-html-v2',
            input_rows: inputRows,
            cohort_rows: cohortRows,
            excluded_rows: inputRows - cohortRows,
            price_slots_per_row: c.adapter === 'highreso_public' ? 2 : 1,
            cohort_models: 'models' in c.scope ? c.scope.models : [],
            ...('gpu_counts' in c.scope ? { cohort_gpu_counts: c.scope.gpu_counts } : {}),
            excluded_by_reason: { model: excludedModel, gpu_count: excludedCount },
          },
        }
      : {}),
  });
}
function publicCaseKey(period: string, product: string) {
  // Product/month is the observable public case key, never an invented transaction ID.
  return period + ':' + clean(product).toLowerCase();
}
export function gpuRecordFingerprint(record: PublicGpuRecord) {
  const { observed_at, evidence_ref, policy_version, terms_version, synthetic, ...content } =
    record.offer;
  void observed_at;
  void evidence_ref;
  void policy_version;
  void terms_version;
  void synthetic;
  return hash(stable({ ...record, offer: content }));
}
