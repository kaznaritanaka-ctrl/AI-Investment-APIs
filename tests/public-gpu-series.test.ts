import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { localEnv } from '../scripts/local-env';
import {
  collectResearchPage,
  readResearchRun,
  purgeResearchRun,
  reconcileResearchRun,
} from '../src/research/pipeline';
import {
  comparePublicGpuRuns,
  dailySeriesDefinition,
  readPublicGpuHistory,
} from '../src/research/daily-series';
import {
  adoptReviewedResearchConfig,
  requestResearchDeletion,
  runDeletionKey,
} from '../src/research/retention';
import { hash, stable } from '../src/util';
import { publicGpuSource, gpuHtml, gpuOptions, gpuTime } from './public-gpu-helpers';

const query = { kind: 'highreso_public' } as const;
const nextDay = '2026-10-19T01:00:00.000Z';
describe('private GPU daily series, lifecycle and history (synthetic)', () => {
  let local: Awaited<ReturnType<typeof localEnv>>;
  beforeEach(async () => {
    local = await localEnv('test');
  });
  afterEach(async () => {
    await local?.mf.dispose();
  });
  it('preserves A -> absent -> still absent -> reappeared without invented prices or duplicate transitions', async () => {
    const c = await publicGpuSource();
    const full = gpuHtml('highreso_public');
    const empty = full.replace(/<tr><td>synthetic-[\s\S]*?<\/tr>/g, '');
    const runs = [];
    for (const [i, body] of [full, empty, empty, full].entries()) {
      const at = `2026-10-${18 + i}T01:00:00.000Z`;
      runs.push(await collectResearchPage(local.env, c, query, at, gpuOptions(c, at, body)));
    }
    const at = '2026-10-21T02:00:00.000Z';
    const history = await readPublicGpuHistory(
      local.env,
      c,
      { from: gpuTime, to: at, synthetic: true },
      gpuOptions(c, at),
    );
    expect(history.snapshots.map((s) => s.rows.length)).toEqual([4, 0, 4, 4]);
    expect(history.snapshots[0].rows.every((r) => r.change_kind === 'reappeared')).toBe(true);
    expect(
      history.snapshots[0].rows.every((r) =>
        history.snapshots[2].rows.some((p) => p.observation_id === r.previous_observation_id),
      ),
    ).toBe(true);
    expect(history.snapshots[2].rows.every((r) => r.change_kind === 'not_seen')).toBe(true);
    expect(
      history.snapshots[2].rows.every((r) => !String(r.domain_json).includes('amount_decimal')),
    ).toBe(true);
    expect(history.source.license_url).toBeNull();
    expect(history.source.attribution_text).toBe(c.source.attribution_text);
    const bounded = await readPublicGpuHistory(
      local.env,
      c,
      { from: gpuTime, to: at, synthetic: true, limit: 1 },
      gpuOptions(c, at),
    );
    expect(bounded.truncated).toBe(true);
    expect(bounded.snapshots).toHaveLength(1);
    await expect(
      readPublicGpuHistory(
        local.env,
        c,
        { from: at, to: gpuTime, synthetic: true },
        gpuOptions(c, at),
      ),
    ).rejects.toThrow('daily_history_window');
    const compared = await comparePublicGpuRuns(
      local.env,
      c,
      runs[0].run_id,
      runs[1].run_id,
      gpuOptions(c, at),
    );
    expect(compared.changes.every((r) => r.state === 'not_seen' && r.change_percent === null)).toBe(
      true,
    );
  });
  it('compares reported quotes while preserving uncertainty about economic conditions and missing/zero baselines', async () => {
    const c = await publicGpuSource();
    const a = await collectResearchPage(local.env, c, query, gpuTime, gpuOptions(c));
    const body = gpuHtml('highreso_public').replace('1,234.56円', '2,469.12円');
    const b = await collectResearchPage(local.env, c, query, nextDay, gpuOptions(c, nextDay, body));
    const result = await comparePublicGpuRuns(
      local.env,
      c,
      a.run_id,
      b.run_id,
      gpuOptions(c, nextDay),
    );
    expect(result.changes.find((r) => r.record_key === 'synthetic-a100:node_hour')).toMatchObject({
      state: 'reported_price_changed',
      change_percent: '100',
      economic_comparison: { state: 'not_comparable', change_percent: null },
    });
    expect(result.changes.find((r) => r.record_key === 'synthetic-h100:node_hour')).toMatchObject({
      state: 'unchanged',
      change_percent: null,
    });
    const at = '2026-10-20T01:00:00.000Z';
    const d = await collectResearchPage(
      local.env,
      c,
      query,
      at,
      gpuOptions(c, at, body.replace('777GB', '888GB')),
    );
    const changed = await comparePublicGpuRuns(local.env, c, b.run_id, d.run_id, gpuOptions(c, at));
    expect(changed.changes.find((r) => r.record_key === 'synthetic-a100:node_hour')).toMatchObject({
      state: 'conditions_changed',
      change_percent: null,
    });
    await expect(
      comparePublicGpuRuns(local.env, c, b.run_id, a.run_id, gpuOptions(c, at)),
    ).rejects.toThrow('daily_series_mismatch');
  });
  it('does not calculate percentage changes from a zero or missing quoted price', async () => {
    const c = await publicGpuSource();
    const initial = gpuHtml('highreso_public').replace('1,234.56円', '0円');
    const a = await collectResearchPage(
      local.env,
      c,
      query,
      gpuTime,
      gpuOptions(c, gpuTime, initial),
    );
    const b = await collectResearchPage(local.env, c, query, nextDay, gpuOptions(c, nextDay));
    const result = await comparePublicGpuRuns(
      local.env,
      c,
      a.run_id,
      b.run_id,
      gpuOptions(c, nextDay),
    );
    expect(result.changes.find((r) => r.record_key === 'synthetic-a100:node_hour')).toMatchObject({
      state: 'reported_price_changed',
      change_percent: null,
    });
  });
  it('keeps explicit reviewed renewals in one series, splits method/scope changes, and preserves original deadlines', async () => {
    const c = await publicGpuSource();
    const a = await collectResearchPage(local.env, c, query, gpuTime, gpuOptions(c));
    const digest = await hash(stable(c));
    const renewed = structuredClone(c);
    renewed.source.policy.version += '-renewed';
    renewed.history_access = [{ config_hash: digest, approval_ref: 'synthetic-history-approval' }];
    renewed.retention.normalized_days = 365;
    expect(dailySeriesDefinition(renewed)).toEqual(dailySeriesDefinition(c));
    const other = structuredClone(c);
    if (other.scope.kind === 'highreso_public') other.scope.models = ['A100'];
    expect(dailySeriesDefinition(other)).not.toEqual(dailySeriesDefinition(c));
    other.method_version = 'domestic-gpu-html-v1';
    expect(dailySeriesDefinition(other)).not.toEqual(dailySeriesDefinition(c));
    await adoptReviewedResearchConfig(local.env, renewed, digest, nextDay, renewed.terms.version);
    const b = await collectResearchPage(
      local.env,
      renewed,
      query,
      nextDay,
      gpuOptions(renewed, nextDay),
    );
    const result = await comparePublicGpuRuns(
      local.env,
      renewed,
      a.run_id,
      b.run_id,
      gpuOptions(renewed, nextDay),
    );
    expect(result.changes.every((r) => r.state === 'unchanged')).toBe(true);
    const rows = (await readResearchRun(local.env, renewed, b.run_id, gpuOptions(renewed, nextDay)))
      .results;
    expect(rows.every((r) => r.change_kind === 'reobserved')).toBe(true);
    expect(
      await local.env.PRIVATE_DB.prepare(
        'SELECT normalized_expires_at FROM research_runs WHERE run_id=?',
      )
        .bind(a.run_id)
        .first(),
    ).toEqual({ normalized_expires_at: '2027-01-16T01:00:00.000Z' });
  });
  it('blocks expired empty snapshots and deleted/restored history; preserves immutable retention assessments', async () => {
    const c = await publicGpuSource();
    c.retention.normalized_days = 1;
    const empty = gpuHtml('highreso_public').replace(/<tr><td>synthetic-[\s\S]*?<\/tr>/g, '');
    const r = await collectResearchPage(
      local.env,
      c,
      query,
      gpuTime,
      gpuOptions(c, gpuTime, empty),
    );
    await expect(
      readPublicGpuHistory(
        local.env,
        c,
        { from: gpuTime, to: nextDay, synthetic: true },
        gpuOptions(c, nextDay),
      ),
    ).rejects.toThrow('daily_history_unavailable');
    await requestResearchDeletion(local.env, r.run_id, nextDay, {
      basis_ref: 'synthetic-delete',
      all_copies_delete_by: '2026-10-26T01:00:00.000Z',
    });
    await purgeResearchRun(local.env, r.run_id, nextDay, { time_travel_days: 7 });
    await local.env.EVIDENCE.put(
      `research/${c.source.source_id}/${r.run_id}/0.json`,
      'synthetic-restored-evidence',
    );
    await reconcileResearchRun(local.env, c, r.run_id, nextDay, c.terms.version);
    expect(
      await local.env.EVIDENCE.head(`research/${c.source.source_id}/${r.run_id}/0.json`),
    ).toBeNull();
    expect(
      await local.env.EVIDENCE.head(runDeletionKey(c.source.source_id, r.run_id)),
    ).not.toBeNull();
    await expect(
      local.env.PRIVATE_DB.prepare('DELETE FROM research_retention_assessments').run(),
    ).rejects.toThrow();
    expect((await local.env.PRIVATE_DB.prepare('PRAGMA foreign_key_check').all()).results).toEqual(
      [],
    );
  });
});
