import { dailyFixture, heartbeat, receiptSecret } from './daily-helpers';
import { PersonalDailySchema } from '../src/research/personal-contract';
import {
  collectDaily,
  exportDailyHistory,
  dailyJSON,
  type DailyEnv,
} from '../src/research/personal-daily';
import { dailyRoot, DailyManifest, validateDailySnapshot } from '../src/research/daily-protocol';
import { hash, stable } from '../src/util';
import { robots, terms, gpuTime } from './public-gpu-fixture-config';
export async function dailyScaleRuntime(base: DailyEnv) {
  const f = await dailyFixture('highreso_public'),
    c = structuredClone(f.c);
  c.config.source.max_records = 128;
  c.config.limits.capture_record_limit = 128;
  c.config.limits.max_input_rows = 256;
  c.config_sha256 = await hash(stable(c.config));
  const contract = PersonalDailySchema.parse(c),
    pin = { ...f.pin, contract_hash: await hash(stable(contract)) };
  const env = { ...base, NAS_HEALTH: base.EVIDENCE, NAS_RECEIPT_SECRET: receiptSecret };
  let calls = 0,
    maxBatch = 0;
  const db = new Proxy(env.PRIVATE_DB, {
    get(target, key) {
      const value = Reflect.get(target, key);
      return key === 'batch'
        ? async (statements: D1PreparedStatement[]) => {
            maxBatch = Math.max(maxBatch, statements.length);
            return target.batch(statements);
          }
        : typeof value === 'function'
          ? value.bind(target)
          : value;
    },
  });
  await heartbeat(env, 'highreso_public', gpuTime);
  const html =
    '<h2>A100</h2><p>GPU: NVIDIA A100 80GB PCIe x 1枚</p><h3>料金</h3><table><tr><th>インスタンス</th><th>従量課金[1h・台]</th><th>月額課金[月・台]</th><th>ストレージ</th></tr>' +
    Array.from(
      { length: 64 },
      (_, i) => '<tr><td>synthetic-' + i + '</td><td>101円</td><td>202円</td><td>10GB</td></tr>',
    ).join('') +
    '</table>';
  const get: typeof fetch = async (url) => {
    calls++;
    return new Response(
      String(url).endsWith('/robots.txt') ? robots : String(url).endsWith('/terms') ? terms : html,
      {
        headers: {
          'content-type': String(url).endsWith('/robots.txt') ? 'text/plain' : 'text/html',
        },
      },
    );
  };
  const result = await collectDaily({ ...env, PRIVATE_DB: db }, contract, pin, {
    now: () => gpuTime,
    fetcher: get,
    allow_network: true,
  });
  let records = 0,
    parts = 0,
    bytes = 0;
  if (result.state === 'complete') {
    await exportDailyHistory(env, 'highreso_public', gpuTime);
    const h = await dailyJSON(env.EVIDENCE, dailyRoot('highreso_public') + 'catalog.json'),
      m = DailyManifest.parse(
        await dailyJSON(
          env.EVIDENCE,
          dailyRoot('highreso_public') + 'runs/' + h.latest_run_id + '.json',
        ),
      );
    const blocks = [];
    for (const p of m.chunks) {
      const o = await env.EVIDENCE.get(p.key);
      if (!o || o.size !== p.bytes) throw new Error('synthetic runtime part missing');
      blocks.push(new Uint8Array(await o.arrayBuffer()));
    }
    const all = new Uint8Array(blocks.reduce((n, b) => n + b.length, 0));
    let offset = 0;
    for (const block of blocks) {
      all.set(block, offset);
      offset += block.length;
    }
    records = (await validateDailySnapshot(JSON.parse(new TextDecoder().decode(all)))).records
      .length;
    parts = m.chunks.length;
    bytes = all.length;
  }
  return { state: result.state, calls, maxBatch, records, parts, bytes };
}
