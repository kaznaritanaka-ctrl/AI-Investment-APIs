import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { localEnv } from '../scripts/local-env';
import { applyMigrations } from '../scripts/migrations';
import {
  collectResearchPage,
  readResearchRun,
  purgeResearchEvidence,
  purgeResearchRun,
} from '../src/research/pipeline';
import { revokeResearchSource } from '../src/research/retention';
import { collectPublicGpuDay } from '../src/research/public-gpu';
import { publicGpuSource, gpuTime, gpuOptions, gpuHtml, gpuFetcher } from './public-gpu-helpers';
import { researchSource, eiaQuery, opts, eiaPage, researchTime } from './research-helpers';
import { publicGpuEndpoints } from '../src/research/public-gpu-contract';

describe('private GPU acquisition and history (synthetic local D1/R2)', () => {
  let local: Awaited<ReturnType<typeof localEnv>>;
  beforeEach(async () => {
    local = await localEnv('test');
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await local?.mf.dispose();
  });
  const query = { kind: 'highreso_public' } as const;
  it('persists duplicate public cases, reobserves unchanged content, and never calls disappearance a sale', async () => {
    const c = await publicGpuSource('rebro_public');
    const duplicate =
      '<tr><td>2025年2月</td><td>NVIDIA A100 40GB PCIe</td><td>3枚</td><td>234,567円</td><td>unused</td></tr>';
    const html = gpuHtml('rebro_public').replace('</tbody>', duplicate + '</tbody>');
    for (const day of ['18', '19']) {
      const at = `2026-10-${day}T01:00:00.000Z`;
      const run = await collectResearchPage(
        local.env,
        c,
        { kind: 'rebro_public' },
        at,
        gpuOptions(c, at, html),
      );
      const rows = (await readResearchRun(local.env, c, run.run_id, gpuOptions(c, at))).results;
      expect(rows).toHaveLength(3);
      if (day === '19') expect(rows.every((r) => r.change_kind === 'reobserved')).toBe(true);
    }
    const at = '2026-10-20T01:00:00.000Z';
    const run = await collectResearchPage(
      local.env,
      c,
      { kind: 'rebro_public' },
      at,
      gpuOptions(c, at, gpuHtml('rebro_public')),
    );
    const absent = (
      await readResearchRun(local.env, c, run.run_id, gpuOptions(c, at))
    ).results.filter((r) => r.change_kind === 'not_seen');
    expect(absent).toHaveLength(1);
    expect(String(absent[0].domain_json)).not.toMatch(
      /execution_report|transaction_at|amount_decimal/,
    );
  });
  it('fails closed before any HTTP/storage and keeps production unintegrated', async () => {
    const c = await publicGpuSource();
    c.source.policy.rights.automated_collection = 'review_required';
    const fetcher = vi.fn();
    await expect(
      collectResearchPage(local.env, c, query, gpuTime, {
        ...gpuOptions(c),
        fetcher,
        allow_network: true,
      }),
    ).rejects.toThrow('policy_blocked');
    expect(fetcher).not.toHaveBeenCalled();
    expect((await local.env.EVIDENCE.list()).objects).toHaveLength(0);
    expect(
      await local.env.PRIVATE_DB.prepare('SELECT COUNT(*) n FROM research_sources').first(),
    ).toEqual({ n: 0 });
    await expect(
      collectResearchPage(
        { ...local.env, ENVIRONMENT: 'production' },
        await publicGpuSource(),
        query,
        gpuTime,
        gpuOptions(c),
      ),
    ).rejects.toThrow('research_production_not_integrated');
    await expect(
      collectResearchPage(
        { ...local.env, ENVIRONMENT: 'development' },
        await publicGpuSource(),
        query,
        gpuTime,
        gpuOptions(c),
      ),
    ).rejects.toThrow('research_synthetic_boundary');
  });
  it('keeps only GPU projection in its own table/R2, no raw HTML, public data or mutable history', async () => {
    const c = await publicGpuSource();
    const result = await collectResearchPage(local.env, c, query, gpuTime, gpuOptions(c));
    expect(result.state).toBe('complete');
    const rows = (await readResearchRun(local.env, c, result.run_id, gpuOptions(c))).results;
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({ observed_at: gpuTime, method_version: 'domestic-gpu-html-v2' });
    expect(
      await local.env.PRIVATE_DB.prepare('SELECT COUNT(*) n FROM research_observations').first(),
    ).toEqual({ n: 0 });
    expect(
      await local.env.PUBLIC_DB.prepare('SELECT COUNT(*) n FROM published_observations').first(),
    ).toEqual({ n: 0 });
    expect(
      (
        await local.env.PUBLIC_DB.prepare(
          "SELECT name FROM sqlite_master WHERE name LIKE 'research_%'",
        ).all()
      ).results,
    ).toEqual([]);
    const objects = (await local.env.EVIDENCE.list({ prefix: 'research/' })).objects;
    expect(objects).toHaveLength(1);
    const stored = await (await local.env.EVIDENCE.get(objects[0].key))!.text();
    expect(stored).not.toMatch(/<table|SYNTHETIC_DO_NOT_PERSIST|counterparty/);
    expect(JSON.parse(stored)).toMatchObject({
      synthetic: true,
      payload_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      query_hash: expect.any(String),
      config_hash: expect.any(String),
    });
    await expect(
      local.env.PRIVATE_DB.prepare(
        "UPDATE research_gpu_observations SET record_key='changed'",
      ).run(),
    ).rejects.toThrow();
    await expect(
      local.env.PRIVATE_DB.prepare('DELETE FROM research_gpu_observations').run(),
    ).rejects.toThrow();
  });
  it('records same-price reobservation, large revisions, condition changes and not_seen without a sale', async () => {
    const c = await publicGpuSource();
    const html = gpuHtml('highreso_public');
    for (const day of ['18', '19']) {
      const at = `2026-10-${day}T01:00:00.000Z`;
      await collectResearchPage(local.env, c, query, at, gpuOptions(c, at));
    }
    expect(
      (
        await local.env.PRIVATE_DB.prepare(
          "SELECT change_kind FROM research_gpu_observations WHERE observed_at='2026-10-19T01:00:00.000Z'",
        ).all()
      ).results.every((r) => r.change_kind === 'reobserved'),
    ).toBe(true);
    const changed = '2026-10-20T01:00:00.000Z';
    const r = await collectResearchPage(
      local.env,
      c,
      query,
      changed,
      gpuOptions(c, changed, html.replace('1,234.56円', '9,876.54円').replace('777GB', '888GB')),
    );
    const changes = (await readResearchRun(local.env, c, r.run_id, gpuOptions(c, changed))).results;
    expect(
      changes
        .filter((x) => String(x.record_key).startsWith('synthetic-a100'))
        .every((x) => x.change_kind === 'revised'),
    ).toBe(true);
    const removed = '2026-10-21T01:00:00.000Z';
    const fewer = html.replace(/<tr><td>synthetic-h100[\s\S]*?<\/tr>/, '');
    const next = await collectResearchPage(
      local.env,
      c,
      query,
      removed,
      gpuOptions(c, removed, fewer),
    );
    const tombstones = (
      await readResearchRun(local.env, c, next.run_id, gpuOptions(c, removed))
    ).results.filter((x) => x.change_kind === 'not_seen');
    expect(tombstones).toHaveLength(2);
    for (const row of tombstones) {
      expect(JSON.parse(String(row.domain_json))).toMatchObject({
        listing_state: 'not_seen',
        absence_basis: 'same_scope_complete_page',
      });
      expect(row.domain_json).not.toMatch(/execution_report|transaction_at|amount_decimal/);
    }
    const again = await collectResearchPage(
      local.env,
      c,
      query,
      removed,
      gpuOptions(c, removed, 'invalid'),
    );
    expect(again).toEqual(next);
    const sameDay = '2026-10-21T02:00:00.000Z';
    await expect(
      collectResearchPage(local.env, c, query, sameDay, gpuOptions(c, sameDay)),
    ).rejects.toThrow('research_scope_changed_or_daily_limit');
  });
  it('quarantines truncated/schema drift and stops later acquisition; old valid history remains readable', async () => {
    const c = await publicGpuSource();
    const good = await collectResearchPage(local.env, c, query, gpuTime, gpuOptions(c));
    const at = '2026-10-19T01:00:00.000Z';
    await expect(
      collectResearchPage(
        local.env,
        c,
        query,
        at,
        gpuOptions(c, at, gpuHtml('highreso_public').replaceAll('</table>', '')),
      ),
    ).rejects.toThrow('public_gpu_table_schema_changed');
    expect(
      await local.env.PRIVATE_DB.prepare(
        "SELECT COUNT(*) n FROM research_gpu_observations WHERE change_kind='not_seen'",
      ).first(),
    ).toEqual({ n: 0 });
    expect(
      (await readResearchRun(local.env, c, good.run_id, gpuOptions(c, at))).results,
    ).toHaveLength(4);
    const fetcher = vi.fn();
    const tomorrow = '2026-10-20T01:00:00.000Z';
    await expect(
      collectResearchPage(local.env, c, query, tomorrow, {
        now: () => tomorrow,
        current_terms_version: c.terms.version,
        allow_network: true,
        fetcher,
      }),
    ).rejects.toThrow('public_gpu_source_review_required');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('isolates source failures and reports machine-readable outcomes without delivery', async () => {
    const a = await publicGpuSource(),
      b = await publicGpuSource('rebro_public');
    const results = await collectPublicGpuDay(local.env, [a, b], gpuTime, (c) =>
      gpuOptions(
        c,
        gpuTime,
        c.adapter === 'highreso_public' ? '<html>broken</html>' : gpuHtml('rebro_public'),
      ),
    );
    expect(results).toMatchObject([
      { source_id: 'highreso_public', state: 'blocked', reason: 'public_gpu_table_missing' },
      {
        source_id: 'rebro_public',
        state: 'complete',
        coverage: 'complete',
        metadata: { observation_count: 2, synthetic: 1 },
      },
    ]);
  });
  it('retains checkpoint evidence on D1 failure and resumes without a second page download', async () => {
    const c = await publicGpuSource(),
      fetcher = vi.fn(gpuFetcher('highreso_public'));
    const options = {
      now: () => gpuTime,
      current_terms_version: c.terms.version,
      allow_network: true,
      fetcher,
    };
    const brokenDb = new Proxy(local.env.PRIVATE_DB, {
      get(target, key) {
        if (key === 'batch')
          return async () => {
            throw new Error('synthetic_db_failure');
          };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await expect(
      collectResearchPage({ ...local.env, PRIVATE_DB: brokenDb }, c, query, gpuTime, options),
    ).rejects.toThrow('synthetic_db_failure');
    expect(fetcher).toHaveBeenCalledTimes(3);
    await local.env.PRIVATE_DB.prepare(
      "UPDATE research_runs SET lease_token='another-worker',lease_until='2026-10-18T01:02:00.000Z'",
    ).run();
    expect((await collectResearchPage(local.env, c, query, gpuTime, options)).state).toBe('leased');
    expect(fetcher).toHaveBeenCalledTimes(3);
    await local.env.PRIVATE_DB.prepare('UPDATE research_runs SET lease_until=NULL').run();
    const result = await collectResearchPage(local.env, c, query, gpuTime, options);
    expect(result.state).toBe('complete');
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(
      await local.env.PRIVATE_DB.prepare(
        'SELECT http_page_attempts FROM research_runs WHERE run_id=?',
      )
        .bind(result.run_id)
        .first(),
    ).toEqual({ http_page_attempts: 3 });
    expect(
      (await readResearchRun(local.env, c, result.run_id, gpuOptions(c))).results,
    ).toHaveLength(4);
  });
  it('bounds batches even when 48 new offers and 48 absences share a daily snapshot', async () => {
    const c = await publicGpuSource();
    let maxBatch = 0;
    const db = new Proxy(local.env.PRIVATE_DB, {
      get(target, key) {
        if (key === 'batch')
          return (statements: D1PreparedStatement[]) => {
            maxBatch = Math.max(maxBatch, statements.length);
            return target.batch(statements);
          };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const env = { ...local.env, PRIVATE_DB: db };
    const html = (prefix: string) =>
      '<html><body><h3>Synthetic GPU</h3><p>GPU：NVIDIA A100 80GB x 1枚</p><table><tr><td>インスタンス</td><td>従量課金 [1h・台]</td><td>月額課金 [月・台]</td><td>ストレージ</td></tr>' +
      Array.from(
        { length: 24 },
        (_, i) => `<tr><td>${prefix}-${i}</td><td>123円</td><td>456円</td><td>777GB</td></tr>`,
      ).join('') +
      '</table></body></html>';
    await collectResearchPage(env, c, query, gpuTime, gpuOptions(c, gpuTime, html('old')));
    const at = '2026-10-19T01:00:00.000Z';
    const r = await collectResearchPage(env, c, query, at, gpuOptions(c, at, html('new')));
    const rows = (await readResearchRun(env, c, r.run_id, gpuOptions(c, at))).results;
    expect(rows).toHaveLength(96);
    expect(rows.filter((x) => x.change_kind === 'not_seen')).toHaveLength(48);
    expect(maxBatch).toBe(20);
  });
  it('honors source-wide Retry-After even across UTC days, without zero-stock records', async () => {
    const c = await publicGpuSource(),
      fetcher = vi.fn(
        async () => new Response('', { status: 429, headers: { 'retry-after': '172800' } }),
      );
    const options = {
      now: () => gpuTime,
      current_terms_version: c.terms.version,
      allow_network: true,
      fetcher,
    };
    await expect(collectResearchPage(local.env, c, query, gpuTime, options)).rejects.toThrow(
      'rate_limited',
    );
    const next = '2026-10-19T01:00:00.000Z';
    expect(
      (await collectResearchPage(local.env, c, query, next, { ...options, now: () => next })).state,
    ).toBe('deferred');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(
      await local.env.PRIVATE_DB.prepare(
        'SELECT COUNT(*) n FROM research_gpu_observations',
      ).first(),
    ).toEqual({ n: 0 });
    expect((await local.env.EVIDENCE.list({ prefix: 'research/' })).objects).toHaveLength(0);
    const run = await local.env.PRIVATE_DB.prepare('SELECT * FROM research_runs').first();
    expect(run).toMatchObject({
      state: 'partial',
      last_error: 'rate_limited',
      retry_at: '2026-10-20T01:00:00.000Z',
      http_page_attempts: 1,
    });
  });
  it.each(['403', 'terms', 'robots'])(
    'blocks %s before data acquisition and remains stopped across days',
    async (kind) => {
      const c = await publicGpuSource(),
        original = gpuFetcher('highreso_public');
      const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) =>
        kind === '403'
          ? new Response('', { status: 403 })
          : String(url).endsWith(kind === 'terms' ? '/terms' : '/robots.txt')
            ? new Response('changed', {
                headers: { 'content-type': kind === 'terms' ? 'text/html' : 'text/plain' },
              })
            : original(url, init),
      );
      const options = {
        now: () => gpuTime,
        current_terms_version: c.terms.version,
        allow_network: true,
        fetcher,
      };
      await expect(collectResearchPage(local.env, c, query, gpuTime, options)).rejects.toThrow();
      expect(
        fetcher.mock.calls.some(([url]) => String(url) === publicGpuEndpoints.highreso_public.page),
      ).toBe(false);
      const before = fetcher.mock.calls.length,
        at = '2026-10-19T01:00:00.000Z';
      await expect(
        collectResearchPage(local.env, c, query, at, { ...options, now: () => at }),
      ).rejects.toThrow('public_gpu_source_review_required');
      expect(fetcher).toHaveBeenCalledTimes(before);
    },
  );
  it('applies independent evidence/history retention and revocation, preserving electricity rows', async () => {
    const eia = researchSource();
    eia.limits.page_size = 1;
    await collectResearchPage(local.env, eia, eiaQuery, researchTime, opts(eiaPage(0)));
    await collectResearchPage(local.env, eia, eiaQuery, researchTime, opts(eiaPage(1)));
    const c = await publicGpuSource();
    const result = await collectResearchPage(local.env, c, query, gpuTime, gpuOptions(c));
    const at = '2026-10-26T01:00:00.000Z';
    await purgeResearchEvidence(local.env, at);
    expect(
      (await local.env.EVIDENCE.list({ prefix: 'research/highreso_public/' })).objects,
    ).toHaveLength(0);
    expect(
      (await readResearchRun(local.env, c, result.run_id, gpuOptions(c, at))).results,
    ).toHaveLength(4);
    await revokeResearchSource(local.env, c.source.source_id, at);
    await expect(readResearchRun(local.env, c, result.run_id, gpuOptions(c, at))).rejects.toThrow(
      'research_policy_changed',
    );
    const purged = await purgeResearchRun(local.env, result.run_id, at, { time_travel_days: 7 });
    expect(purged).toMatchObject({
      remaining: 0,
      backup_residual_until: '2026-11-02T01:00:00.000Z',
    });
    expect(
      await local.env.PRIVATE_DB.prepare(
        'SELECT COUNT(*) n FROM research_gpu_observations',
      ).first(),
    ).toEqual({ n: 0 });
    expect(
      await local.env.PRIVATE_DB.prepare('SELECT COUNT(*) n FROM research_observations').first(),
    ).toEqual({ n: 2 });
    // Restoring D1 source metadata alone cannot remove R2 revocation controls.
    await local.env.PRIVATE_DB.prepare('UPDATE research_sources SET suspended=0 WHERE source_id=?')
      .bind(c.source.source_id)
      .run();
    await expect(collectResearchPage(local.env, c, query, at, gpuOptions(c, at))).rejects.toThrow(
      'revoked',
    );
  });
  it('adds 0010 to populated 0009 without altering electricity, deadlines, or foreign keys', async () => {
    const old = await localEnv('test', undefined, 9);
    try {
      const c = researchSource();
      c.limits.page_size = 1;
      const r = await collectResearchPage(old.env, c, eiaQuery, researchTime, opts(eiaPage(0)));
      await collectResearchPage(old.env, c, eiaQuery, researchTime, opts(eiaPage(1)));
      const before = await old.env.PRIVATE_DB.prepare('SELECT * FROM research_runs WHERE run_id=?')
        .bind(r.run_id)
        .first();
      await applyMigrations(old.env.PRIVATE_DB, 'private');
      await applyMigrations(old.env.PRIVATE_DB, 'private');
      expect(
        await old.env.PRIVATE_DB.prepare('SELECT * FROM research_runs WHERE run_id=?')
          .bind(r.run_id)
          .first(),
      ).toEqual(before);
      expect((await old.env.PRIVATE_DB.prepare('PRAGMA foreign_key_check').all()).results).toEqual(
        [],
      );
      const gpu = await publicGpuSource();
      expect((await collectResearchPage(old.env, gpu, query, gpuTime, gpuOptions(gpu))).state).toBe(
        'complete',
      );
      expect((await readResearchRun(old.env, c, r.run_id, opts(''))).results).toHaveLength(2);
    } finally {
      await old.mf.dispose();
    }
  });
});
