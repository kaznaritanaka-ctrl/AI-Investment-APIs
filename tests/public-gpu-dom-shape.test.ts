import { describe, expect, it } from 'vitest';
import { parsePublicGpu } from '../src/research/public-gpu-html';
import { publicGpuSource, gpuTime } from './public-gpu-fixture-config';

// Independently authored HTML using reviewed structural counts only. All product
// details, IDs, periods and amounts below are invented, never copied source rows.
const rental = (count: number, columns: number, prefix: string) => {
  const header = ['インスタンス', '従量課金 [1h・台]', '月額課金 [月・台]', 'ストレージ'];
  return (
    '<table><tbody><tr>' +
    [...header, ...Array<string>(columns - 4).fill('synthetic unused')]
      .map((h) => `<th>${h}</th>`)
      .join('') +
    '</tr>' +
    Array.from(
      { length: count },
      (_, i) =>
        '<tr>' +
        [
          `synthetic-${prefix}-${i}`,
          '13円',
          '1300円',
          '111GB',
          ...Array<string>(columns - 4).fill('unused'),
        ]
          .map((v) => `<td>${v}</td>`)
          .join('') +
        '</tr>',
    ).join('') +
    '</tbody></table>'
  );
};

describe('synthetic reconstruction of the 2026-10-18 structural review', () => {
  it('keeps all 24 selected instances across two tables after an excluded table, with no invented H100', async () => {
    const c = await publicGpuSource();
    if (c.scope.kind !== 'highreso_public') throw Error('fixture');
    c.scope.gpu_counts = [1];
    const html =
      '<h1>Synthetic page</h1>' +
      '<h3>Synthetic group one</h3><p>GPU：NVIDIA RTX 6000 x 1枚</p>' +
      rental(4, 8, 'excluded') +
      '<h3>Synthetic group two</h3><p>GPU：NVIDIA A100 40GB x 1枚</p>' +
      rental(12, 8, 'first') +
      '<h3>Synthetic group three</h3><p>GPU：NVIDIA A100 80GB x 1枚</p>' +
      rental(12, 12, 'second');
    const page = await parsePublicGpu(c, html, gpuTime, true);
    expect(page.selection).toMatchObject({ input_rows: 28, cohort_rows: 24, excluded_rows: 4 });
    expect(page.records).toHaveLength(48);
    expect(new Set(page.records.map((r) => r.instance_id)).size).toBe(24);
    expect(page.records.every((r) => r.identity.accelerator_model === 'A100')).toBe(true);
    expect(page.records.filter((r) => r.offer.unit === 'node_hour')).toHaveLength(24);
    expect(page.records.filter((r) => r.offer.unit === 'month')).toHaveLength(24);
    await expect(parsePublicGpu(c, html + rental(1, 12, 'extra'), gpuTime, true)).rejects.toThrow(
      'research_page_limit',
    );
  });
  it('selects four synthetic cases from twenty rows without interpreting the page as all transactions', async () => {
    const c = await publicGpuSource('rebro_public');
    const html =
      '<h1>Synthetic page</h1><h2>買取実績</h2><table><tbody>' +
      '<tr><th>買取時期</th><th>商品</th><th>数量</th><th>買取単価</th><th>お取引</th></tr>' +
      Array.from(
        { length: 20 },
        (_, i) =>
          `<tr><td>2025年1月</td><td>${i < 4 ? (i % 2 ? 'H100' : 'A100') : 'RTX 6000'}</td><td>1枚</td><td>17円</td><td>unused</td></tr>`,
      ).join('') +
      '</tbody></table>';
    const page = await parsePublicGpu(c, html, gpuTime, true);
    expect(page.selection).toMatchObject({ input_rows: 20, cohort_rows: 4, excluded_rows: 16 });
    expect(page.records).toHaveLength(4);
    expect(new Set(page.records.map((r) => r.record_key)).size).toBe(4);
    expect(
      page.records.every(
        (r) => r.offer.transaction_at === null && r.offer.basis === 'selected_public_case',
      ),
    ).toBe(true);
  });
});
