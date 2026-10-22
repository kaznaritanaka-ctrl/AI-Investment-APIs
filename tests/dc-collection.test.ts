import { describe, expect, it, vi } from 'vitest';
import { localEnv } from '../scripts/local-env';
import { collectResearchPage } from '../src/research/pipeline';
import { dcResearchConfigs } from '../src/research/dc-sources';
import { readDCTracker } from '../src/research/dc-tracker';

const monday = '2026-10-26T18:17:00.000Z';
const query = { kind: 'dc_tracker' } as const;
const config = () => structuredClone(dcResearchConfigs[0]);
const response = (body: string, status = 200, type = 'text/html') =>
  new Response(body, { status, headers: { 'content-type': type } });

describe('DC weekly runs and durable HTTP budget (synthetic fetch only)', () => {
  it('rejects other UTC slots before creating runs or fetching', async () => {
    const { env, mf } = await localEnv();
    try {
      const c = config(),
        fetcher = vi.fn();
      for (const at of [
        '2026-10-25T18:17:00.000Z',
        '2026-10-26T18:20:00.000Z',
        '2026-10-27T18:17:00.000Z',
      ])
        await expect(
          collectResearchPage(env, c, query, at, {
            current_terms_version: c.terms.version,
            now: () => at,
            allow_network: true,
            fetcher,
          }),
        ).rejects.toThrow('dc_weekly_slot_required');
      expect(fetcher).not.toHaveBeenCalled();
      expect(await env.PRIVATE_DB.prepare('SELECT COUNT(*) n FROM research_runs').first()).toEqual({
        n: 0,
      });
    } finally {
      await mf.dispose();
    }
  });

  it('replays one run per UTC week without HTTP and checks fresh robots in the next week', async () => {
    const { env, mf } = await localEnv();
    try {
      const c = config();
      const fetcher = vi.fn(async (url: RequestInfo | URL) =>
        String(url).endsWith('/robots.txt')
          ? response('User-agent: *\nDisallow:', 200, 'text/plain')
          : response('<title>合成タイトル</title><p>synthetic private body</p>'),
      );
      const options = (at: string) => ({
        current_terms_version: c.terms.version,
        now: () => at,
        allow_network: true,
        fetcher,
      });
      const first = await collectResearchPage(env, c, query, monday, options(monday));
      expect(first.state).toBe('complete');
      expect(fetcher).toHaveBeenCalledTimes(3);
      expect(await collectResearchPage(env, c, query, monday, options(monday))).toEqual(first);
      expect(fetcher).toHaveBeenCalledTimes(3);
      const next = '2026-11-02T18:17:00.000Z';
      const second = await collectResearchPage(env, c, query, next, options(next));
      expect(second.run_id).not.toBe(first.run_id);
      expect(fetcher).toHaveBeenCalledTimes(6);
      expect(
        fetcher.mock.calls.filter(([url]) => String(url).endsWith('/robots.txt')),
      ).toHaveLength(2);
      expect(
        (
          await env.PRIVATE_DB.prepare(
            'SELECT http_page_attempts FROM research_runs ORDER BY scheduled_for',
          ).all()
        ).results,
      ).toEqual([{ http_page_attempts: 3 }, { http_page_attempts: 3 }]);
      const rows = await readDCTracker(env, c, second.run_id, options(next));
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.status === 'draft')).toBe(true);
      expect(
        (
          await env.PRIVATE_DB.prepare(
            'SELECT change_kind FROM research_observations WHERE run_id=?',
          )
            .bind(second.run_id)
            .all()
        ).results,
      ).toEqual([{ change_kind: 'reobserved' }, { change_kind: 'reobserved' }]);
      expect(
        await env.PUBLIC_DB.prepare(
          "SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND (name GLOB 'research_*' OR name GLOB 'dc_*')",
        ).first(),
      ).toEqual({ n: 0 });
      expect(
        await env.PUBLIC_DB.prepare(
          "SELECT COUNT(*) n FROM published_observations WHERE source_id GLOB 'dc_*' OR source_id IN ('highreso_public','rebro_public')",
        ).first(),
      ).toEqual({ n: 0 });
    } finally {
      await mf.dispose();
    }
  });

  it('never resets the three-request counter after failure, including robots requests on retries', async () => {
    const { env, mf } = await localEnv();
    try {
      const c = config();
      const fetcher = vi.fn(async (url: RequestInfo | URL) =>
        String(url).endsWith('/robots.txt')
          ? response('User-agent: *\nDisallow:', 200, 'text/plain')
          : fetcher.mock.calls.length === 3
            ? response('synthetic failure', 503)
            : response('<title>合成タイトル</title>'),
      );
      const opt = {
        current_terms_version: c.terms.version,
        now: () => monday,
        allow_network: true,
        fetcher,
      };
      await expect(collectResearchPage(env, c, query, monday, opt)).rejects.toThrow('http_503');
      expect(fetcher).toHaveBeenCalledTimes(3);
      await expect(collectResearchPage(env, c, query, monday, opt)).rejects.toThrow(
        'research_request_budget_exhausted',
      );
      expect(fetcher).toHaveBeenCalledTimes(3);
      expect(
        await env.PRIVATE_DB.prepare(
          'SELECT state,http_page_attempts,last_error FROM research_runs',
        ).first(),
      ).toEqual({
        state: 'partial',
        http_page_attempts: 3,
        last_error: 'research_request_budget_exhausted',
      });
      expect(
        await env.PRIVATE_DB.prepare('SELECT COUNT(*) n FROM dc_observations').first(),
      ).toEqual({ n: 0 });
    } finally {
      await mf.dispose();
    }
  });
});
