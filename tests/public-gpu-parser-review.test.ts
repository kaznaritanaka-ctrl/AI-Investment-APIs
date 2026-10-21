import { describe, it, expect } from 'vitest';
import {
  parsePublicGpu,
  gpuRecordFingerprint,
  termsFingerprint,
} from '../src/research/public-gpu-html';
import { ResearchConfigSchema } from '../src/research/schema';
import { publicGpuSource, gpuHtml, gpuTime } from './public-gpu-helpers';
import { researchFixture } from './research-helpers';
const hierarchical = researchFixture('highreso-hierarchy.synthetic.html');
const table = (count: number, prefix: string) =>
  '<table><tbody><tr><th>インスタンス</th><th>従量課金 [1h・台]</th><th>月額課金 [月・台]</th><th>ストレージ</th></tr>' +
  Array.from(
    { length: count },
    (_, i) =>
      `<tr><td>synthetic-${prefix}-${i}</td><td>${i + 1}円</td><td>${(i + 1) * 100}円</td><td>123GB</td></tr>`,
  ).join('') +
  '</tbody></table>';
describe('public GPU parser review: synthetic scope and completeness', () => {
  it('ignores HTML raw-text script/style bodies while retaining strict table validation', async () => {
    const c = await publicGpuSource();
    // Invented markup reproduces bare ampersands/less-than signs, never live HTML.
    const rawText =
      '<script type="text/javascript">const query = "?a=1&b=2"; if (1 < 2) run();</script>' +
      '<style>.synthetic::before { content: "<&"; }</style>';
    const baseline = await parsePublicGpu(c, hierarchical, gpuTime, true);
    const page = await parsePublicGpu(c, rawText + hierarchical, gpuTime, true);
    expect(page.selection).toEqual(baseline.selection);
    expect(await Promise.all(page.records.map(gpuRecordFingerprint))).toEqual(
      await Promise.all(baseline.records.map(gpuRecordFingerprint)),
    );
    expect(await termsFingerprint('<p>Artificial visible terms</p>' + rawText)).toBe(
      await termsFingerprint('<p>Artificial visible terms</p>'),
    );
    for (const broken of [
      hierarchical.slice(0, hierarchical.lastIndexOf('</table>')),
      hierarchical.replace('<td>11円</td>', '<td colspan="2">11円</td>'),
      '<script>unclosed &',
      '<style>unclosed <',
    ])
      await expect(parsePublicGpu(c, rawText + broken, gpuTime, true)).rejects.toThrow(
        'public_gpu_table_schema_changed',
      );
  });
  it('keeps GPU ancestry across nested headings and multiple 8/12-column tables, switches GPU and keeps null', async () => {
    const c = await publicGpuSource(),
      page = await parsePublicGpu(c, hierarchical, gpuTime, true);
    expect(
      page.records.map((r) => [r.identity.accelerator_model, r.offer.unit, r.offer.amount_decimal]),
    ).toEqual([
      ['A100', 'node_hour', '11'],
      ['A100', 'month', '1100'],
      ['A100', 'node_hour', '22'],
      ['A100', 'month', '2200'],
      ['H100', 'node_hour', null],
      ['H100', 'month', '3300'],
    ]);
    expect(page.selection).toMatchObject({
      input_rows: 3,
      cohort_rows: 3,
      excluded_rows: 0,
      price_slots_per_row: 2,
    });
  });
  it.each(['peer', 'nested_gpu', 'unknown_section', 'mismatched_spec', 'header', 'truncated'])(
    'fails closed on %s instead of leaking the previous SKU',
    async (variant) => {
      const c = await publicGpuSource();
      let html = hierarchical;
      if (variant === 'peer')
        html = html.replace('<h4>ストレージサイズ (追加)</h4>', '<h2>Other service</h2>');
      if (variant === 'nested_gpu')
        html = html.replace('<h4>ストレージサイズ (追加)</h4>', '<h4>H100</h4>');
      if (variant === 'unknown_section')
        html = html.replace('<h4>ストレージサイズ (追加)</h4>', '<h4>Unreviewed GPU block</h4>');
      if (variant === 'mismatched_spec')
        html = html.replace('GPU：NVIDIA A100', 'GPU：NVIDIA H100');
      if (variant === 'header') html = html.replace('従量課金 [1h・台]', '従量課金 [1h・GPU]');
      if (variant === 'truncated') html = html.slice(0, html.lastIndexOf('</table>'));
      await expect(parsePublicGpu(c, html, gpuTime, true)).rejects.toThrow(
        'public_gpu_table_schema_changed',
      );
    },
  );
  it('accepts all 24 selected instances (48 prices), including those after excluded rows, never truncates overflow', async () => {
    const c = await publicGpuSource();
    if (c.scope.kind !== 'highreso_public') throw Error('fixture');
    c.scope.gpu_counts = [1];
    const excluded =
      '<h2>A100 multi</h2><p>GPU：NVIDIA A100 80GB x 2枚</p>' + table(25, 'excluded');
    const selected = '<h2>A100 single</h2><p>GPU：NVIDIA A100 80GB x 1枚</p>';
    const page = await parsePublicGpu(
      c,
      excluded + selected + table(24, 'selected'),
      gpuTime,
      true,
    );
    expect(page.records).toHaveLength(48);
    expect(page.records.at(-1)?.instance_id).toBe('synthetic-selected-23');
    expect(page.selection).toMatchObject({ input_rows: 49, cohort_rows: 24, excluded_rows: 25 });
    expect(page.records.every((r) => r.offer.gpu_count === 1)).toBe(true);
    await expect(
      parsePublicGpu(c, excluded + selected + table(25, 'selected'), gpuTime, true),
    ).rejects.toThrow('research_page_limit');
    await expect(
      parsePublicGpu(c, excluded + selected + table(76, 'selected'), gpuTime, true),
    ).rejects.toThrow('research_page_limit');
    const noCount = structuredClone(c);
    if (noCount.scope.kind === 'highreso_public') delete noCount.scope.gpu_counts;
    expect(ResearchConfigSchema.safeParse(noCount).success).toBe(false);
  });
  it('does not deduplicate same-month same-product cases or claim stable transaction IDs', async () => {
    const c = await publicGpuSource('rebro_public');
    const row =
      '<tr><td>2025年2月</td><td>NVIDIA A100 40GB PCIe</td><td>3枚</td><td>234,567円</td><td>unused</td></tr>';
    const html = gpuHtml('rebro_public').replace(
      '</tbody>',
      row + row.replace('234,567円', '345,678円') + '</tbody>',
    );
    const page = await parsePublicGpu(c, html, gpuTime, true);
    expect(page.records).toHaveLength(4);
    expect(new Set(page.records.map((r) => r.record_key)).size).toBe(4);
    expect(
      page.records.every(
        (r) =>
          r.case_identity_basis === 'public_content_occurrence_not_transaction' &&
          r.offer.transaction_at === null,
      ),
    ).toBe(true);
    const again = await parsePublicGpu(c, html, '2026-10-19T01:00:00.000Z', true);
    expect(again.records.map((r) => r.record_key)).toEqual(page.records.map((r) => r.record_key));
    expect(await gpuRecordFingerprint(again.records[0])).toBe(
      await gpuRecordFingerprint(page.records[0]),
    );
    const reordered = await parsePublicGpu(
      c,
      html.replace(
        row + row.replace('234,567円', '345,678円'),
        row.replace('234,567円', '345,678円') + row,
      ),
      gpuTime,
      true,
    );
    expect(reordered.records.map((r) => r.record_key).sort()).toEqual(
      page.records.map((r) => r.record_key).sort(),
    );
    // Legacy captured contracts retain their key convention and fail on ambiguity.
    c.method_version = 'domestic-gpu-html-v1';
    await expect(parsePublicGpu(c, html, gpuTime, true)).rejects.toThrow(
      'research_duplicate_record',
    );
  });
});
