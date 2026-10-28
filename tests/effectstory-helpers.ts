// Entirely synthetic markup and prices. Never a real page/response fixture.
export const effectstoryHTML = (
  rows = [
    [
      'Synthetic Cloud',
      'GB300 NVL72',
      '$3.2500/GPU-hr',
      'Synthetic on-demand list, 72-GPU system, test-region',
      '2026-10-25',
    ],
    [
      'Synthetic Lab',
      'B300 (p6-b300.48xlarge)',
      '$1.234/GPU-hr',
      'Synthetic reserved conditions',
      '2026-10-26',
    ],
    [
      'Synthetic Unknown',
      'Future chip X99',
      '$0.00/GPU-hr',
      'Synthetic unverified zero',
      '2026-10-24',
    ],
  ],
) => `<!DOCTYPE html><html><head><meta charset="utf-8"><script>self.__next_f.push([1,"<table>untrusted RSC</table>&"])</script></head><body>
<h2>Full table</h2><table><thead><tr>${['Provider', 'GPU', 'Hourly (USD)', 'Basis', 'Checked'].map((h) => `<th>${h}</th>`).join('')}</tr></thead>
<tbody>${rows.map((row) => `<tr>${row.map((s) => `<td>${s}</td>`).join('')}</tr>`).join('')}</tbody></table>
<p>Licensed CC BY 4.0: reuse freely, credit EffectStory and link back to this page.</p></body></html>`;
export const effectstoryTime = '2026-10-29T18:17:00.000Z';
