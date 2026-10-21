import { readFile } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import { localEnv } from '../scripts/local-env';
import { applyMigrations } from '../scripts/migrations';
import { activeSources } from '../src/sources';
import { collectSource } from '../src/pipeline';
import { fixture, responder } from './helpers';
import { catalog, finishModels } from './models-helpers';
import { finishGPU } from './gpu-helpers';

it('migrates the production 0006 schema with all three enabled sources, preserving private/public history and reruns', async () => {
  const local = await localEnv('test', undefined, 6);
  const at = '2026-10-18T18:17:00.000Z';
  const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected_network'));
  try {
    const byId = (id: string) => structuredClone(activeSources.find((s) => s.source_id === id)!);
    const ecb = byId('ecb'),
      models = byId('models_dev'),
      poc = byId('price_of_compute');
    const fx = await collectSource(local.env, ecb, at, {
      synthetic: true,
      now: () => at,
      network: {
        fetcher: responder(
          fixture('ecb.synthetic.xml').replace('2026-10-02', '2026-10-18'),
          'application/xml',
        ),
      },
    });
    expect(fx.state).toBe('complete');
    const modelRun = await finishModels(
      local.env,
      models,
      catalog(5, models.models!.providers),
      at,
    );
    expect(modelRun.result.state).toBe('complete');
    const gpuRun = await finishGPU(
      local.env,
      poc,
      responder(
        JSON.stringify({
          sku: 'H100-SXM',
          day: '2026-10-18',
          updated_at: '2026-10-18T17:00:00Z',
          providers: [
            {
              provider: 'synthetic-integration-provider',
              pricing_type: 'on_demand',
              usd_per_gpu_hr: '2.123456789012345678',
              region: 'synthetic-region',
              observed_at: '2026-10-18T16:00:00Z',
            },
          ],
        }),
      ),
      at,
    );
    expect(gpuRun.result.state).toBe('complete');

    const tables = (db: D1Database) =>
      db
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name<>'d1_migrations' ORDER BY name",
        )
        .all<{ name: string }>();
    const snapshot = async (db: D1Database, names: string[]) => {
      const out: Record<string, unknown[]> = {};
      for (const name of names)
        out[name] = (await db.prepare('SELECT * FROM "' + name + '" ORDER BY rowid').all()).results;
      return out;
    };
    const privateTables = (await tables(local.env.PRIVATE_DB)).results.map((t) => t.name);
    const publicTables = (await tables(local.env.PUBLIC_DB)).results.map((t) => t.name);
    const beforePrivate = await snapshot(local.env.PRIVATE_DB, privateTables);
    const beforePublic = await snapshot(local.env.PUBLIC_DB, publicTables);
    const beforeJournal = (
      await local.env.PUBLIC_DB.prepare('SELECT * FROM d1_migrations ORDER BY id').all()
    ).results;
    expect(
      await local.env.PRIVATE_DB.prepare(
        "SELECT COUNT(*) n FROM observations WHERE source_id='price_of_compute'",
      ).first('n'),
    ).toBe(1);
    expect(
      await local.env.PUBLIC_DB.prepare(
        "SELECT COUNT(*) n FROM published_observations WHERE source_id='price_of_compute'",
      ).first('n'),
    ).toBe(0);

    await applyMigrations(local.env.PRIVATE_DB, 'private');
    await applyMigrations(local.env.PRIVATE_DB, 'private');
    expect(await snapshot(local.env.PRIVATE_DB, privateTables)).toEqual(beforePrivate);
    expect(await snapshot(local.env.PUBLIC_DB, publicTables)).toEqual(beforePublic);
    expect(
      (await local.env.PUBLIC_DB.prepare('SELECT * FROM d1_migrations ORDER BY id').all()).results,
    ).toEqual(beforeJournal);
    const pending = JSON.parse(
      await readFile('docs/collector-integration-audit-20261018.json', 'utf8'),
    ).databases.private.pending_migrations;
    // The audit is immutable evidence from October 18, not a live migration
    // manifest. This integration adds 0015/0016 without rewriting that old journal.
    expect(pending).toHaveLength(8);
    expect(
      (
        await local.env.PRIVATE_DB.prepare(
          "SELECT name FROM d1_migrations WHERE name>='0007' ORDER BY name",
        ).all()
      ).results.map((r) => r.name),
    ).toEqual([
      ...pending.map((m: { name: string }) => m.name),
      '0015_daily_series_events.sql',
      '0016_daily_export_work.sql',
    ]);
    expect((await local.env.PRIVATE_DB.prepare('PRAGMA foreign_key_check').all()).results).toEqual(
      [],
    );
    await expect(
      local.env.PRIVATE_DB.prepare("UPDATE observations SET source_id='synthetic-overwrite'").run(),
    ).rejects.toThrow();
    for (const table of [
      'research_runs',
      'research_gpu_observations',
      'personal_daily_runs',
      'personal_daily_coverage',
      'personal_daily_checkpoints',
    ]) {
      expect(await local.env.PRIVATE_DB.prepare('SELECT COUNT(*) n FROM ' + table).first('n')).toBe(
        0,
      );
    }
    expect(network).not.toHaveBeenCalled();
  } finally {
    network.mockRestore();
    await local.mf.dispose();
  }
}, 120000);
