import { dailyFixture, heartbeat } from './daily-helpers';
import { PersonalDailySchema } from '../src/research/personal-contract';
import { collectDaily, type DailyEnv } from '../src/research/personal-daily';
import { hash, stable } from '../src/util';
import { gpuFetcher } from './public-gpu-helpers';
import { vi } from 'vitest';
export function rentalHtml(count: number, prefix = 'instance', gpuCount = 1, amount = '101円') {
  return (
    '<h2>A100</h2><p>GPU: NVIDIA A100 80GB PCIe x ' +
    gpuCount +
    '枚</p><h3>ストレージサイズ</h3><h3>料金</h3><table><tr><th>インスタンス</th><th>従量課金[1h・台]</th><th>月額課金[月・台]</th><th>ストレージ</th></tr>' +
    Array.from(
      { length: count },
      (_, i) =>
        '<tr><td>' +
        prefix +
        '-' +
        i.toString().padStart(3, '0') +
        '</td><td>' +
        amount +
        '</td><td>303円</td><td>10GB</td></tr>',
    ).join('') +
    '</table>'
  );
}
export function casesHtml(prices = ['101円', '101円']) {
  return (
    '<h2>買取実績</h2><table><tr><th>買取時期</th><th>商品</th><th>数量</th><th>買取単価</th><th>お取引</th></tr>' +
    prices
      .map(
        (price) =>
          '<tr><td>2026年10月</td><td>NVIDIA A100 80GB PCIe</td><td>1枚</td><td>' +
          price +
          '</td><td>synthetic</td></tr>',
      )
      .join('') +
    '</table>'
  );
}
export async function expandedDaily(
  source: 'highreso_public' | 'rebro_public' = 'highreso_public',
) {
  const f = await dailyFixture(source),
    c = structuredClone(f.c);
  c.config.limits.capture_record_limit = 128;
  c.config.source.max_records = 128;
  c.config.limits.max_input_rows = 256;
  c.config_sha256 = await hash(stable(c.config));
  return {
    c: PersonalDailySchema.parse(c),
    pin: { ...f.pin, contract_hash: await hash(stable(c)) },
  };
}
export async function day(
  env: DailyEnv,
  f: Awaited<ReturnType<typeof expandedDaily>>,
  at: string,
  html: string,
) {
  await heartbeat(env, f.c.config.source.source_id, at);
  const get = vi.fn(gpuFetcher(f.c.config.adapter as 'highreso_public' | 'rebro_public', html));
  let result = await collectDaily(env, f.c, f.pin, {
    now: () => at,
    allow_network: true,
    fetcher: get,
  });
  for (let i = 0; result.state === 'partial' && i < 15; i++)
    result = await collectDaily(
      env,
      f.c,
      f.pin,
      { now: () => at, allow_network: true, fetcher: get },
      at.slice(0, 10),
    );
  return { result, get };
}
