import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sources } from '../src/sources';
import type { Source } from '../src/schema';
import { collectSource } from '../src/pipeline';
import { estatDue, estatRequest, maskEstat, parseEstatData, type EstatTable } from '../src/estat';
import { supplyChainAPI } from '../src/supply-chain-api';
import { sourceObserver, safeLogCode } from '../src/telemetry';
import { resumeEstat } from '../src/estat-pipeline';
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

  it('signals partial migrations and maintenance failures with fixed codes and reserves the workload', async () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => logs.push(line));
    const publicDb = await supplyChainSQLite(3);
    try {
      expect(
        await resumeEstat({ ...env(), PUBLIC_DB: publicDb.env.PUBLIC_DB }, [source], now),
      ).toEqual({ results: [], work: true });
      expect(logs.map((line) => JSON.parse(line).error_code)).toContain('estat_schema_unavailable');
    } finally {
      await publicDb.mf.dispose();
    }
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
