import { describe, expect, it } from 'vitest';
import { EstatConfigSchema } from '../src/estat-schema';
import {
  estatConfigurationHash,
  parseEstatData,
  parseEstatList,
  type EstatTable,
} from '../src/estat';
import { sources } from '../src/sources';
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';

// Constructed metadata/values only; never a captured e-Stat response.
function fixture(group = '在庫') {
  const source = structuredClone(sources.find((s) => s.source_id === 'estat_meti_iip')!);
  const table: EstatTable = {
    table_id: '9999999995',
    title: `品目別季節調整済指数【月次】 ${group}（2020＝100.0）`,
    group,
    year: 2025,
    updated_at: null,
  };
  const item = {
    '@id': 'cat01',
    '@name': '品目別_2020',
    CLASS: [{ '@code': '0076000', '@name': '1106103010 合成変圧器' }],
  };
  const time = {
    '@id': 'time',
    '@name': '統計項目A_2020_Match',
    CLASS: [
      { '@code': '0100300', '@name': '在庫ウエイト' },
      { '@code': 't1', '@name': '201801' },
      { '@code': 't2', '@name': '2025年2月' },
    ],
  };
  const data = {
    TABLE_INF: { '@id': table.table_id, STAT_NAME: { '@code': '00550300' } },
    CLASS_INF: { CLASS_OBJ: [item, time] },
    DATA_INF: {
      VALUE: time.CLASS.map(
        (t, i): { '@cat01': string; '@time': string; '@unit'?: string; $: string } => ({
          '@cat01': '0076000',
          '@time': t['@code'],
          $: i === 0 ? 'not-a-period-or-value' : '98.700',
        }),
      ),
    },
    RESULT_INF: { TOTAL_NUMBER: 3, NEXT_KEY: 0 },
  };
  return { source, table, item, time, data, body: { GET_STATS_DATA: { STATISTICAL_DATA: data } } };
}

describe('e-Stat verified shape support (synthetic, offline)', () => {
  it.each(['品目', '品目別', '品目分類', '品目_2020', '品目別_2020', '品目分類_2020'])(
    'accepts item dimension %s with an explicit implied measure',
    async (name) => {
      const f = fixture();
      f.item['@name'] = name;
      const page = await parseEstatData(f.source, f.table, f.body);
      expect(page.rows).toHaveLength(2);
      expect(page.rows[0]).toMatchObject({
        item_code: '0076000',
        item_name_ja: '1106103010 合成変圧器',
        period: '2018-01',
        measure: 'inventory_index_sa',
        value_decimal: '98.700',
        base_year: 2020,
        unit_raw: '2020=100',
      });
    },
  );
  it.each(['2020年基準 品目別季節調整済【月次】在庫', '品目別季節調整済【月次】在庫（2020=100）'])(
    'derives the omitted index unit from %s',
    async (title) => {
      const f = fixture();
      f.table.title = title;
      expect((await parseEstatData(f.source, f.table, f.body)).rows[0]).toMatchObject({
        unit_raw: '2020=100',
        base_year: 2020,
      });
    },
  );
  it('uses the statistical metadata base year and preserves explicit VALUE and class units', async () => {
    const f = fixture();
    f.table.title = '品目別季節調整済【月次】在庫';
    Object.assign(f.data.TABLE_INF, { STATISTICS_NAME: '鉱工業指数 2020年基準時系列データ' });
    Object.assign(f.item.CLASS[0], { '@unit': 'class-index' });
    expect((await parseEstatData(f.source, f.table, f.body)).rows[0].unit_raw).toBe('class-index');
    f.data.DATA_INF.VALUE[1]['@unit'] = 'value-index';
    expect((await parseEstatData(f.source, f.table, f.body)).rows[0].unit_raw).toBe('value-index');
  });
  it.each([
    '品目別季節調整済【月次】在庫',
    '在庫（2020＝200.0）',
    '2020年基準 在庫（2015＝100.0）',
  ])('rejects an absent or inconsistent base year: %s', async (title) => {
    const f = fixture();
    f.table.title = title;
    await expect(parseEstatData(f.source, f.table, f.body)).rejects.toThrow(
      'estat_base_year_unknown',
    );
  });
  it('accepts six selected IIP classes with observations for only one item and no units', async () => {
    const f = fixture();
    f.item.CLASS = f.source.estat!.item_codes!.map((code) => ({
      '@code': code,
      '@name': `合成品目 ${code}`,
      '@level': '1',
    }));
    f.time.CLASS = [
      { '@code': '0100300', '@name': '在庫ウエイト' },
      ...Array.from({ length: 99 }, (_, i) => ({
        '@code': String(500100 + i * 200).padStart(7, '0'),
        '@name': `${2018 + Math.floor(i / 12)}${String((i % 12) + 1).padStart(2, '0')}`,
      })),
    ];
    f.data.DATA_INF.VALUE = [
      ...f.item.CLASS.map((c) => ({
        '@cat01': c['@code'],
        '@time': '0100300',
        $: c['@code'] === '0145000' ? '9.0' : '0',
      })),
      ...f.time.CLASS.slice(1).map((t) => ({
        '@cat01': '0145000',
        '@time': t['@code'],
        $: '98.700',
      })),
    ];
    f.data.RESULT_INF.TOTAL_NUMBER = 105;
    const page = await parseEstatData(f.source, f.table, f.body);
    expect(page.rows).toHaveLength(99);
    expect(page.next).toBeNull();
    expect(new Set(page.rows.map((r) => r.item_code))).toEqual(new Set(['0145000']));
    expect(page.rows.every((r) => r.unit_raw === '2020=100')).toBe(true);
  });
  it.each(['品目別_20', '品目別_20200', '別品目_2020'])(
    'rejects unrecognized item dimension %s',
    async (name) => {
      const f = fixture();
      f.item['@name'] = name;
      await expect(parseEstatData(f.source, f.table, f.body)).rejects.toThrow(
        'estat_dimensions_unknown',
      );
    },
  );
  it('requires the configured implied measure for the exact table group', async () => {
    const f = fixture('在庫率');
    expect((await parseEstatData(f.source, f.table, f.body)).rows[0].measure).toBe(
      'inventory_ratio_index_sa',
    );
    delete f.source.estat!.implied_measures!['在庫率'];
    await expect(parseEstatData(f.source, f.table, f.body)).rejects.toThrow(
      'estat_dimensions_unknown',
    );
    delete f.source.estat!.implied_measures;
    await expect(parseEstatData(f.source, f.table, f.body)).rejects.toThrow(
      'estat_dimensions_unknown',
    );
  });
  it('uses an explicit measure dimension when present and still rejects unknown measures', async () => {
    const f = fixture();
    f.source.estat!.implied_measures = { 在庫: 'inventory' };
    const metric = {
      '@id': 'cat02',
      '@name': '表章項目',
      CLASS: [{ '@code': 'index', '@name': '季節調整済指数' }],
    };
    f.data.CLASS_INF.CLASS_OBJ.push(metric);
    for (const value of f.data.DATA_INF.VALUE) Object.assign(value, { '@cat02': 'index' });
    expect((await parseEstatData(f.source, f.table, f.body)).rows[0].measure).toBe(
      'inventory_index_sa',
    );
    metric.CLASS[0]['@name'] = '未審査の指標';
    await expect(parseEstatData(f.source, f.table, f.body)).rejects.toThrow(
      'estat_measure_unknown',
    );
  });
  it.each([
    ['201801', '2018-01'],
    ['202512', '2025-12'],
    ['2025年1月', '2025-01'],
    ['2025年', '2025'],
    ['2025年度', '2025FY'],
  ])('parses period name %s as %s', async (name, period) => {
    const f = fixture();
    f.time.CLASS[1]['@name'] = name;
    expect((await parseEstatData(f.source, f.table, f.body)).rows[0].period).toBe(period);
  });
  it.each(['201800', '201813', '20181', '不明な期間'])(
    'rejects invalid period %s instead of silently excluding it',
    async (name) => {
      const f = fixture();
      f.time.CLASS[1]['@name'] = name;
      await expect(parseEstatData(f.source, f.table, f.body)).rejects.toThrow(
        'estat_period_invalid',
      );
    },
  );
  it('excludes weight rows and all time metadata from signatures, retaining raw pagination counts', async () => {
    const f = fixture();
    const baseline = await parseEstatData(f.source, f.table, f.body);
    f.data.RESULT_INF = { TOTAL_NUMBER: 6, NEXT_KEY: 4 };
    const page = await parseEstatData(f.source, f.table, f.body);
    expect(page.rows).toHaveLength(2);
    expect(page.next).toBe(4); // Three API rows consumed, although only two are observations.
    f.time.CLASS[0] = { '@code': 'newWeight', '@name': '在庫率ウェイト' };
    f.data.DATA_INF.VALUE[0]['@time'] = 'newWeight';
    f.time.CLASS.push({ '@code': 'anotherWeight', '@name': ' 生産ウエイト ' });
    f.data.DATA_INF.VALUE.push({
      '@cat01': '0076000',
      '@time': 'anotherWeight',
      '@unit': 'bad-unit',
      $: 'bad-value',
    });
    f.data.RESULT_INF = { TOTAL_NUMBER: 4, NEXT_KEY: 0 };
    const changed = await parseEstatData(f.source, f.table, f.body);
    expect(changed.rows).toEqual(baseline.rows);
    expect(changed.schema_signature).toBe(baseline.schema_signature);
    f.time.CLASS.reverse();
    f.time.CLASS.push({ '@code': 'future', '@name': '202701' });
    expect((await parseEstatData(f.source, f.table, f.body)).schema_signature).toBe(
      baseline.schema_signature,
    );
    f.time.CLASS = f.time.CLASS.filter((t) => !/ウ[エェ]イト$/.test(t['@name'].trim()));
    f.data.DATA_INF.VALUE = f.data.DATA_INF.VALUE.filter((v) => v['@time'].startsWith('t'));
    f.data.RESULT_INF.TOTAL_NUMBER = f.data.DATA_INF.VALUE.length;
    expect((await parseEstatData(f.source, f.table, f.body)).schema_signature).toBe(
      baseline.schema_signature,
    );
    f.item.CLASS.push({ '@code': '0083000', '@name': '別の合成品目' });
    expect((await parseEstatData(f.source, f.table, f.body)).schema_signature).not.toBe(
      baseline.schema_signature,
    );
  });
  it('allows an all-weight page to advance without manufacturing observations', async () => {
    const f = fixture();
    f.data.DATA_INF.VALUE = f.data.DATA_INF.VALUE.slice(0, 1);
    f.data.RESULT_INF = { TOTAL_NUMBER: 3, NEXT_KEY: 2 };
    expect(await parseEstatData(f.source, f.table, f.body)).toMatchObject({ rows: [], next: 2 });
  });
  it('validates item-code bounds, implied measures, and both search-word representations', () => {
    const config = fixture().source.estat!;
    expect(EstatConfigSchema.safeParse(config).success).toBe(true);
    expect(
      EstatConfigSchema.safeParse({ ...config, item_codes: ['0', '123456789012'] }).success,
    ).toBe(true);
    expect(
      EstatConfigSchema.safeParse({ ...config, item_codes: Array(50).fill('1') }).success,
    ).toBe(true);
    for (const item_codes of [
      [],
      Array(51).fill('1'),
      ['1234567890123'],
      ['abc'],
      ['1,2'],
      [76000],
      ['-1'],
      [' 1'],
    ])
      expect(EstatConfigSchema.safeParse({ ...config, item_codes }).success).toBe(false);
    for (const implied_measures of [{ 在庫: 'unknown' }, { 未知のグループ: 'inventory' }])
      expect(EstatConfigSchema.safeParse({ ...config, implied_measures }).success).toBe(false);
    expect(
      EstatConfigSchema.safeParse({
        ...config,
        search_words: { 在庫: '品目別 在庫', 在庫率: '在庫率' },
      }).success,
    ).toBe(true);
    for (const search_words of [
      [],
      ['在庫'],
      ['在庫', ''],
      { 在庫: '在庫' },
      { 在庫: '在庫', 別: '在庫率' },
    ])
      expect(EstatConfigSchema.safeParse({ ...config, search_words }).success).toBe(false);
  });
  it('hashes all new selection fields and keeps bundled sources disabled and unreviewed', async () => {
    const f = fixture();
    const baseline = await estatConfigurationHash(f.source);
    for (const changes of [
      { item_codes: ['0076000'] },
      { search_words: ['別の検索語', '在庫率'] },
      { implied_measures: { 在庫: 'inventory' as const } },
    ]) {
      const modified = structuredClone(f.source);
      Object.assign(modified.estat!, changes);
      expect(await estatConfigurationHash(modified)).not.toBe(baseline);
    }
    for (const source of sources.filter((s) => s.estat)) {
      expect(source.enabled).toBe(false);
      expect(source.estat!.reviewed_schema_signatures).toEqual([]);
      expect(source.policy.version).toBe(`${source.source_id}-20261022-v3`);
      const previous = structuredClone(source);
      previous.policy.version = `${source.source_id}-20261022-v2`;
      expect(await estatConfigurationHash(previous)).not.toBe(await estatConfigurationHash(source));
    }
    expect(
      JSON.parse(readFileSync(new NodeURL('../wrangler.collector.jsonc', import.meta.url), 'utf8'))
        .vars.ESTAT_ENABLED,
    ).toBe('false');
    expect(f.source.estat!.item_codes).toEqual([
      '0076000',
      '0083000',
      '0140000',
      '0145000',
      '0146000',
      '0147000',
    ]);
  });
});

// Constructed annual layout: no measure axis or @unit, twelve monthly time codes.
function annualFixture() {
  const source = structuredClone(sources.find((s) => s.source_id === 'estat_meti_seidou')!);
  const table: EstatTable = {
    table_id: '9999999995',
    title: '2025年 時系列表(2290_機械器具月報（その２９）静止電気機械器具（航空機用のものを除く))',
    group: '静止電気機械器具',
    year: 2025,
    updated_at: null,
  };
  const measureNames = [
    '生産数量',
    '生産容量',
    '生産金額',
    '受入数量',
    '販売数量',
    '販売容量',
    '販売金額',
    '月末在庫数量',
  ];
  const item = {
    '@id': 'cat01',
    '@name': '2021_2290_表側',
    CLASS: measureNames.map((measure, i) => ({
      '@code': String(2290010010 + i * 10),
      '@name': `製品_0101_合成_変圧器_${String.fromCharCode(65 + i)}_${measure}_${measure.endsWith('金額') ? '百万円' : measure.endsWith('容量') ? 'kVA' : '台'}`,
    })),
  };
  const time = {
    '@id': 'time',
    '@name': '2025_実数表_時間軸_表頭',
    CLASS: Array.from({ length: 12 }, (_, i) => ({
      '@code': String(2025000101 + i * 101),
      '@name': `2025${String(i + 1).padStart(2, '0')}`,
    })),
  };
  const data = {
    TABLE_INF: { '@id': table.table_id, STAT_NAME: { '@code': '00550200' } },
    CLASS_INF: { CLASS_OBJ: [item, time] },
    DATA_INF: {
      VALUE: item.CLASS.flatMap((c) =>
        time.CLASS.map((t) => ({
          '@cat01': c['@code'],
          '@time': t['@code'],
          $: '12.3400',
        })),
      ),
    },
    RESULT_INF: { TOTAL_NUMBER: 96, NEXT_KEY: 0 },
  };
  return { source, table, item, time, data, body: { GET_STATS_DATA: { STATISTICAL_DATA: data } } };
}

describe('e-Stat annual embedded product measures (synthetic, offline)', () => {
  it('splits from the right and keeps only the five allowed measures with stable item identity', async () => {
    const f = annualFixture();
    // A skipped capacity value need not parse as an observation.
    f.data.DATA_INF.VALUE[12].$ = 'excluded-value';
    const page = await parseEstatData(f.source, f.table, f.body);
    expect(page.rows).toHaveLength(60);
    expect(page.next).toBeNull();
    expect(new Set(page.rows.map((r) => r.measure))).toEqual(
      new Set(['production_qty', 'production_value', 'sales_qty', 'sales_value', 'inventory']),
    );
    expect(page.rows[0]).toMatchObject({
      item_code: '2290_0101',
      item_name_ja: '合成_変圧器',
      measure: 'production_qty',
      unit_raw: '台',
      period: '2025-01',
      value_decimal: '12.3400',
      base_year: null,
    });
    expect(page.rows[12]).toMatchObject({ measure: 'production_value', unit_raw: '百万円' });
    expect(new Set(page.rows.map((r) => r.item_code))).toEqual(new Set(['2290_0101']));
    f.table.table_id = f.data.TABLE_INF['@id'] = '9999999996';
    f.item['@name'] = '2026_2290_表側';
    expect((await parseEstatData(f.source, f.table, f.body)).rows[0].item_code).toBe('2290_0101');
    f.item['@name'] = '2021_2570_表側';
    expect((await parseEstatData(f.source, f.table, f.body)).rows[0].item_code).toBe('2570_0101');
  });
  it('handles a constructed 81-class / 972-value annual table in one data page', async () => {
    const f = annualFixture();
    const template = [...f.item.CLASS];
    f.item.CLASS = Array.from({ length: 81 }, (_, i) => ({
      '@code': String(2290010010 + i * 10),
      '@name': template[i % 8]['@name'].replace(
        '_0101_',
        `_${String(101 + Math.floor(i / 8)).padStart(4, '0')}_`,
      ),
    }));
    f.data.DATA_INF.VALUE = f.item.CLASS.flatMap((c) =>
      f.time.CLASS.map((t) => ({
        '@cat01': c['@code'],
        '@time': t['@code'],
        $: '12.3400',
      })),
    );
    f.data.RESULT_INF.TOTAL_NUMBER = 972;
    const page = await parseEstatData(f.source, f.table, f.body);
    expect(page.rows).toHaveLength(612);
    expect(page.next).toBeNull();
  });
  it('keeps raw pagination counts when excluded measures occupy a page', async () => {
    const f = annualFixture();
    f.data.DATA_INF.VALUE = f.data.DATA_INF.VALUE.slice(12, 24);
    f.data.RESULT_INF.NEXT_KEY = 25;
    expect(await parseEstatData(f.source, f.table, f.body, 13)).toMatchObject({
      rows: [],
      next: 25,
    });
    f.item.CLASS[1]['@name'] = '製品_0101_合成品_B_toString_台';
    expect((await parseEstatData(f.source, f.table, f.body, 13)).rows).toEqual([]);
  });
  it.each([
    '品目_0101_合成品_A_生産数量_台',
    '製品_101_合成品_A_生産数量_台',
    '製品_0101__A_生産数量_台',
    '製品_0101_合成品_AA_生産数量_台',
    '製品_0101_合成品_A__台',
    '製品_0101_合成品_A_生産数量_',
  ])(
    'fails closed on malformed class name %s, even without values for that class',
    async (name) => {
      const f = annualFixture();
      f.item.CLASS[1]['@name'] = name;
      f.data.DATA_INF.VALUE = f.data.DATA_INF.VALUE.slice(0, 1);
      await expect(parseEstatData(f.source, f.table, f.body)).rejects.toThrow(
        'estat_classification_unknown',
      );
    },
  );
  it.each(['2021_229_表側', '2021_22900_表側', '2021_2290_表頭'])(
    'rejects unrecognized annual item dimension %s',
    async (name) => {
      const f = annualFixture();
      f.item['@name'] = name;
      await expect(parseEstatData(f.source, f.table, f.body)).rejects.toThrow(
        'estat_dimensions_unknown',
      );
    },
  );
  it('restricts the embedded layout to annual releases and rejects a conflicting measure axis', async () => {
    const f = annualFixture();
    f.source.estat!.release_kind = 'iip_monthly';
    await expect(parseEstatData(f.source, f.table, f.body)).rejects.toThrow(
      'estat_dimensions_unknown',
    );
    f.source.estat!.release_kind = 'annual';
    f.data.CLASS_INF.CLASS_OBJ.push({
      '@id': 'cat02',
      '@name': '表章項目',
      CLASS: [{ '@code': 'qty', '@name': '生産数量' }],
    });
    await expect(parseEstatData(f.source, f.table, f.body)).rejects.toThrow(
      'estat_dimensions_unknown',
    );
  });
  it('matches real-style annual titles while using short API search words', () => {
    const f = annualFixture();
    const groups = f.source.estat!.table_groups;
    expect(groups).toEqual(f.source.selection);
    expect(f.source.estat!.search_words).toEqual([
      '静止電気機械器具',
      '半導体製造装置',
      '産業用ロボット',
      '開閉制御装置',
    ]);
    const titles = [
      f.table.title,
      '2025年 時系列表(2570_機械器具月報（その５７）半導体製造装置及びフラットパネル・ディスプレイ製造装置)',
      '2025年 時系列表(2080_機械器具月報（その８）運搬機械及び産業用ロボット)',
      '2025年 時系列表(2300_機械器具月報（その３０）開閉制御装置（航空機用のものを除く))',
    ];
    const result = parseEstatList(f.source, {
      GET_STATS_LIST: {
        DATALIST_INF: {
          NUMBER: 4,
          TABLE_INF: titles.map((title, i) => ({
            '@id': String(9999999990 + i),
            STAT_NAME: { '@code': '00550200' },
            TITLE: title,
            STATISTICS_NAME: '経済産業省生産動態統計 年報 年報(2021年以降) 2025年 年報',
            SURVEY_DATE: '202501-202512',
          })),
        },
      },
    });
    expect(result.tables.map((t) => t.group)).toEqual(groups);
  });
});
