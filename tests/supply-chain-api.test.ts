import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { supplyChainSQLite } from './supply-chain-sqlite';
import { applyMigrations } from '../scripts/migrations';
import { supplyChainAPI } from '../src/supply-chain-api';
import { handle } from '../src/api';
import { sources } from '../src/sources';
import { hash, stable } from '../src/util';
import type { Source } from '../src/schema';

const now = '2026-10-22T09:43:00.000Z';
const credit =
  'このサービスは、政府統計総合窓口(e-Stat)のAPI機能を使用していますが、サービスの内容は国によって保証されたものではありません。';
let local: Awaited<ReturnType<typeof supplyChainSQLite>>;
let current: Source;
let configurationHash: string;
const metadata = {
  source: { source_id: 'estat_meti_seidou', source_url: 'https://www.e-stat.go.jp/' },
  attribution: '経済産業省生産動態統計、政府統計の総合窓口(e-Stat)を加工して作成',
  license: 'e-Stat利用規約（CC BY 4.0互換）',
  api_credit: credit,
  fetched_at: now,
  note: 'AI向け専用統計ではない',
};
async function api(path: string, sourceList = [current], at = now) {
  const response = await supplyChainAPI(
    new URL('https://local.test/v1/supply-chain/' + path),
    { PUBLIC_DB: local.env.PUBLIC_DB },
    at,
    sourceList,
  );
  return { response, status: response.status, body: (await response.json()) as any };
}
async function observation(
  id: string,
  value: string | null,
  flag: string | null = null,
  supersedes: string | null = null,
  expires = '2027-01-01T00:00:00.000Z',
  period = '2025-07',
) {
  return local.env.PUBLIC_DB.prepare(
    'INSERT INTO sc_observations VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
  )
    .bind(
      id,
      'synthetic-series',
      'synthetic-definition',
      'synthetic-batch',
      current.source_id,
      current.policy.version,
      configurationHash,
      period,
      value,
      flag,
      'annual',
      'synthetic-annual-table',
      null,
      now,
      'a'.repeat(64),
      supersedes,
      expires,
      stable({ ...metadata, obs_id: id, value_decimal: value, value_flag: flag, period }),
    )
    .run();
}
async function seed() {
  const db = local.env.PUBLIC_DB;
  await db
    .prepare('INSERT INTO source_publications VALUES (?,?,1,0,1,?,?,NULL,?)')
    .bind(
      current.source_id,
      current.policy.version,
      current.policy.valid_from,
      current.policy.valid_until,
      '{}',
    )
    .run();
  await db
    .prepare("INSERT INTO publication_batches VALUES (?,?,?,'complete',?,?)")
    .bind('synthetic-batch', current.source_id, current.policy.version, now, now)
    .run();
  await db
    .prepare('INSERT INTO sc_series VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .bind(
      'synthetic-series',
      current.source_id,
      current.policy.version,
      configurationHash,
      '00550200',
      '合成年報',
      'synthetic-item',
      '合成品目',
      'production_qty',
      '台',
      null,
      null,
      'synthetic-definition',
      stable({ ...metadata, series_id: 'synthetic-series', unit_raw: '台' }),
    )
    .run();
  await db
    .prepare('INSERT INTO sc_definition_versions VALUES (?,?,?,?,?,?,?,?)')
    .bind(
      'synthetic-definition',
      'synthetic-series',
      2025,
      '合成品目',
      '台',
      'synthetic-annual-table',
      null,
      stable({ definition_version_id: 'synthetic-definition', unit_raw: '台' }),
    )
    .run();
  await observation('synthetic-original', '1.2300');
}

beforeEach(async () => {
  local = await supplyChainSQLite();
  // No HTTP is used. An enabled synthetic copy authorizes only this isolated local test.
  current = structuredClone(sources.find((source) => source.source_id === 'estat_meti_seidou')!);
  current.enabled = true;
  configurationHash = await hash(
    stable({
      policy: current.policy,
      adapter: current.adapter,
      endpoint: current.endpoint,
      selection: current.selection,
      ...('estat' in current ? { estat: current.estat } : {}),
    }),
  );
});
afterEach(async () => {
  await local?.mf.dispose();
});

describe('e-Stat public projection and migration (synthetic only)', () => {
  it('returns exact decimals, missing flags, definitions and source notices with bounded history', async () => {
    await seed();
    await observation('synthetic-suppressed', null, 'X', null, undefined, '2025-08');
    await observation('synthetic-hyphen', null, '-', null, undefined, '2025-09');
    const series = await api('series');
    expect(series.status).toBe(200);
    expect(series.body.data[0].definitions).toEqual([
      { definition_version_id: 'synthetic-definition', unit_raw: '台' },
    ]);
    const first = await api('series/synthetic-series/observations?from=2025-07&to=2025-09&limit=1');
    expect(first.response.headers.get('cache-control')).toBe('no-store');
    expect(first.body.data[0]).toMatchObject({
      value_decimal: '1.2300',
      value_flag: null,
      api_credit: credit,
      note: 'AI向け専用統計ではない',
    });
    const second = await api(
      'series/synthetic-series/observations?from=2025-07&to=2025-09&limit=1&cursor=' +
        first.body.next_cursor,
    );
    expect(second.body.data[0]).toMatchObject({ value_decimal: null, value_flag: 'X' });
    expect(
      (
        await api(
          'series/synthetic-series/observations?from=2025-08&to=2025-09&cursor=' +
            first.body.next_cursor,
        )
      ).status,
    ).toBe(400);
  });

  it('reads revisions only while both immutable inputs remain publishable', async () => {
    await seed();
    await observation('synthetic-replacement', '1.24', null, 'synthetic-original');
    await local.env.PUBLIC_DB.prepare('INSERT INTO sc_revisions VALUES (?,?,?,?,?,?)')
      .bind(
        'synthetic-revision',
        'synthetic-series',
        'synthetic-original',
        'synthetic-replacement',
        now,
        stable({ ...metadata, revision_id: 'synthetic-revision' }),
      )
      .run();
    expect((await api('series/synthetic-series/revisions')).body.data).toHaveLength(1);
    expect((await api('series/synthetic-series/observations')).body.data).toHaveLength(2);
    await local.env.PUBLIC_DB.prepare('UPDATE source_publications SET derived_allowed=0').run();
    expect((await api('series/synthetic-series/revisions')).body.data).toEqual([]);
    expect((await api('series/synthetic-series/observations')).body.data).toHaveLength(2);
    expect((await api('series', [current], '2027-01-01T00:00:00.000Z')).body.data).toEqual([]);
  });

  it('fails closed for changed hashes, source rights, inactive/expired/revoked policies and incomplete batches', async () => {
    await seed();
    for (const mutation of [
      (source: Source) => {
        source.endpoint += '?changed=1';
      },
      (source: Source) => {
        source.policy.rights.public_display = 'denied';
      },
      (source: Source) => {
        source.policy.valid_until = now;
      },
      (source: Source) => {
        source.enabled = false;
      },
    ]) {
      const changed = structuredClone(current);
      mutation(changed);
      expect((await api('series', [changed])).body.data).toEqual([]);
      expect((await api('series/synthetic-series/observations', [changed])).body.data).toEqual([]);
    }
    for (const change of [
      'active=0',
      'active=1,revoked=1',
      "revoked=0,valid_until='2026-10-22T09:43:00.000Z'",
    ]) {
      await local.env.PUBLIC_DB.prepare('UPDATE source_publications SET ' + change).run();
      expect((await api('series')).body.data).toEqual([]);
    }
    await local.env.PUBLIC_DB.prepare(
      'UPDATE source_publications SET active=1,revoked=0,valid_until=NULL',
    ).run();
    await local.env.PUBLIC_DB.prepare("UPDATE publication_batches SET state='staging'").run();
    expect((await api('series')).body.data).toEqual([]);
  });

  it('rejects malformed queries without disclosing stored errors', async () => {
    for (const path of [
      'series?secret=x',
      'series?limit=0',
      'series?limit=101',
      'series?limit=1&limit=2',
      'series?cursor=bnVsbA',
      'series/synthetic-series/observations?from=2025-13',
      'series/synthetic-series/observations?from=2025-09&to=2025-01',
    ])
      expect((await api(path)).status).toBe(400);
    expect((await api('unknown')).status).toBe(404);
  });

  it('adds schema over populated Phase 1 and keeps legacy endpoints working before migration', async () => {
    await local.mf.dispose();
    local = await supplyChainSQLite(3);
    await local.env.PUBLIC_DB.prepare(
      'INSERT INTO source_publications VALUES (?,?,1,0,1,?,?,NULL,?)',
    )
      .bind('synthetic-existing', 'v1', now, null, '{}')
      .run();
    for (const path of [
      'series',
      'series/synthetic-series/observations',
      'series/synthetic-series/revisions',
    ]) {
      const response = await handle(
        new Request('https://local.test/v1/supply-chain/' + path),
        { PUBLIC_DB: local.env.PUBLIC_DB },
        now,
      );
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: { code: 'public_store_unavailable' } });
    }
    for (const path of ['/v1/sources', '/v1/datasets', '/health', '/openapi.json'])
      expect(
        (
          await handle(
            new Request('https://local.test' + path),
            { PUBLIC_DB: local.env.PUBLIC_DB },
            now,
          )
        ).status,
      ).toBe(200);
    await applyMigrations(local.env.PUBLIC_DB, 'public', 4);
    expect(
      await local.env.PUBLIC_DB.prepare('SELECT source_id FROM source_publications').first(),
    ).toEqual({ source_id: 'synthetic-existing' });
    expect((await api('series')).body.data).toEqual([]);
  });

  it('enforces decimal strings, foreign keys and append-only updates', async () => {
    await seed();
    for (const invalid of ['', '.', '-.', '1e3', '1.2.3', '--1', '.1', '1.', ' 1'])
      await expect(observation('invalid-' + invalid, invalid)).rejects.toThrow();
    for (const table of [
      'sc_series',
      'sc_definition_versions',
      'sc_observations',
      'sc_revisions',
    ]) {
      if (table === 'sc_revisions') {
        await observation('synthetic-replacement', '2', null, 'synthetic-original');
        await local.env.PUBLIC_DB.prepare('INSERT INTO sc_revisions VALUES (?,?,?,?,?,?)')
          .bind(
            'synthetic-revision',
            'synthetic-series',
            'synthetic-original',
            'synthetic-replacement',
            now,
            '{}',
          )
          .run();
      }
      await expect(
        local.env.PUBLIC_DB.prepare('UPDATE ' + table + " SET public_json='{}'").run(),
      ).rejects.toThrow(/immutable/);
    }
    await expect(
      local.env.PUBLIC_DB.prepare("DELETE FROM sc_series WHERE series_id='synthetic-series'").run(),
    ).rejects.toThrow(/FOREIGN KEY/);
  });
});
