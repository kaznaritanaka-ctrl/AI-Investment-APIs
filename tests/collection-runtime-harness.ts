import type { CollectorEnv } from '../src/schema';
import { expandedSource, catalog } from './models-helpers';
import { gpuSource } from './gpu-helpers';
import { collectModels } from '../src/models-pipeline';
import { collectGPU } from '../src/gpu-pipeline';
import { resumeCollections } from '../src/collection-continuation';
import { expireGPUData } from '../src/gpu-retention';
import { readOperationalStatus } from '../src/operational-status';

const slot = '2026-10-06T18:17:00.000Z';
const resumedAt = '2026-10-06T19:00:00.000Z';

// All inputs below are invented. No production response, Secret or network access.
export async function collectionRuntime(request: Request, env: CollectorEnv) {
  const path = new URL(request.url).pathname;
  const models = expandedSource();
  models.source_id = 'synthetic_collection_models';
  models.models!.max_models = 500;
  const poc = gpuSource('price_of_compute');
  poc.max_records = 50;
  poc.gpu!.retention = {
    evidence_days: 7,
    archive_days: 7,
    normalized_days: 180,
    backup_days: 30,
    reviewed_ref: 'synthetic-private-retention',
  };
  for (const key of Object.keys(poc.policy.rights) as Array<keyof typeof poc.policy.rights>)
    poc.policy.rights[key] = [
      'automated_collection',
      'private_storage',
      'internal_analysis',
    ].includes(key)
      ? 'allowed'
      : 'review_required';

  const stats = { sql_statements: 0, max_batch: 0, mock_http_requests: 0 };
  const database = (db: D1Database) => {
    const originals = new WeakMap<object, D1PreparedStatement>();
    const wrap = (stmt: D1PreparedStatement): D1PreparedStatement => {
      const proxy = new Proxy(stmt, {
        get(target, key) {
          if (key === 'bind') return (...args: unknown[]) => wrap(target.bind(...args));
          if (['all', 'run', 'first', 'raw'].includes(String(key)))
            return (...args: unknown[]) => {
              stats.sql_statements++;
              return Reflect.apply(Reflect.get(target, key), target, args);
            };
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      originals.set(proxy, stmt);
      return proxy;
    };
    return new Proxy(db, {
      get(target, key) {
        if (key === 'prepare') return (sql: string) => wrap(target.prepare(sql));
        if (key === 'batch')
          return (rows: D1PreparedStatement[]) => {
            stats.sql_statements += rows.length;
            stats.max_batch = Math.max(stats.max_batch, rows.length);
            return target.batch(rows.map((row) => originals.get(row) ?? row));
          };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };
  const tracked = {
    ...env,
    PRIVATE_DB: database(env.PRIVATE_DB),
    PUBLIC_DB: database(env.PUBLIC_DB),
  };
  const mock =
    (body: unknown): typeof fetch =>
    async () => {
      stats.mock_http_requests++;
      return new Response(JSON.stringify(body), {
        headers: { 'content-type': 'application/json' },
      });
    };
  let result: unknown;
  if (path === '/collection-poc-intake') {
    result = await collectGPU(tracked, poc, slot, {
      synthetic: true,
      now: () => slot,
      network: {
        fetcher: mock({
          sku: 'H100-SXM',
          day: '2026-10-06',
          updated_at: '2026-10-06T17:00:00Z',
          providers: Array.from({ length: 50 }, (_, i) => ({
            provider: 'synthetic-budget-provider-' + i,
            pricing_type: 'on_demand',
            usd_per_gpu_hr: 2,
            region: 'synthetic-budget-region',
            observed_at: '2026-10-06T16:00:00Z',
          })),
        }),
      },
    });
  } else if (path === '/collection-models-intake') {
    result = await collectModels(tracked, models, slot, {
      synthetic: true,
      now: () => slot,
      network: { fetcher: mock(catalog(500)) },
    });
  } else if (path === '/collection-resume') {
    // Both intakes saved immutable evidence. Real dispatch must reuse it, not fetch.
    result = await resumeCollections(tracked, [models, poc], resumedAt);
  } else if (path === '/collection-retire') {
    result = { deleted: await expireGPUData(tracked, [poc], '2027-04-06T18:17:00.000Z') };
  } else if (path === '/collection-verify') {
    result = {
      models: await env.PRIVATE_DB.prepare(
        'SELECT state,stage,model_count,price_count FROM model_snapshots WHERE source_id=?',
      )
        .bind(models.source_id)
        .first(),
      poc: await env.PRIVATE_DB.prepare(
        'SELECT state,processing_stage,received_count FROM gpu_snapshots WHERE source_id=?',
      )
        .bind(poc.source_id)
        .first(),
      private_count: await env.PRIVATE_DB.prepare(
        'SELECT COUNT(*) n FROM observations WHERE source_id=?',
      )
        .bind(poc.source_id)
        .first('n'),
      public_count: await env.PUBLIC_DB.prepare(
        'SELECT COUNT(*) n FROM published_observations WHERE source_id=?',
      )
        .bind(poc.source_id)
        .first('n'),
      derived_count: await env.PRIVATE_DB.prepare(
        'SELECT COUNT(*) n FROM gpu_metric_lineage WHERE source_id=?',
      )
        .bind(poc.source_id)
        .first('n'),
      fk: (await env.PRIVATE_DB.prepare('PRAGMA foreign_key_check').all()).results,
      status: await readOperationalStatus(
        { ...env, COLLECTION_CRON: '17 18 * * *', COLLECTION_ENABLED: 'true' },
        [poc],
        resumedAt,
      ),
    };
  } else throw new Error('synthetic_collection_path_invalid');
  return Response.json({ result, ...stats });
}
