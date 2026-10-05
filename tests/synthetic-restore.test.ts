import { it, expect } from 'vitest';
import { localEnv } from '../scripts/local-env';
import { applyMigrations } from '../scripts/migrations';
import { collectSource } from '../src/pipeline';
import { handle } from '../src/api';
import { source, time, fxFetch } from './helpers';
import { expandedSource, catalog, finishModels } from './models-helpers';

// This harness accepts only in-memory test bindings. No production export/restore,
// Cloudflare credentials, remote URL, or R2 payload is involved.
async function restoreSynthetic(from: D1Database, to: D1Database) {
  const schema = (
    await from
      .prepare(
        "SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND sql IS NOT NULL ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END,name",
      )
      .all<{ type: string; name: string; sql: string }>()
  ).results;
  for (const entry of schema.filter((s) => s.type === 'table' && s.name !== 'd1_migrations'))
    await to.prepare(entry.sql).run();
  const inserts: D1PreparedStatement[] = [to.prepare('PRAGMA defer_foreign_keys=ON')];
  for (const table of schema.filter((s) => s.type === 'table')) {
    if (!/^[a-z0-9_]+$/.test(table.name)) throw new Error('unexpected_synthetic_table');
    const rows = (
      await from
        .prepare('SELECT * FROM ' + table.name + ' LIMIT 1001')
        .all<Record<string, unknown>>()
    ).results;
    if (rows.length > 1000) throw new Error('synthetic_export_limit');
    for (const row of rows) {
      const names = Object.keys(row);
      inserts.push(
        to
          .prepare(
            'INSERT INTO ' +
              table.name +
              '(' +
              names.map((n) => '"' + n + '"').join(',') +
              ') VALUES (' +
              names.map(() => '?').join(',') +
              ')',
          )
          .bind(...Object.values(row)),
      );
    }
  }
  await to.batch(inserts);
  for (const entry of schema.filter((s) => s.type !== 'table')) await to.prepare(entry.sql).run();
  expect((await to.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  const restoredSchema = (
    await to
      .prepare(
        "SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND sql IS NOT NULL ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END,name",
      )
      .all()
  ).results;
  expect(restoredSchema).toEqual(schema);
  return schema;
}

it('restores synthetic schema, immutable observations, lineage and corrections; forward metadata migration preserves readback', async () => {
  const original = await localEnv('test', undefined, 5),
    restored = await localEnv('test', undefined, 0);
  try {
    await collectSource(original.env, source('ecb'), time, {
      synthetic: true,
      now: () => time,
      network: { fetcher: fxFetch() },
    });
    const models = expandedSource(['openai']),
      body = catalog(2, ['openai']);
    await finishModels(original.env, models, body);
    const snapshot = (await original.env.PRIVATE_DB.prepare(
      'SELECT snapshot_id FROM model_snapshots',
    ).first('snapshot_id')) as string;
    const later = '2026-10-03T19:00:00.000Z';
    await finishModels(original.env, models, body, time, {
      now: () => later,
      parser: 'models-synthetic-correction',
      revision: { snapshot_id: snapshot, review_ref: 'synthetic restore review' },
    });
    for (const key of ['PRIVATE_DB', 'PUBLIC_DB'] as const) {
      const schema = await restoreSynthetic(original.env[key], restored.env[key]);
      const tables = schema.filter((s) => s.type === 'table');
      for (const table of tables)
        expect(
          await restored.env[key].prepare('SELECT COUNT(*) n FROM ' + table.name).first('n'),
        ).toBe(await original.env[key].prepare('SELECT COUNT(*) n FROM ' + table.name).first('n'));
    }
    for (const table of ['observations', 'lineage', 'model_snapshots', 'model_snapshot_members'])
      expect(
        (await restored.env.PRIVATE_DB.prepare('SELECT * FROM ' + table + ' ORDER BY 1').all())
          .results,
      ).toEqual(
        (await original.env.PRIVATE_DB.prepare('SELECT * FROM ' + table + ' ORDER BY 1').all())
          .results,
      );
    expect(
      await restored.env.PRIVATE_DB.prepare(
        'SELECT COUNT(*) n FROM observations WHERE supersedes_observation_id IS NOT NULL',
      ).first<number>('n'),
    ).toBeGreaterThan(0);
    for (const path of [
      '/v1/fx?base=USD&quote=JPY',
      '/v1/latest?dataset=ai_model_catalog',
      '/v1/latest?dataset=ai_model_catalog&as_of=' + time,
    ]) {
      const read = async (db: D1Database) =>
        (
          await handle(
            new Request('https://synthetic.test' + path),
            { PUBLIC_DB: db, ENVIRONMENT: 'test' },
            later,
          )
        ).json();
      expect(await read(restored.env.PUBLIC_DB)).toEqual(await read(original.env.PUBLIC_DB));
    }
    await applyMigrations(restored.env.PRIVATE_DB, 'private', 6);
    expect(
      await restored.env.PRIVATE_DB.prepare(
        "SELECT COUNT(*) n FROM d1_migrations WHERE name='0006_notification_incidents.sql'",
      ).first('n'),
    ).toBe(1);
    expect(
      (await restored.env.PRIVATE_DB.prepare('PRAGMA foreign_key_check').all()).results,
    ).toEqual([]);
    await expect(
      restored.env.PRIVATE_DB.prepare("UPDATE observations SET recorded_at='invalid'").run(),
    ).rejects.toThrow('append-only');
    const r = await handle(
      new Request('https://synthetic.test/v1/fx?base=USD&quote=JPY'),
      { PUBLIC_DB: restored.env.PUBLIC_DB, ENVIRONMENT: 'test' },
      later,
    );
    expect(r.status).toBe(200);
  } finally {
    await original.mf.dispose();
    await restored.mf.dispose();
  }
}, 60000);
