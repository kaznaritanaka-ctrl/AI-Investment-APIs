import { describe, expect, it } from 'vitest';
import { EstatConfigSchema } from '../src/estat-schema';
import { estatConfigurationHash, parseEstatData, type EstatTable } from '../src/estat';
import { sources } from '../src/sources';

// Constructed metadata/values only; never a captured e-Stat response.
function fixture(group = '在庫') {
  const source = structuredClone(sources.find((s) => s.source_id === 'estat_meti_iip')!);
  const table: EstatTable = {
    table_id: '9999999995',
    title: `2020年基準 品目別季節調整済【月次】${group}`,
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
      VALUE: time.CLASS.map((t, i) => ({
        '@cat01': '0076000',
        '@time': t['@code'],
        '@unit': '指数',
        $: i === 0 ? 'not-a-period-or-value' : '98.700',
      })),
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
      });
    },
  );
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
      expect(source.policy.version).toBe(`${source.source_id}-20261022-v2`);
    }
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
