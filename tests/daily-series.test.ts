import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { personalLocalEnv } from '../scripts/personal-local-env';
import { expandedDaily, day, rentalHtml, casesHtml } from './daily-series-helpers';
import { heartbeat, receiptSecret } from './daily-helpers';
import { gpuFetcher, gpuTime, robots, terms } from './public-gpu-helpers';
import {
  collectDaily,
  exportDailyHistory,
  dailyJSON,
  type DailyEnv,
} from '../src/research/personal-daily';
import { dailyRoot, DailyManifest, validateDailySnapshot } from '../src/research/daily-protocol';
import { hash, stable } from '../src/util';
import { PersonalDailySchema } from '../src/research/personal-contract';
import { dailySeriesDefinition } from '../src/research/daily-series';
describe(
  'daily complete series lifecycle and bounded cohort (synthetic only)',
  { timeout: 120000 },
  () => {
    let local: Awaited<ReturnType<typeof personalLocalEnv>>, env: DailyEnv;
    beforeEach(async () => {
      local = await personalLocalEnv('synthetic-store');
      env = { ...local.env, NAS_HEALTH: local.env.EVIDENCE, NAS_RECEIPT_SECRET: receiptSecret };
    });
    afterEach(async () => {
      await local?.mf.dispose();
    });
    const events = async () =>
      (
        await env.PRIVATE_DB.prepare(
          "SELECT o.*,r.day FROM personal_daily_observations o JOIN personal_daily_runs r ON r.run_id=o.run_id WHERE r.state='complete' ORDER BY r.day,o.record_key",
        ).all()
      ).results;
    it('records A -> absent -> still absent -> reappeared without prices, sales or duplicate transitions', async () => {
      const f = await expandedDaily();
      for (const [i, n] of [1, 0, 0, 1].entries()) {
        const at = '2026-10-' + (18 + i) + 'T01:00:00.000Z';
        const { result, get } = await day(env, f, at, rentalHtml(n, 'instance', 1, '0円'));
        expect(result.state).toBe('complete');
        expect(get).toHaveBeenCalledTimes(3);
        await collectDaily(env, f.c, f.pin, { now: () => at, allow_network: true, fetcher: get });
        expect(get).toHaveBeenCalledTimes(3);
      }
      const rows = await events();
      expect(rows).toHaveLength(6);
      const hour = rows.filter((r) => r.record_key === 'instance-000:node_hour');
      expect(hour.map((r) => r.change_kind)).toEqual(['first_seen', 'not_seen', 'reappeared']);
      expect(JSON.parse(String(hour[0].domain_json)).offer.amount_decimal).toBe('0');
      expect(hour[1]).toMatchObject({
        domain_json: null,
        record_hash: null,
        previous_observation_id: hour[0].observation_id,
      });
      expect(hour[2].previous_observation_id).toBe(hour[1].observation_id);
      expect(rows.filter((r) => r.day === '2026-10-20')).toHaveLength(0);
      const counts = (
        await env.PRIVATE_DB.prepare(
          'SELECT coverage_json FROM personal_daily_coverage ORDER BY rowid',
        ).all<{ coverage_json: string }>()
      ).results.map((r) => JSON.parse(r.coverage_json));
      expect(counts.map((r) => [r.seen_count, r.not_seen_count])).toEqual([
        [2, 0],
        [0, 2],
        [0, 0],
        [2, 0],
      ]);
      for (let i = 0; i < 4; i++)
        await exportDailyHistory(env, 'highreso_public', '2026-10-21T02:00:00.000Z');
      const runs = (
        await env.PRIVATE_DB.prepare('SELECT run_id FROM personal_daily_runs').all<{
          run_id: string;
        }>()
      ).results;
      for (const r of runs) {
        const m = DailyManifest.parse(
          await dailyJSON(
            env.EVIDENCE,
            dailyRoot('highreso_public') + 'runs/' + r.run_id + '.json',
          ),
        );
        const parts = await Promise.all(
          m.chunks.map(
            async (p) => new Uint8Array(await (await env.EVIDENCE.get(p.key))!.arrayBuffer()),
          ),
        );
        await expect(
          validateDailySnapshot(JSON.parse(Buffer.concat(parts).toString())),
        ).resolves.toMatchObject({ version: 'daily-history-v2' });
      }
    });
    it.each([24, 25, 64])(
      'stores all %i x two price slots from one data GET in batches of at most 20 SQL',
      async (n) => {
        const f = await expandedDaily();
        let maxBatch = 0;
        const db = new Proxy(env.PRIVATE_DB, {
          get(target, key) {
            const v = Reflect.get(target, key);
            return key === 'batch'
              ? async (s: D1PreparedStatement[]) => {
                  maxBatch = Math.max(maxBatch, s.length);
                  return target.batch(s);
                }
              : typeof v === 'function'
                ? v.bind(target)
                : v;
          },
        });
        const { result, get } = await day({ ...env, PRIVATE_DB: db }, f, gpuTime, rentalHtml(n));
        expect(result.state).toBe('complete');
        expect(get).toHaveBeenCalledTimes(3);
        expect(maxBatch).toBeLessThanOrEqual(20);
        expect(await events()).toHaveLength(n * 2);
        const r = await env.PRIVATE_DB.prepare(
          'SELECT record_count FROM personal_daily_runs',
        ).first('record_count');
        expect(r).toBe(n * 2);
        await exportDailyHistory(env, 'highreso_public', gpuTime);
        const head = await dailyJSON(env.EVIDENCE, dailyRoot('highreso_public') + 'catalog.json'),
          m = DailyManifest.parse(
            await dailyJSON(
              env.EVIDENCE,
              dailyRoot('highreso_public') + 'runs/' + head.latest_run_id + '.json',
            ),
          );
        expect(m.chunks.every((p) => p.bytes <= 131072)).toBe(true);
        expect(m.chunks.reduce((s, p) => s + p.bytes, 0)).toBeLessThanOrEqual(524288);
      },
    );
    it('continues lineage after permission renewal but splits scope, method and unit/normalization declarations', async () => {
      const f = await expandedDaily();
      await day(env, f, gpuTime, rentalHtml(1));
      const renewed = structuredClone(f.c);
      renewed.decision.exception_id = 'renewed';
      renewed.decision.risk_acceptance_ref = 'synthetic renewed review';
      renewed.config.terms.version += '-renewed';
      renewed.config.source.policy.version += '-renewed';
      renewed.config_sha256 = await hash(stable(renewed.config));
      renewed.decision.terms.version = renewed.config.terms.version;
      const next = {
        c: PersonalDailySchema.parse(renewed),
        pin: { ...f.pin, contract_hash: await hash(stable(renewed)) },
      };
      expect(await hash(stable(dailySeriesDefinition(f.c)))).toBe(
        await hash(stable(dailySeriesDefinition(next.c))),
      );
      await day(env, next, '2026-10-19T01:00:00.000Z', rentalHtml(1));
      expect(
        (await events()).filter((r) => r.day === '2026-10-19').map((r) => r.change_kind),
      ).toEqual(['reobserved', 'reobserved']);
      for (const change of ['gpu', 'models', 'method', 'units', 'normalization']) {
        const c = structuredClone(next.c);
        if (change === 'gpu' && c.config.scope.kind === 'highreso_public')
          c.config.scope.gpu_counts = [2];
        if (change === 'models' && 'models' in c.config.scope) c.config.scope.models = ['H100'];
        if (change === 'method') {
          c.config.method_version = 'domestic-gpu-html-v1';
          delete c.config.limits.capture_record_limit;
          c.config.limits.max_input_rows = 100;
          c.config.source.max_records = 48;
          if (c.config.scope.kind === 'highreso_public') delete c.config.scope.gpu_counts;
        }
        if (change === 'units' || change === 'normalization')
          c.comparison = {
            normalization_version:
              change === 'normalization'
                ? 'synthetic-normalizer-v2'
                : 'domestic-gpu-normalization-v1',
            unit_definition:
              change === 'units'
                ? 'synthetic-new-unit-definition'
                : 'JPY:node_hour|month:instance:v1',
            review_ref: 'SYNTHETIC reviewed definition only',
          };
        c.config_sha256 = await hash(stable(c.config));
        expect(await hash(stable(dailySeriesDefinition(PersonalDailySchema.parse(c))))).not.toBe(
          await hash(stable(dailySeriesDefinition(next.c))),
        );
      }
      const scoped = structuredClone(next.c);
      if (scoped.config.scope.kind === 'highreso_public') scoped.config.scope.gpu_counts = [2];
      scoped.config_sha256 = await hash(stable(scoped.config));
      await day(
        env,
        { c: scoped, pin: { ...f.pin, contract_hash: await hash(stable(scoped)) } },
        '2026-10-20T01:00:00.000Z',
        rentalHtml(1),
      );
      expect((await events()).filter((r) => r.day === '2026-10-20')).toHaveLength(0);
    });
    it.each(['403', '429', 'terms', 'DOM', 'limit'])(
      'does not certify disappearance after %s failure',
      async (failure) => {
        const f = await expandedDaily();
        await day(env, f, gpuTime, rentalHtml(1));
        const at = '2026-10-19T01:00:00.000Z';
        await heartbeat(env, 'highreso_public', at);
        const get: typeof fetch = async (url) => {
          const u = String(url);
          if (failure === '403' || failure === '429')
            return new Response(null, { status: Number(failure) });
          return new Response(
            u.endsWith('/robots.txt')
              ? robots
              : u.endsWith('/terms')
                ? terms + (failure === 'terms' ? 'changed' : '')
                : failure === 'DOM'
                  ? '<table>changed</table>'
                  : rentalHtml(65),
            { headers: { 'content-type': u.endsWith('/robots.txt') ? 'text/plain' : 'text/html' } },
          );
        };
        await expect(
          collectDaily(env, f.c, f.pin, { now: () => at, allow_network: true, fetcher: get }),
        ).rejects.toThrow();
        expect((await events()).filter((r) => r.change_kind === 'not_seen')).toHaveLength(0);
      },
    );
    it('preserves Rebro duplicates; a changed content key is a new public case, not a transaction correction', async () => {
      const f = await expandedDaily('rebro_public');
      await day(env, f, gpuTime, casesHtml());
      await day(env, f, '2026-10-19T01:00:00.000Z', casesHtml(['101円', '202円']));
      const rows = await events();
      expect(
        rows
          .filter((r) => r.day === '2026-10-19')
          .map((r) => r.change_kind)
          .sort(),
      ).toEqual(['first_seen', 'not_seen', 'reobserved']);
      for (const r of rows.filter((r) => r.domain_json !== null))
        expect(JSON.parse(String(r.domain_json)).case_identity_basis).toBe(
          'public_content_occurrence_not_transaction',
        );
    });
  },
);
