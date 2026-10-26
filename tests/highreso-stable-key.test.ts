import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { highresoReader } from '../src/admin-highreso';
import { ResearchConfigSchema } from '../src/research/schema';
import candidate from '../config/proposals/highreso-stable-key.json';
import { localEnv } from '../scripts/local-env';
import { collectResearchPage, readResearchRun } from '../src/research/pipeline';
import { parsePublicGpu } from '../src/research/public-gpu-html';
import { HIGHRESO_METHOD, highresoContent } from '../src/research/highreso-identity';
import { resolveHighresoHistory } from '../src/research/highreso-history';
import { comparePublicGpuRuns, readPublicGpuHistory } from '../src/research/daily-series';
import { adoptReviewedResearchConfig, recordDeletion } from '../src/research/retention';
import { hash, stable } from '../src/util';
import { publicGpuSource, gpuOptions, gpuTime, gpuFetcher } from './public-gpu-helpers';

// Entirely invented markup and values; never a copy of a real price page.
function html(ids = ['fake-ubs22-a', 'fake-ubs22-z'], amount = '123円') {
  return `<html><body><h3>Artificial A100 fixture</h3><p>GPU：NVIDIA A100 80GB x 1枚</p>
  <table><tr><td>インスタンス</td><td>従量課金 [1h・台]</td><td>月額課金 [月・台]</td><td>ストレージ</td></tr>
  ${ids.map((id) => `<tr><td>${id}</td><td>${amount}</td><td>456円</td><td>500GB</td></tr>`).join('')}</table></body></html>`;
}
const query = { kind: 'highreso_public' } as const;
const day = (n: number) => `2026-10-${18 + n}T01:00:00.000Z`;
describe('Highreso stable identity (synthetic only)', () => {
  let local: Awaited<ReturnType<typeof localEnv>>;
  beforeEach(async () => {
    local = await localEnv('test');
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await local?.mf.dispose();
  });
  async function config() {
    const c = await publicGpuSource();
    c.method_version = HIGHRESO_METHOD;
    return c;
  }
  it('hashes only approved identity attributes and sorts duplicate instances independently of DOM order or price', async () => {
    const c = await config();
    const first = await parsePublicGpu(c, html(), gpuTime, true);
    const second = await parsePublicGpu(
      c,
      html(['renamed-ubs22-y', 'renamed-ubs22-b'], '999円'),
      day(1),
      true,
    );
    expect(first.records.map((r) => r.record_key).sort()).toEqual(
      second.records.map((r) => r.record_key).sort(),
    );
    const item = first.records[0];
    expect(item.record_key).toBe(`hr:v2:${await hash(stable(highresoContent(item)))}:1`);
    expect(
      second.records.find(
        (r) => r.instance_id === 'renamed-ubs22-b' && r.offer.unit === item.offer.unit,
      )?.record_key,
    ).toBe(item.record_key);
    await expect(parsePublicGpu(c, html(['fake-no-os']), gpuTime, true)).rejects.toThrow(
      'highreso_os_unrecognized',
    );
    const otherOS = await parsePublicGpu(c, html(['fake-ubs24-a']), gpuTime, true);
    expect(otherOS.records[0].record_key).not.toBe(item.record_key);
  });
  it('bridges v2 once, preserves old keys, records renames and prices, then reobserves and records actual absence/reappearance', async () => {
    const legacy = await publicGpuSource();
    const first = await collectResearchPage(
      local.env,
      legacy,
      query,
      gpuTime,
      gpuOptions(legacy, gpuTime, html()),
    );
    const oldRows = (await readResearchRun(local.env, legacy, first.run_id, gpuOptions(legacy)))
      .results;
    const digest = await hash(stable(legacy));
    const c = structuredClone(legacy);
    c.method_version = HIGHRESO_METHOD;
    c.source.policy.version += '-identity-v3';
    c.history_access = [
      { config_hash: digest, approval_ref: 'synthetic identity boundary review' },
    ];
    await adoptReviewedResearchConfig(local.env, c, digest, day(1), c.terms.version);
    const runs = [];
    for (const [i, body] of [
      html(),
      html(['renamed-ubs22-b', 'renamed-ubs22-y']),
      html(['renamed-ubs22-b', 'renamed-ubs22-y']),
      html(['renamed-ubs22-b', 'renamed-ubs22-y'], '246円'),
      html([]),
      html([]),
      html(['renamed-ubs22-b', 'renamed-ubs22-y'], '246円'),
    ].entries()) {
      const at = day(i + 1);
      const run = await collectResearchPage(local.env, c, query, at, gpuOptions(c, at, body));
      runs.push({
        run,
        rows: (await readResearchRun(local.env, c, run.run_id, gpuOptions(c, at))).results,
      });
    }
    expect(runs[0].rows).toHaveLength(4);
    expect(runs[0].rows.every((r) => r.change_kind === 'reobserved')).toBe(true);
    expect(
      runs[0].rows.every((r) =>
        oldRows.some((old) => old.observation_id === r.previous_observation_id),
      ),
    ).toBe(true);
    expect(
      runs[1].rows.every(
        (r) => r.change_kind === 'revised' && JSON.parse(r.domain_json).instance_id_changed_from,
      ),
    ).toBe(true);
    expect(
      runs[2].rows.every(
        (r) =>
          r.change_kind === 'reobserved' && !JSON.parse(r.domain_json).instance_id_changed_from,
      ),
    ).toBe(true);
    expect(runs[3].rows.filter((r) => r.change_kind === 'revised')).toHaveLength(2);
    expect(runs[4].rows.every((r) => r.change_kind === 'not_seen')).toBe(true);
    expect(runs[5].rows).toHaveLength(0);
    expect(runs[6].rows.every((r) => r.change_kind === 'reappeared')).toBe(true);
    expect(
      (await readResearchRun(local.env, c, first.run_id, gpuOptions(c, day(7)))).results,
    ).toEqual(oldRows);
    const comparison = await comparePublicGpuRuns(
      local.env,
      c,
      first.run_id,
      runs[2].run.run_id,
      gpuOptions(c, day(7)),
    );
    expect(comparison.changes).toHaveLength(4);
    expect(
      comparison.changes.every(
        (r) => r.state === 'instance_id_changed' && r.identity_change_label === '型番変更',
      ),
    ).toBe(true);
    const price = await comparePublicGpuRuns(
      local.env,
      c,
      runs[2].run.run_id,
      runs[3].run.run_id,
      gpuOptions(c, day(7)),
    );
    expect(price.changes.filter((r) => r.state === 'reported_price_changed')).toHaveLength(2);
    expect((await local.env.PRIVATE_DB.prepare('PRAGMA foreign_key_check').all()).results).toEqual(
      [],
    );
  });
  it('does not use a restored/deleted v2 run for new identity lineage', async () => {
    const legacy = await publicGpuSource();
    const run = await collectResearchPage(
      local.env,
      legacy,
      query,
      gpuTime,
      gpuOptions(legacy, gpuTime, html()),
    );
    const digest = await hash(stable(legacy)),
      c = structuredClone(legacy);
    c.method_version = HIGHRESO_METHOD;
    c.source.policy.version += '-identity-v3';
    c.history_access = [{ config_hash: digest, approval_ref: 'synthetic review' }];
    await adoptReviewedResearchConfig(local.env, c, digest, day(1), c.terms.version);
    await recordDeletion(local.env, c.source.source_id, run.run_id, day(1), 'expired');
    await expect(
      collectResearchPage(local.env, c, query, day(1), gpuOptions(c, day(1), html())),
    ).rejects.toThrow('research_run_deleted');
  });
  it('projects approved links as renames, suppresses the old false absence and retains forensic fields', async () => {
    const snapshots = [
      {
        rows: [
          {
            observation_id: 'old',
            previous_observation_id: null,
            record_key: 'old-key',
            domain_json: '',
            change_kind: 'reobserved',
            observed_at: gpuTime,
          },
        ],
      },
      {
        rows: [
          {
            observation_id: 'new',
            previous_observation_id: null,
            record_key: 'new-key',
            domain_json: '',
            change_kind: 'first_seen',
            observed_at: day(1),
          },
          {
            observation_id: 'absent',
            previous_observation_id: 'old',
            record_key: 'old-key',
            domain_json: '{}',
            change_kind: 'not_seen',
            observed_at: day(1),
          },
        ],
      },
    ];
    const c = await publicGpuSource();
    const parsed = await parsePublicGpu(c, html(['fake-ubs22-a']), gpuTime, true);
    snapshots[0].rows[0].domain_json = JSON.stringify(parsed.records[0]);
    snapshots[1].rows[0].domain_json = JSON.stringify({
      ...parsed.records[0],
      instance_id: 'renamed-ubs22-b',
    });
    const env = {
      PRIVATE_DB: {
        prepare: () => ({
          bind: () => ({
            all: async () => ({
              results: [{ from_observation_id: 'old', to_observation_id: 'new' }],
            }),
          }),
        }),
      },
    } as unknown as Parameters<typeof resolveHighresoHistory>[0];
    await resolveHighresoHistory(env, snapshots);
    expect(snapshots[0].rows[0].record_key).toBe('new-key');
    expect(snapshots[1].rows).toHaveLength(1);
    expect(snapshots[1].rows[0]).toMatchObject({
      change_kind: 'revised',
      stored_change_kind: 'first_seen',
    });
    expect(JSON.parse(snapshots[1].rows[0].domain_json).instance_id_changed_from).toBe(
      'fake-ubs22-a',
    );
  });
  it('keeps repaired legacy history continuous in private reads and the Admin after v3 reobservation', async () => {
    const legacy = await publicGpuSource();
    const bodies = [html(), html(), html(['renamed-ubs22-b', 'renamed-ubs22-y'])];
    const collected = [];
    const transport = vi.spyOn(globalThis, 'fetch');
    const options = (c: typeof legacy, at: string, body = html()) => {
      transport.mockImplementation(gpuFetcher('highreso_public', body));
      return { current_terms_version: c.terms.version, now: () => at, allow_network: true };
    };
    // Mock transport only, so Admin can exercise its real/synthetic filter locally.
    for (const [i, body] of bodies.entries()) {
      collected.push(
        await collectResearchPage(local.env, legacy, query, day(i), options(legacy, day(i), body)),
      );
    }
    const old = (
      await readResearchRun(local.env, legacy, collected[1].run_id, options(legacy, day(2)))
    ).results;
    const incident = (
      await readResearchRun(local.env, legacy, collected[2].run_id, options(legacy, day(2)))
    ).results;
    const next = incident.filter((r) => r.change_kind === 'first_seen');
    expect(incident).toHaveLength(8);
    for (let i = 0; i < old.length; i++) {
      await local.env.PRIVATE_DB.prepare(
        'INSERT INTO research_identity_links VALUES (?,?,?,?,?,?,?)',
      )
        .bind(
          'synthetic-link-' + i,
          'highreso_public',
          old[i].observation_id,
          next[i].observation_id,
          'content_match_v1',
          HIGHRESO_METHOD,
          day(2),
        )
        .run();
    }
    const c = structuredClone(legacy),
      digest = await hash(stable(legacy));
    c.method_version = HIGHRESO_METHOD;
    c.source.policy.version += '-identity-v3';
    c.history_access = [{ config_hash: digest, approval_ref: 'synthetic identity review' }];
    await adoptReviewedResearchConfig(local.env, c, digest, day(3), c.terms.version);
    await collectResearchPage(local.env, c, query, day(3), options(c, day(3), bodies[2]));
    const prices = await highresoReader(local.env, c, day(3)).highresoLatestPrices();
    expect(prices.prices).toHaveLength(4);
    expect(
      prices.prices.every(
        (r) =>
          r.first_seen === day(0) &&
          r.last_changed === day(2) &&
          r.identity_change_label === '型番変更' &&
          r.instance_id_changed_from,
      ),
    ).toBe(true);
    const history = await readPublicGpuHistory(
      local.env,
      c,
      { from: day(0), to: day(3), synthetic: false },
      options(c, day(3)),
    );
    expect(history.snapshots.map((snapshot) => snapshot.rows.length)).toEqual([4, 4, 4, 4]);
    const comparison = await comparePublicGpuRuns(
      local.env,
      c,
      collected[1].run_id,
      collected[2].run_id,
      options(c, day(3)),
    );
    expect(comparison.changes.every((r) => r.state === 'instance_id_changed')).toBe(true);
    expect(
      (await readResearchRun(local.env, c, collected[2].run_id, options(c, day(3)))).results,
    ).toEqual(incident);
  });
  it('validates the staged config and rejects unapproved or cross-scope identity upgrades', async () => {
    expect(ResearchConfigSchema.parse(candidate).method_version).toBe(HIGHRESO_METHOD);
    const legacy = await publicGpuSource();
    await collectResearchPage(
      local.env,
      legacy,
      query,
      gpuTime,
      gpuOptions(legacy, gpuTime, html()),
    );
    const digest = await hash(stable(legacy)),
      c = structuredClone(legacy);
    c.method_version = HIGHRESO_METHOD;
    await expect(
      adoptReviewedResearchConfig(local.env, c, digest, day(1), c.terms.version),
    ).rejects.toThrow('research_policy_changed');
    c.source.policy.version += '-identity-v3';
    c.history_access = [{ config_hash: digest, approval_ref: 'synthetic review' }];
    if (c.scope.kind === 'highreso_public') c.scope.models = ['A100'];
    await expect(
      adoptReviewedResearchConfig(local.env, c, digest, day(1), c.terms.version),
    ).rejects.toThrow('research_history_scope_unreviewed');
  });
  it('does not merge different historical conditions when a legacy instance name was reused', async () => {
    const legacy = await publicGpuSource();
    const initial = html(['fake-ubs22-a']);
    const changed = initial.replace('500GB', '1000GB');
    const before = await collectResearchPage(
      local.env,
      legacy,
      query,
      day(0),
      gpuOptions(legacy, day(0), initial),
    );
    await collectResearchPage(
      local.env,
      legacy,
      query,
      day(1),
      gpuOptions(legacy, day(1), changed),
    );
    const digest = await hash(stable(legacy)),
      c = structuredClone(legacy);
    c.method_version = HIGHRESO_METHOD;
    c.source.policy.version += '-identity-v3';
    c.history_access = [{ config_hash: digest, approval_ref: 'synthetic identity review' }];
    await adoptReviewedResearchConfig(local.env, c, digest, day(2), c.terms.version);
    const after = await collectResearchPage(
      local.env,
      c,
      query,
      day(2),
      gpuOptions(c, day(2), changed),
    );
    const comparison = await comparePublicGpuRuns(
      local.env,
      c,
      before.run_id,
      after.run_id,
      gpuOptions(c, day(2)),
    );
    expect(comparison.changes).toHaveLength(4);
    expect(comparison.changes.filter((r) => r.state === 'seen')).toHaveLength(2);
    expect(comparison.changes.filter((r) => r.state === 'not_seen')).toHaveLength(2);
  });
});
