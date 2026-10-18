import { dailyFixture, heartbeat, receiptSecret } from './daily-helpers';
import {
  collectDaily,
  exportDailyHistory,
  dailyJSON,
  maintainDaily,
  type DailyEnv,
} from '../src/research/personal-daily';
import { PersonalDailySchema } from '../src/research/personal-contract';
import { hash, stable } from '../src/util';
import { robots, terms, gpuTime } from './public-gpu-fixture-config';
import { dailyRoot } from '../src/research/daily-protocol';
export async function dailyRuntime(base: DailyEnv, html: string, step: number) {
  const f = await dailyFixture();
  const c = PersonalDailySchema.parse({
    ...f.c,
    decision: {
      ...f.c.decision,
      acquisition_until: '2026-12-01T00:00:00.000Z',
      analysis_until: '2026-12-01T00:00:00.000Z',
      terms: { ...f.c.decision.terms, review_after: '2026-12-01T00:00:00.000Z' },
    },
  });
  const pin = { ...f.pin, contract_hash: await hash(stable(c)) },
    env = { ...base, NAS_HEALTH: base.EVIDENCE, NAS_RECEIPT_SECRET: receiptSecret };
  const at = new Date(Date.parse(gpuTime) + Math.min(step, 39) * 86400000).toISOString();
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
  const bounded = { ...env, PRIVATE_DB: db };
  if (step < 40) {
    await heartbeat(env, 'rebro_public', at);
    const get: typeof fetch = async (url) => {
      calls++;
      const u = String(url),
        robot = u.endsWith('/robots.txt');
      return new Response(robot ? robots : u.endsWith('/rules/') ? terms : html, {
        headers: { 'content-type': robot ? 'text/plain' : 'text/html' },
      });
    };
    await collectDaily(bounded, c, pin, { now: () => at, allow_network: true, fetcher: get });
    await collectDaily(bounded, c, pin, { now: () => at, allow_network: true, fetcher: get });
  }
  const exported = await exportDailyHistory(bounded, 'rebro_public', at);
  const head = await dailyJSON(env.EVIDENCE, dailyRoot('rebro_public') + 'catalog.json');
  if (step === 79) await maintainDaily(env, 'rebro_public', '2037-10-18T01:00:00.000Z');
  return {
    calls,
    maxBatch,
    exported: exported.state,
    head,
    observations: await env.PRIVATE_DB.prepare(
      'SELECT COUNT(*) n FROM personal_daily_observations',
    ).first('n'),
    runs: await env.PRIVATE_DB.prepare(
      "SELECT COUNT(*) n FROM personal_daily_runs WHERE state='complete'",
    ).first('n'),
  };
}
