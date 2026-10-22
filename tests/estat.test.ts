import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sources } from '../src/sources';
import type { Source } from '../src/schema';
import { collectSource } from '../src/pipeline';
import { estatDue, estatRequest, maskEstat, parseEstatData, type EstatTable } from '../src/estat';
import { supplyChainAPI } from '../src/supply-chain-api';
import { sourceObserver, safeLogCode } from '../src/telemetry';
import { resumeEstat } from '../src/estat-pipeline';
import { resumeCollections } from '../src/collection-continuation';
import * as gpuPipeline from '../src/gpu-pipeline';
import { expireEvidence } from '../src/operations';
import { ESTAT_CREDIT } from '../src/estat-schema';
import { supplyChainSQLite } from './supply-chain-sqlite';

let local: Awaited<ReturnType<typeof supplyChainSQLite>>;
let source: Source;
const secret = 'synthetic+credential/only';
let now = '2026-07-01T18:17:01.000Z';
let slot = '2026-07-01T18:17:00.000Z';
let values = ['1.2300', 'X', '-'];
let itemName = '合成変圧器';
let itemCode = 'item1';
let tableYear = 2025;
let calls: URL[];
const tableId = () =>
  tableYear === 2025 ? '9999999995' : tableYear === 2026 ? '9999999996' : '9999999994';
const table = (): EstatTable => ({
  table_id: tableId(),
  title: `${tableYear}年 年報 時系列表 静止電気機械器具`,
  group: '静止電気機械器具',
  year: tableYear,
  updated_at: '2026-06-30',
});
const listBody = (start: number) => ({
  GET_STATS_LIST: {
    RESULT: { STATUS: 0 },
    DATALIST_INF: {
      NUMBER: 2,
      NEXT_KEY: start === 1 ? 2 : 0,
      TABLE_INF: {
        '@id': start === 1 ? '9999999990' : tableId(),
        STAT_NAME: { '@code': '00550200', $: '生産動態統計' },
        TITLE: `${start === 1 ? 2020 : tableYear}年 年報 時系列表 静止電気機械器具`,
        SURVEY_DATE: String(start === 1 ? 2020 : tableYear),
        UPDATED_DATE: '2026-06-30',
      },
    },
  },
});
function dataBody(start = 1, unit = '台') {
  const rows = values.slice(start - 1, start - 1 + source.estat!.page_size);
  return {
    GET_STATS_DATA: {
      RESULT: { STATUS: 0 },
      STATISTICAL_DATA: {
        TABLE_INF: { '@id': tableId(), STAT_NAME: { '@code': '00550200' } },
        CLASS_INF: {
          CLASS_OBJ: [
            { '@id': 'cat01', '@name': '品目', CLASS: { '@code': itemCode, '@name': itemName } },
            {
              '@id': 'cat02',
              '@name': '表章項目',
              CLASS: { '@code': 'qty', '@name': '生産数量', '@unit': unit },
            },
            {
              '@id': 'time',
              '@name': '時間軸',
              CLASS: values.map((_, i) => ({ '@code': 't' + i, '@name': `2025年${i + 1}月` })),
            },
          ],
        },
        DATA_INF: {
          VALUE: rows.map((v, i) => ({
            '@cat01': itemCode,
            '@cat02': 'qty',
            '@time': 't' + (start + i - 1),
            '@unit': unit,
            $: v,
          })),
          NOTE: `echo appId=${secret} and ${secret}`,
        },
        RESULT_INF: {
          TOTAL_NUMBER: values.length,
          NEXT_KEY: start - 1 + rows.length < values.length ? start + rows.length : 0,
        },
      },
    },
  };
}
const fetcher = vi.fn(async (input: RequestInfo | URL) => {
  const url = new URL(String(input));
  calls.push(url);
  expect(url.origin).toBe('https://api.e-stat.go.jp');
  expect(url.searchParams.get('appId')).toBe(secret);
  const start = Number(url.searchParams.get('startPosition'));
  if (url.pathname.endsWith('getStatsData'))
    expect(url.searchParams.get('statsDataId')).toBe(tableId());
  return new Response(
    JSON.stringify(url.pathname.endsWith('getStatsList') ? listBody(start) : dataBody(start)),
    { headers: { 'content-type': 'application/json' } },
  );
});
const env = () => ({ ...local.env, ESTAT_ENABLED: 'true', ESTAT_APP_ID: secret });
async function turn() {
  return collectSource(env(), source, slot, {
    now: () => now,
    synthetic: true,
    network: { fetcher, sleep: async () => {}, random: () => 0 },
  });
}
async function finish() {
  for (let i = 0; i < 30; i++) {
    const result = await turn();
    if (result.state !== 'pending') return result;
  }
  throw new Error('synthetic_run_did_not_finish');
}
async function api(suffix: string) {
  const r = await supplyChainAPI(
    new URL('https://local.test/v1/supply-chain/' + suffix),
    { PUBLIC_DB: local.env.PUBLIC_DB },
    now,
    [source],
  );
  return (await r.json()) as any;
}
beforeEach(async () => {
  local = await supplyChainSQLite();
  source = structuredClone(sources.find((s) => s.source_id === 'estat_meti_seidou')!);
  source.enabled = true;
  source.policy.valid_from = '2026-01-01T00:00:00.000Z';
  source.estat!.table_groups = ['静止電気機械器具'];
  source.estat!.search_words = ['静止電気機械器具'];
  source.selection = ['静止電気機械器具'];
  source.estat!.page_size = 2;
  now = '2026-07-01T18:17:01.000Z';
  slot = '2026-07-01T18:17:00.000Z';
  values = ['1.2300', 'X', '-'];
  itemName = '合成変圧器';
  itemCode = 'item1';
  tableYear = 2025;
  calls = [];
  fetcher.mockClear();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await local.mf.dispose();
});

describe('e-Stat bounded monthly collection (no network; synthetic transport only)', () => {
  it('strictly gates the flag, absent Worker secret, source rights and monthly calendar before transport', async () => {
    for (const flag of [undefined, 'false', 'TRUE', '1', ' true']) {
      expect(
        (
          await collectSource({ ...env(), ESTAT_ENABLED: flag }, source, slot, {
            now: () => now,
            network: { fetcher },
          })
        ).reason,
      ).toBe('estat_disabled');
    }
    expect(
      await collectSource({ ...env(), ESTAT_APP_ID: undefined }, source, slot, {
        now: () => now,
        network: { fetcher },
      }),
    ).toMatchObject({ state: 'policy_skipped', reason: 'estat_app_id_missing' });
    expect(safeLogCode('estat_app_id_missing')).toBe('estat_app_id_missing');
    source.policy.rights.private_storage = 'denied';
    expect((await turn()).reason).toBe('policy_blocked');
    source.policy.rights.private_storage = 'allowed';
    expect(estatDue(source, '2026-06-01T18:17:00.000Z')).toBe(false);
    expect(estatDue(source, '2026-07-02T18:17:00.000Z')).toBe(false);
    source.enabled = false;
    expect((await turn()).reason).toBe('policy_blocked');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('discovers the newest annual ID, pages incrementally and hides incomplete batches', async () => {
    expect((await turn()).state).toBe('pending');
    expect((await api('series')).data).toEqual([]);
    expect(await finish()).toMatchObject({ state: 'complete', observations: 3 });
    expect(calls.map((u) => u.pathname.split('/').at(-1))).toEqual([
      'getStatsList',
      'getStatsList',
      'getStatsData',
      'getStatsData',
    ]);
    for (const url of calls.filter((u) => u.pathname.endsWith('getStatsData')))
      expect(url.searchParams.has('cdCat01')).toBe(false);
    const series = (await api('series')).data[0];
    const data = (await api(`series/${series.series_id}/observations`)).data;
    expect(data.map((r: any) => [r.value_decimal, r.value_flag])).toEqual([
      ['1.2300', null],
      [null, 'X'],
      [null, '-'],
    ]);
    expect(data[0]).toMatchObject({
      unit_raw: '台',
      stats_data_id: tableId(),
      note: 'AI向け専用統計ではない',
      data_origin: 'synthetic',
    });
    const credit =
      'このサービスは、政府統計総合窓口(e-Stat)のAPI機能を使用していますが、サービスの内容は国によって保証されたものではありません。';
    expect(ESTAT_CREDIT).toBe(credit);
    for (const db of [local.env.PRIVATE_DB, local.env.PUBLIC_DB])
      for (const table of ['sc_series', 'sc_definition_versions', 'sc_observations']) {
        const rows = await db
          .prepare('SELECT public_json FROM ' + table)
          .all<{ public_json: string }>();
        expect(rows.results.length).toBeGreaterThan(0);
        for (const row of rows.results) expect(JSON.parse(row.public_json).api_credit).toBe(credit);
      }
    const before = calls.length;
    expect((await finish()).reason).toBe('already_processed');
    slot = '2026-07-01T18:18:00.000Z';
    now = '2026-07-01T18:18:01.000Z';
    expect((await turn()).reason).toBe('already_processed');
    expect(calls).toHaveLength(before);
    const artifacts = [...local.objects.values()].map((o) => o.body).join('');
    expect(artifacts).not.toContain(secret);
    expect(artifacts).not.toContain(encodeURIComponent(secret));
    expect(artifacts).not.toContain('NOTE');
    expect(artifacts).toContain('REDACTED');
  });
  it.each(['list', 'map', 'default'])(
    'scans each configured annual group once with %s search words and independent page budgets',
    async (shape) => {
      const groups = sources.find((s) => s.source_id === 'estat_meti_seidou')!.estat!.table_groups;
      source.estat!.table_groups = source.selection = [...groups];
      const words = groups.map((g) => (shape === 'default' ? g : g + ' 年報'));
      if (shape === 'default') delete source.estat!.search_words;
      else
        source.estat!.search_words =
          shape === 'list' ? words : Object.fromEntries(groups.map((g, i) => [g, words[i]]));
      source.estat!.max_list_pages = 2;
      const transport = vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        const group = groups[words.indexOf(url.searchParams.get('searchWord')!)];
        const start = Number(url.searchParams.get('startPosition'));
        const listing = listBody(start);
        listing.GET_STATS_LIST.DATALIST_INF.TABLE_INF['@id'] =
          '99999999' + groups.indexOf(group) + (start === 1 ? '0' : '5');
        listing.GET_STATS_LIST.DATALIST_INF.TABLE_INF.TITLE = `${start === 1 ? 2020 : 2025}年 時系列表(2290_機械器具月報（その２９）${group}（航空機用のものを除く))`;
        return Response.json({
          GET_STATS_LIST: {
            ...listing.GET_STATS_LIST,
            DATALIST_INF: {
              ...listing.GET_STATS_LIST.DATALIST_INF,
              TABLE_INF: {
                ...listing.GET_STATS_LIST.DATALIST_INF.TABLE_INF,
                STATISTICS_NAME: '経済産業省生産動態統計 年報 年報(2021年以降) 2025年 年報',
              },
            },
          },
        });
      });
      for (let i = 0; i < groups.length * 2; i++) {
        expect(
          await collectSource(env(), source, slot, {
            now: () => now,
            synthetic: true,
            network: { fetcher: transport },
          }),
        ).toMatchObject({ state: 'pending' });
        const intake = await local.env.PRIVATE_DB.prepare('SELECT * FROM sc_intakes').first<any>();
        expect(intake.phase).toBe(i === groups.length * 2 - 1 ? 'data' : 'list');
      }
      expect(
        transport.mock.calls.map(([input]) => {
          const url = new URL(String(input));
          return [url.searchParams.get('searchWord'), url.searchParams.get('startPosition')];
        }),
      ).toEqual(
        words.flatMap((word) => [
          [word, '1'],
          [word, '2'],
        ]),
      );
      const intake = await local.env.PRIVATE_DB.prepare('SELECT * FROM sc_intakes').first<any>();
      expect(intake.table_index).toBe(0);
      expect(JSON.parse(intake.tables_json).map((t: EstatTable) => [t.group, t.year])).toEqual(
        groups.map((g) => [g, 2025]),
      );
    },
  );

  it('enforces the list-page ceiling again in a later group', async () => {
    source.estat!.table_groups = source.selection = ['静止電気機械器具', '開閉制御装置'];
    source.estat!.search_words = ['静止電気機械器具', '開閉制御装置'];
    source.estat!.max_list_pages = 1;
    const transport = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const listing = listBody(url.searchParams.get('searchWord') === '静止電気機械器具' ? 2 : 1);
      if (url.searchParams.get('searchWord') === '静止電気機械器具')
        listing.GET_STATS_LIST.DATALIST_INF.NUMBER = 1;
      return Response.json(listing);
    });
    const step = () =>
      collectSource(env(), source, slot, {
        now: () => now,
        synthetic: true,
        network: { fetcher: transport },
      });
    expect((await step()).state).toBe('pending');
    expect((await step()).state).toBe('pending');
    expect(await step()).toMatchObject({ state: 'failed', reason: 'estat_page_limit' });
    expect(transport).toHaveBeenCalledTimes(2);
    expect((await api('series')).data).toEqual([]);
  });

  it('sends item codes on every data page and masks URLs containing cdCat01 in saved evidence', async () => {
    source.estat!.item_codes = ['0076000', '0083000'];
    expect((await finish()).state).toBe('complete');
    const dataCalls = calls.filter((url) => url.pathname.endsWith('getStatsData'));
    expect(dataCalls).toHaveLength(2);
    for (const url of dataCalls) expect(url.searchParams.get('cdCat01')).toBe('0076000,0083000');
    for (const saved of local.objects.values()) {
      const url = new URL(JSON.parse(saved.body).request_url);
      expect(url.searchParams.get('cdCat01')).toBe('0076000,0083000');
      expect(url.searchParams.get('appId')).toBe('[REDACTED]');
      expect(saved.body).not.toContain(secret);
      expect(saved.body).not.toContain(encodeURIComponent(secret));
    }
    await expect(
      estatRequest(
        source,
        env(),
        'getStatsData',
        { cdCat01: '0076000,0083000' },
        {
          now: () => now,
          max_attempts: 1,
          fetcher: async (input) => {
            throw new Error(String(input));
          },
        },
      ),
    ).rejects.toThrow('estat_request_failed');
    await expect(
      estatRequest(source, env(), 'getStatsData', { cdCat02: '123' }, { now: () => now, fetcher }),
    ).rejects.toThrow('estat_request_invalid');
  });
  it('records value revisions, retains history, and versions renamed items without joining definitions', async () => {
    await finish();
    const series = (await api('series')).data[0].series_id;
    now = '2026-08-01T18:17:01.000Z';
    slot = '2026-08-01T18:17:00.000Z';
    values = ['1.2400', 'X', '-'];
    expect((await finish()).state).toBe('complete');
    const revisions = (await api(`series/${series}/revisions`)).data;
    expect(revisions).toHaveLength(1);
    expect(revisions[0].api_credit).toBe(ESTAT_CREDIT);
    for (const db of [local.env.PRIVATE_DB, local.env.PUBLIC_DB]) {
      const saved = await db
        .prepare('SELECT public_json FROM sc_revisions')
        .first<{ public_json: string }>();
      expect(JSON.parse(saved!.public_json).api_credit).toBe(ESTAT_CREDIT);
    }
    expect(revisions[0]).toMatchObject({
      before: { value_decimal: '1.2300' },
      after: { value_decimal: '1.2400' },
    });
    itemName = '合成変圧器（名称改正）';
    now = '2026-09-01T18:17:01.000Z';
    slot = '2026-09-01T18:17:00.000Z';
    expect((await finish()).state).toBe('complete');
    const listing = (await api('series')).data;
    expect(listing).toHaveLength(1);
    expect(listing[0].item_name_ja).toBe('合成変圧器（名称改正）');
    expect(listing[0].definitions).toHaveLength(2);
    expect((await api(`series/${series}/observations`)).data).toHaveLength(7);
    expect((await api(`series/${series}/revisions`)).data).toHaveLength(1);
  });
  it('keeps stable identity and revision lineage across policy/signature renewals without duplicating unchanged periods', async () => {
    await finish();
    const id = (await api('series')).data[0].series_id;
    const signature = (await parseEstatData(source, table(), dataBody())).schema_signature;
    source.policy.version += '-renewed';
    source.estat!.reviewed_schema_signatures = [signature];
    now = '2026-08-01T18:17:01.000Z';
    slot = '2026-08-01T18:17:00.000Z';
    values = ['1.23000', 'X', '-']; // Numerically unchanged, keep original decimal spelling.
    expect(await finish()).toMatchObject({ state: 'complete', observations: 0 });
    expect((await api('series')).data.map((r: any) => r.series_id)).toEqual([id]);
    expect((await api(`series/${id}/observations`)).data).toHaveLength(3);
    now = '2026-09-01T18:17:01.000Z';
    slot = '2026-09-01T18:17:00.000Z';
    values = ['1.2400', 'X', '-'];
    expect(await finish()).toMatchObject({ state: 'complete', observations: 1 });
    expect((await api('series')).data[0].series_id).toBe(id);
    expect((await api(`series/${id}/observations`)).data).toHaveLength(4);
    expect((await api(`series/${id}/revisions`)).data).toHaveLength(1);
    for (const db of [local.env.PRIVATE_DB, local.env.PUBLIC_DB]) {
      expect(await db.prepare('SELECT count(*) n FROM sc_observations').first<number>('n')).toBe(4);
      expect(await db.prepare('SELECT count(*) n FROM sc_series').first<number>('n')).toBe(1);
    }
  });

  it('masks raw, URI and URLSearchParams form-encoded echoes in keys, values and failures', async () => {
    const token = "synthetic !'()*~+/key";
    const variants = [
      token,
      encodeURIComponent(token),
      encodeURI(token),
      new URLSearchParams({ v: token }).toString().slice(2),
    ];
    for (const variant of variants)
      expect(maskEstat('echo ' + variant, token)).toBe('echo [REDACTED]');
    const response = await estatRequest(
      source,
      { ...env(), ESTAT_APP_ID: token },
      'getStatsList',
      {},
      {
        now: () => now,
        fetcher: async () =>
          new Response(
            JSON.stringify({ GET_STATS_LIST: { RESULT: { STATUS: 0 }, [variants[3]]: variants } }),
            { headers: { 'content-type': 'application/json' } },
          ),
      },
    );
    for (const variant of variants) expect(JSON.stringify(response)).not.toContain(variant);
  });

  it('never retains or logs a non-200 body echoing appId', async () => {
    const logs: unknown[] = [];
    const consoleLog = vi.spyOn(console, 'log').mockImplementation((line) => logs.push(line));
    const bad = vi.fn(
      async () =>
        new Response('appId=' + secret + ' ' + encodeURIComponent(secret), { status: 503 }),
    );
    const result = await collectSource(env(), source, slot, {
      now: () => now,
      observer: sourceObserver(
        env(),
        'collection',
        slot,
        (log) => logs.push(log),
        () => now,
      ),
      network: { fetcher: bad, sleep: async () => {}, random: () => 0 },
    });
    expect(result).toMatchObject({ state: 'failed', reason: 'estat_request_failed' });
    expect(bad).toHaveBeenCalledTimes(3);
    const attempts = await local.env.PRIVATE_DB.prepare('SELECT * FROM fetch_attempts').all();
    const runs = await local.env.PRIVATE_DB.prepare('SELECT * FROM collection_runs').all();
    expect(attempts.results).toHaveLength(3);
    expect(local.objects.size).toBe(0);
    const retained = JSON.stringify([result, attempts, runs, logs]);
    for (const token of [secret, encodeURIComponent(secret)]) expect(retained).not.toContain(token);
    consoleLog.mockRestore();
  });

  it.each(['text/plain', 'text/html'])(
    'rejects a JSON body served as %s before retaining or publishing it',
    async (contentType) => {
      const transport = vi.fn(
        async () =>
          new Response(JSON.stringify(listBody(1)), {
            headers: { 'content-type': contentType },
          }),
      );
      expect(
        await collectSource(env(), source, slot, {
          now: () => now,
          synthetic: true,
          network: { fetcher: transport },
        }),
      ).toMatchObject({ state: 'failed', reason: 'estat_request_failed' });
      expect(transport).toHaveBeenCalledTimes(1);
      const attempts = await local.env.PRIVATE_DB.prepare('SELECT code FROM fetch_attempts').all();
      expect(attempts.results).toEqual([{ code: 'unexpected_content_type' }]);
      expect(local.objects.size).toBe(0);
      expect((await api('series')).data).toEqual([]);
    },
  );

  it.each(['expired policy', 'blocked policy', 'missing appId', 'not due', 'disabled source'])(
    'retires a pending run with %s and still resumes GPU work on the same tick',
    async (blocked) => {
      const pending = await turn();
      expect(pending.state).toBe('pending');
      const resumedEnv = env();
      if (blocked === 'expired policy') source.policy.valid_until = now;
      if (blocked === 'blocked policy') source.policy.rights.private_storage = 'denied';
      if (blocked === 'missing appId') resumedEnv.ESTAT_APP_ID = '';
      if (blocked === 'not due') source.estat!.months_utc = [8];
      if (blocked === 'disabled source') source.enabled = false;
      const gpuResult = { source_id: 'synthetic_gpu', run_id: 'gpu-run', state: 'pending' };
      const gpu = vi.spyOn(gpuPipeline, 'resumeGPURuns').mockResolvedValue([gpuResult]);
      const noNetwork = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error(secret));
      const attempts = calls.length;

      expect(await resumeCollections(resumedEnv, [source], now)).toEqual({
        results: [gpuResult],
        models_work: false,
      });
      expect(gpu).toHaveBeenCalledWith(resumedEnv, [source], now, false, undefined);
      expect(
        await local.env.PRIVATE_DB.prepare(
          'SELECT state,error_code,finished_at FROM collection_runs WHERE run_id=?',
        )
          .bind(pending.run_id)
          .first(),
      ).toEqual({ state: 'failed', error_code: 'estat_resume_skipped', finished_at: now });
      expect(await resumeEstat(resumedEnv, [source], now)).toEqual({ results: [], work: false });

      // Once the GPU queue is empty, the continuation also leaves maintenance available.
      gpu.mockResolvedValue([]);
      expect(await resumeCollections(resumedEnv, [source], now)).toEqual({
        results: [],
        models_work: false,
      });
      expect(gpu).toHaveBeenCalledTimes(2);
      expect(calls).toHaveLength(attempts);
      expect(noNetwork).not.toHaveBeenCalled();
    },
  );

  it('lets GPU resume continue when either e-Stat migration is missing', async () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => logs.push(line));
    const legacy = await supplyChainSQLite(3);
    const gpu = vi.spyOn(gpuPipeline, 'resumeGPURuns').mockResolvedValue([]);
    try {
      for (const binding of ['PUBLIC_DB', 'PRIVATE_DB'] as const) {
        const partial = { ...env(), [binding]: legacy.env[binding] };
        expect(await resumeEstat(partial, [source], now)).toEqual({ results: [], work: false });
        expect(await resumeCollections(partial, [source], now)).toEqual({
          results: [],
          models_work: false,
        });
        expect(gpu).toHaveBeenLastCalledWith(partial, [source], now, false, undefined);
      }
      expect(gpu).toHaveBeenCalledTimes(2);
      expect(logs.map((line) => JSON.parse(line).error_code)).toContain('estat_schema_unavailable');
    } finally {
      await legacy.mf.dispose();
    }
  });

  it('signals maintenance failures with fixed codes and reserves the workload', async () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => logs.push(line));
    const broken = new Proxy(local.env.PUBLIC_DB, {
      get(target, key, receiver) {
        if (key === 'prepare') throw new Error(secret);
        return Reflect.get(target, key, receiver);
      },
    });
    expect(await resumeEstat({ ...env(), PUBLIC_DB: broken }, [source], now)).toEqual({
      results: [],
      work: true,
    });
    expect(logs.map((line) => JSON.parse(line).error_code)).toContain('estat_resume_failed');
    expect(logs.join('')).not.toContain(secret);
  });

  it('quarantines changed code systems and unreviewed 2026 annual tables', async () => {
    await finish();
    itemCode = 'changed2026';
    now = '2026-08-01T18:17:01.000Z';
    slot = '2026-08-01T18:17:00.000Z';
    expect(await finish()).toMatchObject({ state: 'quarantined', reason: 'estat_schema_changed' });
    expect(
      await local.env.PUBLIC_DB.prepare(
        "SELECT count(*) n FROM publication_batches WHERE state='complete'",
      ).first<number>('n'),
    ).toBe(1);
    tableYear = 2026;
    itemCode = 'item1';
    now = '2026-09-01T18:17:01.000Z';
    slot = '2026-09-01T18:17:00.000Z';
    expect(await finish()).toMatchObject({ state: 'quarantined', reason: 'estat_schema_changed' });
    expect((await api('series')).data).toHaveLength(1);
  });
  it('keeps mixed units and signed/exact decimals, flags missing values, and rejects unknown dimensions', async () => {
    for (const unit of ['台', 't', '百万円', '式', '基']) {
      values = ['-12.3400', '…'];
      const page = await parseEstatData(source, table(), dataBody(1, unit));
      expect(page.rows[0]).toMatchObject({ unit_raw: unit, value_decimal: '-12.3400' });
      expect(page.rows[1]).toMatchObject({ value_decimal: null, value_flag: '…' });
    }
    const body = dataBody();
    body.GET_STATS_DATA.STATISTICAL_DATA.CLASS_INF.CLASS_OBJ.push({
      '@id': 'unknown',
      '@name': '未審査軸',
      CLASS: [
        { '@code': 'a', '@name': 'a' },
        { '@code': 'b', '@name': 'b' },
      ],
    } as any);
    await expect(parseEstatData(source, table(), body)).rejects.toThrow(
      'estat_classification_unknown',
    );
  });
  it('bounds HTTP retries and leaves no credential in errors, attempts, evidence or telemetry', async () => {
    const logs: unknown[] = [];
    const observer = sourceObserver(
      env(),
      'collection',
      slot,
      (log) => logs.push(log),
      () => now,
    );
    const bad = vi.fn(async () => {
      throw new Error('failed URL ?appId=' + secret);
    });
    const result = await collectSource(env(), source, slot, {
      now: () => now,
      observer,
      network: { fetcher: bad, sleep: async () => {}, random: () => 0 },
    });
    expect(result).toMatchObject({ state: 'failed', reason: 'estat_request_failed' });
    expect(bad).toHaveBeenCalledTimes(3);
    expect((await turn()).reason).toBe('already_processed');
    expect(fetcher).not.toHaveBeenCalled();
    const stored = await local.env.PRIVATE_DB.prepare('SELECT code FROM fetch_attempts').all();
    expect(stored.results).toHaveLength(3);
    expect(JSON.stringify([result, logs, stored, [...local.objects.values()]])).not.toContain(
      secret,
    );
    expect(maskEstat(`appId=${encodeURIComponent(secret)}&x=1`, secret)).not.toContain(
      encodeURIComponent(secret),
    );
    const escaped = JSON.stringify({
      GET_STATS_LIST: { RESULT: { STATUS: 0 }, echo: secret },
    }).replaceAll('+', '\\u002b');
    const response = await estatRequest(
      source,
      env(),
      'getStatsList',
      { statsCode: '00550200' },
      {
        now: () => now,
        fetcher: async () =>
          new Response(escaped, { headers: { 'content-type': 'application/json' } }),
      },
    );
    expect(JSON.stringify(response)).not.toContain(secret);
    expect(JSON.stringify(response.body)).toContain('[REDACTED]');
  });
  it('does not retry a reserved page after interruption, and enforces page ceilings', async () => {
    await turn();
    await local.env.PRIVATE_DB.prepare('UPDATE sc_intakes SET request_reserved=1').run();
    expect(await turn()).toMatchObject({ state: 'failed', reason: 'estat_request_interrupted' });
    expect(calls).toHaveLength(1);
    // A separate eligible day exercises the finite catalog budget.
    slot = '2026-08-01T18:17:00.000Z';
    now = '2026-08-01T18:17:01.000Z';
    source.policy.version += '-bounded';
    source.estat!.max_list_pages = 1;
    expect(await finish()).toMatchObject({ state: 'failed', reason: 'estat_page_limit' });
    expect(calls).toHaveLength(2);
  });
  it('bounds the SQL work for a ten-row revision continuation', async () => {
    source.estat!.page_size = 10;
    values = Array.from({ length: 10 }, () => '1.00');
    await finish();
    now = '2026-08-01T18:17:01.000Z';
    slot = '2026-08-01T18:17:00.000Z';
    values = Array.from({ length: 10 }, () => '2.00');
    const queries = { private: 0, public: 0 };
    const track = (db: D1Database, kind: 'private' | 'public') =>
      new Proxy(db, {
        get(target, key, receiver) {
          if (key === 'prepare')
            return (sql: string) => {
              queries[kind]++;
              return target.prepare(sql);
            };
          return Reflect.get(target, key, receiver);
        },
      });
    const tracked = {
      ...env(),
      PRIVATE_DB: track(local.env.PRIVATE_DB, 'private'),
      PUBLIC_DB: track(local.env.PUBLIC_DB, 'public'),
    };
    for (let i = 0; i < 10; i++) {
      queries.private = queries.public = 0;
      const result = await collectSource(tracked, source, slot, {
        now: () => now,
        synthetic: true,
        network: { fetcher },
      });
      if (result.state === 'complete') {
        expect(result.observations).toBe(10);
        expect(result.changes).toBe(10);
        expect(queries.private + queries.public).toBeLessThan(200);
        expect(queries.private + queries.public).toBeGreaterThan(100);
        return;
      }
      expect(result.state).toBe('pending');
    }
    throw new Error('synthetic_revision_chunk_did_not_finish');
  });

  it('stops at the data-page cap and withholds a partial table', async () => {
    source.estat!.max_data_pages = 1;
    expect(await finish()).toMatchObject({ state: 'failed', reason: 'estat_page_limit' });
    expect(calls.filter((u) => u.pathname.endsWith('getStatsData'))).toHaveLength(1);
    expect((await api('series')).data).toEqual([]);
    expect(
      await local.env.PRIVATE_DB.prepare('SELECT count(*) n FROM sc_observations').first<number>(
        'n',
      ),
    ).toBe(2);
  });

  it('discovers monthly IIP tables and retains the seasonal-adjustment base year', async () => {
    source = structuredClone(sources.find((s) => s.source_id === 'estat_meti_iip')!);
    source.enabled = true;
    source.policy.valid_from = '2026-01-01T00:00:00.000Z';
    source.estat!.table_groups = source.selection = ['在庫'];
    source.estat!.page_size = 2;
    values = ['98.700', '…'];
    const listing = listBody(2);
    listing.GET_STATS_LIST.DATALIST_INF.NUMBER = 1;
    listing.GET_STATS_LIST.DATALIST_INF.TABLE_INF.STAT_NAME['@code'] = '00550300';
    listing.GET_STATS_LIST.DATALIST_INF.TABLE_INF.TITLE = '2020年基準 品目別季節調整済【月次】在庫';
    const data = dataBody(1, '指数');
    data.GET_STATS_DATA.STATISTICAL_DATA.TABLE_INF.STAT_NAME['@code'] = '00550300';
    const metric = data.GET_STATS_DATA.STATISTICAL_DATA.CLASS_INF.CLASS_OBJ[1].CLASS as any;
    metric['@name'] = '指数';
    const transport = vi.fn(
      async (input: RequestInfo | URL) =>
        new Response(JSON.stringify(String(input).includes('getStatsList') ? listing : data), {
          headers: { 'content-type': 'application/json' },
        }),
    );
    for (let i = 0; i < 3; i++)
      await collectSource(env(), source, slot, {
        now: () => now,
        synthetic: true,
        network: { fetcher: transport },
      });
    expect(transport).toHaveBeenCalledTimes(2);
    const series = (await api('series')).data[0];
    const rows = (await api(`series/${series.series_id}/observations`)).data;
    expect(rows[0]).toMatchObject({
      base_year: 2020,
      measure: 'inventory_index_sa',
      unit_raw: '指数',
      value_decimal: '98.700',
      release_kind: 'iip_monthly',
    });
    expect(rows[1]).toMatchObject({ value_decimal: null, value_flag: '…' });
  });
  it('collects embedded annual measures in one data page and publishes only supported measures', async () => {
    source.estat!.page_size = 10000;
    const classifications = [
      ['A', '生産数量', '台'],
      ['B', '生産容量', 'kVA'],
      ['C', '生産金額', '百万円'],
      ['D', '受入数量', '台'],
      ['E', '販売数量', '台'],
      ['F', '販売容量', 'kVA'],
      ['G', '販売金額', '百万円'],
      ['H', '月末在庫数量', '台'],
    ].map(([letter, measure, unit], i) => ({
      '@code': String(2290010010 + i * 10),
      '@name': `製品_0101_合成_変圧器_${letter}_${measure}_${unit}`,
    }));
    const times = [
      { '@code': '2025000101', '@name': '202501' },
      { '@code': '2025000202', '@name': '202502' },
    ];
    const transport = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('getStatsList')) {
        const listing = listBody(2);
        listing.GET_STATS_LIST.DATALIST_INF.NUMBER = 1;
        listing.GET_STATS_LIST.DATALIST_INF.TABLE_INF.TITLE = `${tableYear}年 年報 時系列表(2290_静止電気機械器具)`;
        return Response.json(listing);
      }
      return Response.json({
        GET_STATS_DATA: {
          RESULT: { STATUS: 0 },
          STATISTICAL_DATA: {
            TABLE_INF: { '@id': tableId(), STAT_NAME: { '@code': '00550200' } },
            CLASS_INF: {
              CLASS_OBJ: [
                { '@id': 'cat01', '@name': '2021_2290_表側', CLASS: classifications },
                { '@id': 'time', '@name': '2025_実数表_時間軸_表頭', CLASS: times },
              ],
            },
            DATA_INF: {
              VALUE: classifications.flatMap((c) =>
                times.map((t, i) => ({
                  '@cat01': c['@code'],
                  '@time': t['@code'],
                  $: i === 0 ? '12.3400' : 'X',
                })),
              ),
            },
            RESULT_INF: { TOTAL_NUMBER: 16 },
          },
        },
      });
    });
    let result;
    for (let i = 0; i < 5; i++) {
      result = await collectSource(env(), source, slot, {
        now: () => now,
        synthetic: true,
        network: { fetcher: transport },
      });
      if (result.state !== 'pending') break;
    }
    expect(result).toMatchObject({ state: 'complete', observations: 10 });
    expect(transport).toHaveBeenCalledTimes(2);
    const series = (await api('series')).data;
    expect(series).toHaveLength(5);
    for (const s of series) {
      expect(s).toMatchObject({ item_code: '2290_0101', item_name_ja: '合成_変圧器' });
      const rows = (await api(`series/${s.series_id}/observations`)).data;
      expect(rows).toMatchObject([
        { period: '2025-01', value_decimal: '12.3400', unit_raw: s.unit_raw },
        { period: '2025-02', value_decimal: null, value_flag: 'X' },
      ]);
    }
    for (const saved of local.objects.values()) {
      expect(saved.body).not.toContain('生産容量');
      expect(saved.body).not.toContain('販売容量');
      expect(saved.body).not.toContain('受入数量');
      expect(saved.body).not.toContain(secret);
    }
  });
  it('scans overlapping IIP groups once each and completes weight-only pages without saving weights', async () => {
    source = structuredClone(sources.find((s) => s.source_id === 'estat_meti_iip')!);
    source.enabled = true;
    source.policy.valid_from = '2026-01-01T00:00:00.000Z';
    source.estat!.page_size = 2;
    const groups = source.estat!.table_groups;
    const ids = ['9999999991', '9999999992'];
    const times = [
      { '@code': 'weight1', '@name': '在庫ウエイト' },
      { '@code': 'weight2', '@name': '在庫率ウエイト' },
      { '@code': 'month', '@name': '201801' },
    ];
    const transport = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('getStatsList'))
        return Response.json({
          GET_STATS_LIST: {
            RESULT: { STATUS: 0 },
            DATALIST_INF: {
              NUMBER: 2,
              NEXT_KEY: 0,
              TABLE_INF: groups.map((group, i) => ({
                '@id': ids[i],
                STAT_NAME: { '@code': '00550300' },
                TITLE: `品目別季節調整済指数【月次】${group}（2020＝100.0）`,
                SURVEY_DATE: '2025',
              })),
            },
          },
        });
      const start = Number(url.searchParams.get('startPosition'));
      expect(url.searchParams.get('cdCat01')).toBe(source.estat!.item_codes!.join(','));
      return Response.json({
        GET_STATS_DATA: {
          RESULT: { STATUS: 0 },
          STATISTICAL_DATA: {
            TABLE_INF: {
              '@id': url.searchParams.get('statsDataId'),
              STAT_NAME: { '@code': '00550300' },
            },
            CLASS_INF: {
              CLASS_OBJ: [
                {
                  '@id': 'cat01',
                  '@name': '品目別_2020',
                  CLASS: { '@code': '0076000', '@name': '1106103010 合成変圧器' },
                },
                { '@id': 'time', '@name': '統計項目A_2020_Match', CLASS: times },
              ],
            },
            DATA_INF: {
              VALUE: times.slice(start - 1, start + 1).map((t) => ({
                '@cat01': '0076000',
                '@time': t['@code'],
                $: t['@code'] === 'month' ? '98.700' : 'invalid-weight-value',
              })),
            },
            RESULT_INF: { TOTAL_NUMBER: 3, NEXT_KEY: start === 1 ? 3 : 0 },
          },
        },
      });
    });
    let result;
    for (let i = 0; i < 12; i++) {
      result = await collectSource(env(), source, slot, {
        now: () => now,
        synthetic: true,
        network: { fetcher: transport },
      });
      if (result.state !== 'pending') break;
    }
    expect(result).toMatchObject({ state: 'complete', observations: 2 });
    const urls = transport.mock.calls.map(([input]) => new URL(String(input)));
    expect(
      urls
        .filter((u) => u.pathname.endsWith('getStatsList'))
        .map((u) => u.searchParams.get('searchWord')),
    ).toEqual(groups);
    expect(
      urls
        .filter((u) => u.pathname.endsWith('getStatsData'))
        .map((u) => [u.searchParams.get('statsDataId'), u.searchParams.get('startPosition')]),
    ).toEqual(
      ids.flatMap((id) => [
        [id, '1'],
        [id, '3'],
      ]),
    );
    const series = (await api('series')).data;
    expect(series.map((s: any) => s.measure).sort()).toEqual([
      'inventory_index_sa',
      'inventory_ratio_index_sa',
    ]);
    for (const s of series)
      expect((await api(`series/${s.series_id}/observations`)).data).toMatchObject([
        { period: '2018-01', value_decimal: '98.700', unit_raw: '2020=100', base_year: 2020 },
      ]);
    for (const saved of local.objects.values()) {
      expect(saved.body).not.toContain('ウエイト');
      expect(saved.body).not.toContain('invalid-weight-value');
      expect(saved.body).not.toContain(secret);
    }
  });
  it('withdraws expired history and evidence after disabling collection, with public deletion first', async () => {
    await finish();
    source.enabled = false;
    const maintenance = { ...env(), ESTAT_ENABLED: 'false' };
    const later = '2030-01-01T00:00:00.000Z';
    expect(await resumeEstat(maintenance, [source], later)).toEqual({ results: [], work: true });
    expect(
      await local.env.PUBLIC_DB.prepare('SELECT count(*) n FROM sc_observations').first<number>(
        'n',
      ),
    ).toBe(0);
    expect(
      await local.env.PRIVATE_DB.prepare('SELECT count(*) n FROM sc_observations').first<number>(
        'n',
      ),
    ).toBe(3);
    for (let i = 0; i < 5; i++) await resumeEstat(maintenance, [source], later);
    for (const db of [local.env.PUBLIC_DB, local.env.PRIVATE_DB]) {
      expect(await db.prepare('SELECT count(*) n FROM sc_observations').first<number>('n')).toBe(0);
      expect(
        await db.prepare('SELECT count(*) n FROM sc_definition_versions').first<number>('n'),
      ).toBe(0);
      expect(await db.prepare('SELECT count(*) n FROM sc_series').first<number>('n')).toBe(0);
    }
    await expireEvidence(maintenance, later);
    expect(local.objects.size).toBe(0);
    expect(calls).toHaveLength(4);
  });
});
