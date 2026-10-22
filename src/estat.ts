import type { CollectorEnv, Source } from './schema';
import { ESTAT_API } from './estat-schema';
import { canCollect } from './policy';
import { fetchBounded, type NetworkOptions } from './network';
import { safeAttemptCode } from './telemetry';
import { hash, isoDate, stable } from './util';

type Obj = Record<string, unknown>;
const object = (value: unknown): Obj => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('estat_schema_invalid');
  return value as Obj;
};
const list = (value: unknown): unknown[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];
const label = (value: unknown): string =>
  typeof value === 'string'
    ? value
    : value && typeof value === 'object'
      ? label(object(value).$)
      : '';
const text = (value: unknown): string => {
  if (typeof value !== 'string' || !value || value.length > 1000 || /[\u0000-\u001f]/.test(value))
    throw new Error('estat_schema_invalid');
  return value;
};
const id = (value: unknown): string => {
  const v = text(value);
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(v)) throw new Error('estat_schema_invalid');
  return v;
};

// Used before parsing any remote strings, not just when formatting diagnostic URLs.
export function maskEstat(value: string, secret?: string): string {
  let masked = value;
  if (secret)
    for (const token of new Set([
      secret,
      encodeURIComponent(secret),
      encodeURI(secret),
      new URLSearchParams({ v: secret }).toString().slice(2),
    ])) {
      masked = masked.split(token).join('[REDACTED]');
    }
  return masked.replace(
    /(app(?:%49|i)d(?:%3[dD]|["']?\s*[:=]\s*["']?))[^&\s"'<>\\]*/gi,
    '$1[REDACTED]',
  );
}
function sanitized(value: unknown, secret: string): unknown {
  if (typeof value === 'string') return maskEstat(value, secret);
  if (Array.isArray(value)) return value.map((v) => sanitized(v, secret));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [maskEstat(k, secret), sanitized(v, secret)]),
    );
  return value;
}
export function estatDue(source: Source, scheduled: string): boolean {
  const at = new Date(scheduled),
    e = source.estat;
  return (
    !!e &&
    Number.isFinite(at.getTime()) &&
    at.getUTCDate() === e.day_utc &&
    e.months_utc.includes(at.getUTCMonth() + 1)
  );
}
export async function estatConfigurationHash(s: Source): Promise<string> {
  return hash(
    stable({
      policy: s.policy,
      adapter: s.adapter,
      endpoint: s.endpoint,
      selection: s.selection,
      ...(s.estat ? { estat: s.estat } : {}),
    }),
  );
}
export type EstatTable = {
  table_id: string;
  title: string;
  group: string;
  year: number;
  updated_at: string | null;
};
export type EstatRow = {
  item_code: string;
  item_name_ja: string;
  measure: string;
  unit_raw: string;
  base_year: number | null;
  period: string;
  value_decimal: string | null;
  value_flag: string | null;
};
export type EstatPage = {
  table: EstatTable;
  schema_signature: string;
  rows: EstatRow[];
  next: number | null;
};
export type EstatResponse = {
  body: unknown;
  response_sha256: string;
  fetched_at: string;
  request_url: string;
};
export async function estatRequest(
  s: Source,
  env: CollectorEnv,
  method: 'getStatsList' | 'getStatsData',
  params: Record<string, string>,
  opt: NetworkOptions = {},
): Promise<EstatResponse> {
  const now = opt.now ?? (() => new Date().toISOString());
  if (env.ESTAT_ENABLED !== 'true') throw new Error('estat_disabled');
  if (!env.ESTAT_APP_ID?.trim()) throw new Error('estat_app_id_missing');
  if (!canCollect(s, now()) || !s.estat) throw new Error('policy_blocked');
  if (s.adapter !== 'estat' || s.endpoint !== ESTAT_API) throw new Error('endpoint_not_allowed');
  const allowed =
    method === 'getStatsList'
      ? ['statsCode', 'searchWord', 'limit', 'startPosition']
      : ['statsDataId', 'limit', 'startPosition', 'metaGetFlg', 'cdCat01'];
  if (Object.keys(params).some((k) => !allowed.includes(k)))
    throw new Error('estat_request_invalid');
  const url = new URL(method, ESTAT_API);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  url.searchParams.set('appId', env.ESTAT_APP_ID);
  try {
    const r = await fetchBounded(
      s,
      { url: url.href, method: 'GET', headers: {} },
      {
        ...opt,
        validators: undefined,
        onBody: undefined,
        onAttempt: opt.onAttempt
          ? (a) => opt.onAttempt!({ ...a, code: safeAttemptCode(a.code, a.status) })
          : undefined,
      },
    );
    // Response headers and response-provided URLs are never retained or followed.
    if (r.status !== 200) throw new Error('estat_transport_failed');
    const body = sanitized(JSON.parse(r.text), env.ESTAT_APP_ID);
    const result = object(
      object(body)[method === 'getStatsList' ? 'GET_STATS_LIST' : 'GET_STATS_DATA'],
    );
    if (String(object(result.RESULT).STATUS) !== '0') throw new Error('estat_api_failed');
    return {
      body,
      response_sha256: await hash(r.text),
      fetched_at: r.observed_at,
      request_url: maskEstat(url.href, env.ESTAT_APP_ID),
    };
  } catch {
    // Fetch/JSON/API errors may echo credentials. Never let them leave this boundary.
    throw new Error('estat_request_failed');
  }
}
function nextKey(value: unknown, start: number, count: number): number | null {
  const r = object(value);
  const next = r.NEXT_KEY;
  if (next === undefined || next === null || String(next) === '' || String(next) === '0') {
    if (r.TOTAL_NUMBER !== undefined && Number(r.TOTAL_NUMBER) > start - 1 + count)
      throw new Error('estat_pagination_incomplete');
    return null;
  }
  if (
    !/^\d+$/.test(String(next)) ||
    !Number.isSafeInteger(Number(next)) ||
    Number(next) !== start + count ||
    count === 0
  )
    throw new Error('estat_pagination_invalid');
  return Number(next);
}
export function parseEstatList(s: Source, body: unknown, start = 1) {
  const e = s.estat!;
  const root = object(object(body).GET_STATS_LIST),
    data = object(root.DATALIST_INF);
  const rows = list(data.TABLE_INF);
  if (rows.length > Math.min(e.page_size, 100)) throw new Error('estat_page_too_large');
  const tables: EstatTable[] = [];
  for (const entry of rows) {
    const row = object(entry);
    if (String(object(row.STAT_NAME)['@code']) !== e.stats_code) continue;
    const title = text(label(row.TITLE));
    const heading = [title, label(row.STATISTICS_NAME), label(row.CYCLE)].join(' ');
    if (e.release_kind === 'annual' && (!heading.includes('年報') || !title.includes('時系列表')))
      continue;
    if (
      e.release_kind === 'iip_monthly' &&
      (!heading.includes('品目別') || !heading.includes('季節調整済') || !heading.includes('月次'))
    )
      continue;
    const group = e.table_groups.find(
      (g) => title.includes(g) && (g !== '在庫' || !title.includes('在庫率')),
    );
    if (!group) continue;
    const rawYear =
      label(row.SURVEY_DATE).match(/^(\d{4})/)?.[1] ?? heading.match(/(20\d{2})年/)?.[1];
    if (!rawYear) throw new Error('estat_survey_year_missing');
    const tableId = text(row['@id']);
    if (!/^\d{10}$/.test(tableId)) throw new Error('estat_table_id_invalid');
    const update = label(row.UPDATED_DATE);
    tables.push({
      table_id: tableId,
      title,
      group,
      year: Number(rawYear),
      updated_at: isoDate(update.slice(0, 10)) ? update : null,
    });
  }
  return {
    tables,
    next: nextKey(
      data.RESULT_INF ?? { NEXT_KEY: data.NEXT_KEY, TOTAL_NUMBER: data.NUMBER },
      start,
      rows.length,
    ),
  };
}
export function newestEstatTables(s: Source, tables: EstatTable[]): EstatTable[] {
  return s.estat!.table_groups.map((group) => {
    const selected = tables
      .filter((t) => t.group === group)
      .sort((a, b) => b.year - a.year || (b.updated_at ?? '').localeCompare(a.updated_at ?? ''));
    if (!selected.length) throw new Error('estat_selected_table_missing');
    if (
      selected[1] &&
      selected[0].year === selected[1].year &&
      selected[0].updated_at === selected[1].updated_at &&
      selected[0].table_id !== selected[1].table_id
    )
      throw new Error('estat_table_ambiguous');
    return selected[0];
  });
}
const measures: Record<string, string> = {
  生産数量: 'production_qty',
  生産金額: 'production_value',
  販売数量: 'sales_qty',
  販売金額: 'sales_value',
  出荷数量: 'shipments_qty',
  出荷金額: 'shipments_value',
  月末在庫数量: 'inventory',
  在庫数量: 'inventory',
  在庫: 'inventory',
  在庫指数: 'inventory_index_sa',
  在庫率指数: 'inventory_ratio_index_sa',
};
function periodOf(name: string): string {
  const compact = name.match(/^(\d{4})(\d{2})$/);
  const m = compact ?? name.match(/^(\d{4})年(?:(\d{1,2})月|(度))?$/);
  if (!m || (m[2] && (Number(m[2]) < 1 || Number(m[2]) > 12)))
    throw new Error('estat_period_invalid');
  return m[2] ? m[1] + '-' + m[2].padStart(2, '0') : m[1] + (m[3] ? 'FY' : '');
}
// These are coefficients, not observations. Do not infer a period from their code.
const weightTime = (name: unknown) => /(?:ウエイト|ウェイト)$/.test(label(name).trim());
export async function parseEstatData(
  s: Source,
  table: EstatTable,
  body: unknown,
  start = 1,
): Promise<EstatPage> {
  const data = object(object(object(body).GET_STATS_DATA).STATISTICAL_DATA);
  const info = object(data.TABLE_INF);
  if (
    String(info['@id']) !== table.table_id ||
    String(object(info.STAT_NAME)['@code']) !== s.estat!.stats_code
  )
    throw new Error('estat_table_mismatch');
  const dimensions = list(object(data.CLASS_INF).CLASS_OBJ).map(object);
  if (new Set(dimensions.map((d) => id(d['@id']))).size !== dimensions.length)
    throw new Error('estat_dimensions_unknown');
  for (const d of dimensions) {
    const codes = list(d.CLASS).map((c) => id(object(c)['@code']));
    if (new Set(codes).size !== codes.length) throw new Error('estat_classification_unknown');
  }
  const item = dimensions.filter((d) =>
    /^(品目|品目別|品目分類)(_\d{4})?$/.test(label(d['@name'])),
  );
  const time = dimensions.filter((d) => d['@id'] === 'time');
  const metric = dimensions.filter((d) => /^(表章項目|データ項目)$/.test(label(d['@name'])));
  const impliedMeasure = s.estat!.implied_measures?.[table.group];
  if (
    item.length !== 1 ||
    time.length !== 1 ||
    metric.length > 1 ||
    (metric.length === 0 && !impliedMeasure)
  )
    throw new Error('estat_dimensions_unknown');
  // Preserve the existing signature contract: exclude the entire time dimension,
  // including weights and rolling periods; sort remaining dimension IDs and codes.
  const signatures = dimensions
    .filter((d) => d['@id'] !== 'time')
    .map((d) => ({
      id: id(d['@id']),
      codes: list(d.CLASS)
        .map((c) => id(object(c)['@code']))
        .sort(),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const schema_signature = await hash(stable(signatures));
  const values = list(object(data.DATA_INF).VALUE);
  if (values.length > s.estat!.page_size) throw new Error('estat_page_too_large');
  const classifications = new Map(
    dimensions.map((d) => [
      id(d['@id']),
      new Map(
        list(d.CLASS).map((c) => {
          const cls = object(c);
          return [id(cls['@code']), cls] as const;
        }),
      ),
    ]),
  );
  const rows: EstatRow[] = [];
  const seen = new Set<string>();
  for (const entry of values) {
    const v = object(entry),
      selected = new Map<string, Obj>();
    for (const d of dimensions) {
      const dimensionId = id(d['@id']);
      const cls = classifications.get(dimensionId)!.get(String(v['@' + dimensionId]));
      if (!cls) throw new Error('estat_classification_unknown');
      if (![item[0], time[0], metric[0]].includes(d) && list(d.CLASS).length !== 1)
        throw new Error('estat_dimensions_unknown');
      selected.set(dimensionId, cls);
    }
    if (
      Object.keys(v).some(
        (k) =>
          k.startsWith('@') && !['@unit', ...dimensions.map((d) => '@' + d['@id'])].includes(k),
      )
    )
      throw new Error('estat_dimensions_unknown');
    // Exclude before parsing units/values/periods; weights need not be valid observations.
    if (weightTime(selected.get('time')!['@name'])) continue;
    const it = selected.get(String(item[0]['@id']))!,
      mt = metric[0] ? selected.get(String(metric[0]['@id']))! : undefined;
    let measure = mt ? measures[label(mt['@name'])] : impliedMeasure;
    if (mt && s.estat!.release_kind === 'iip_monthly') {
      const expected = table.group === '在庫率' ? 'inventory_ratio_index_sa' : 'inventory_index_sa';
      if (!['指数', '季節調整済指数', table.group + '指数'].includes(label(mt['@name'])))
        throw new Error('estat_measure_unknown');
      measure = expected;
    }
    if (!measure) throw new Error('estat_measure_unknown');
    const raw = text(v.$),
      unit = text(v['@unit'] ?? mt?.['@unit']);
    const suppression = ['X', 'x', '-', '…', '...', '***', '秘匿'].includes(raw);
    const value = suppression ? null : estatDecimal(raw);
    const row: EstatRow = {
      item_code: id(it['@code']),
      item_name_ja: text(it['@name']),
      measure,
      unit_raw: unit,
      base_year: null,
      period: periodOf(text(selected.get('time')!['@name'])),
      value_decimal: value,
      value_flag: suppression ? raw : null,
    };
    if (s.estat!.release_kind === 'iip_monthly') {
      const year = (label(info.STATISTICS_NAME) + ' ' + table.title).match(/(\d{4})年基準/)?.[1];
      if (!year) throw new Error('estat_base_year_unknown');
      row.base_year = Number(year);
    }
    const key = stable([row.item_code, row.measure, row.unit_raw, row.period]);
    if (seen.has(key)) throw new Error('estat_duplicate_value');
    seen.add(key);
    rows.push(row);
  }
  // Pagination always consumes the raw API count, including excluded weights.
  return { table, schema_signature, rows, next: nextKey(data.RESULT_INF, start, values.length) };
}

// Statistics may be signed. Keep the source scale; never round through a JS number.
export function estatDecimal(raw: string): string {
  const value = /^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(raw) ? raw.replaceAll(',', '') : raw;
  if (value.length > 100 || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value))
    throw new Error('estat_decimal_invalid');
  return value;
}
