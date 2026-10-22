import { expect, it } from 'vitest';
import { sources } from '../src/sources';
import { parseEstatData, type EstatTable } from '../src/estat';

// Synthetic 100 items x 100 months, never a real response fixture.
export function capacityFixture() {
  const source = structuredClone(sources.find((s) => s.source_id === 'estat_meti_seidou')!);
  const table: EstatTable = {
    table_id: '9999999995',
    title: '2025年 年報 時系列表 静止電気機械器具',
    group: '静止電気機械器具',
    year: 2025,
    updated_at: null,
  };
  const items = Array.from({ length: 100 }, (_, i) => ({
    '@code': 'i' + i,
    '@name': '合成品目' + i,
  }));
  const times = Array.from({ length: 100 }, (_, i) => ({
    '@code': 't' + i,
    '@name': `${2017 + Math.floor(i / 12)}年${(i % 12) + 1}月`,
  }));
  const body = {
    GET_STATS_DATA: {
      RESULT: { STATUS: 0 },
      STATISTICAL_DATA: {
        TABLE_INF: { '@id': table.table_id, STAT_NAME: { '@code': '00550200' } },
        CLASS_INF: {
          CLASS_OBJ: [
            { '@id': 'cat01', '@name': '品目', CLASS: items },
            {
              '@id': 'cat02',
              '@name': '表章項目',
              CLASS: { '@code': 'qty', '@name': '生産数量', '@unit': '台' },
            },
            { '@id': 'time', '@name': '時間軸', CLASS: times },
          ],
        },
        DATA_INF: {
          VALUE: items.flatMap((item) =>
            times.map((time) => ({
              '@cat01': item['@code'],
              '@cat02': 'qty',
              '@time': time['@code'],
              '@unit': '台',
              $: '123456789.012300',
            })),
          ),
        },
        RESULT_INF: { TOTAL_NUMBER: 50000, NEXT_KEY: 10001 },
      },
    },
  };
  return { source, table, body };
}

it('accepts a 10,000-row synthetic page and rejects overflow while preserving bounded pagination', async () => {
  const { source, table, body } = capacityFixture();
  expect(source.estat!.page_size).toBe(10000);
  expect(source.estat!.max_data_pages).toBe(5);
  const rawBytes = new TextEncoder().encode(JSON.stringify(body)).byteLength;
  expect(rawBytes).toBeLessThan(source.max_bytes);
  const started = performance.now();
  const page = await parseEstatData(source, table, body);
  const elapsed = performance.now() - started;
  expect(page.rows).toHaveLength(10000);
  expect(page.next).toBe(10001);
  expect(page.rows[9999]).toMatchObject({
    item_code: 'i99',
    period: '2025-04',
    value_decimal: '123456789.012300',
  });
  const projectedBytes = new TextEncoder().encode(JSON.stringify(page)).byteLength;
  // Metadata only: local timing is diagnostic, never a Cloudflare CPU/capacity assertion.
  console.log(
    JSON.stringify({
      synthetic_estat_page: {
        rows: page.rows.length,
        raw_bytes: rawBytes,
        projection_bytes: projectedBytes,
        local_parse_ms: Math.round(elapsed),
      },
    }),
  );
  body.GET_STATS_DATA.STATISTICAL_DATA.DATA_INF.VALUE.push(
    body.GET_STATS_DATA.STATISTICAL_DATA.DATA_INF.VALUE[0],
  );
  await expect(parseEstatData(source, table, body)).rejects.toThrow('estat_page_too_large');
});
