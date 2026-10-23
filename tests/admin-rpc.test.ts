import { it, expect } from 'vitest';
import { build } from 'esbuild';
import { Miniflare, Log, LogLevel } from 'miniflare';
import { applyMigrations } from '../scripts/migrations';
import { AdminReport } from '../src/admin-contract';

it('serves the named read-only RPC entrypoint while the Collector HTTP surface stays closed', async () => {
  const compiled = await build({
    stdin: {
      contents: "export {default, AdminRead} from './src/collector';",
      resolveDir: process.cwd(),
      sourcefile: 'admin-rpc-runtime.ts',
      loader: 'ts',
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    external: ['cloudflare:workers'],
  });
  const mf = new Miniflare({
    cf: false,
    log: new Log(LogLevel.ERROR),
    workers: [
      {
        name: 'admin-test',
        modules: true,
        compatibilityDate: '2026-07-30',
        script:
          "export default {async fetch(request,env){if(new URL(request.url).pathname==='/highreso'){const results=[];for(const call of [()=>env.ADMIN_READ.highresoRuns(31),()=>env.ADMIN_READ.highresoLatestPrices()]){try{await call();results.push('unexpected')}catch(e){results.push(e.message)}}return Response.json(results)}const r=await env.ADMIN_READ.read('overview',{});return Response.json(r)}}",
        serviceBindings: { ADMIN_READ: { name: 'collector-test', entrypoint: 'AdminRead' } },
      },
      {
        name: 'collector-test',
        modules: true,
        compatibilityDate: '2026-07-30',
        script: compiled.outputFiles[0].text,
        d1Databases: ['PRIVATE_DB', 'PUBLIC_DB'],
        r2Buckets: ['EVIDENCE'],
        bindings: {
          COLLECTION_ENABLED: 'true',
          COLLECTION_CRON: '17 18 * * *',
          AGENT_ENABLED: 'false',
        },
      },
    ],
  });
  try {
    for (const [binding, name] of [
      ['PRIVATE_DB', 'private'],
      ['PUBLIC_DB', 'public'],
    ] as const)
      await applyMigrations(
        (await mf.getD1Database(binding, 'collector-test')) as unknown as D1Database,
        name,
      );
    const response = await mf.dispatchFetch('https://synthetic.test/api/overview');
    const report = AdminReport.parse(await response.json());
    expect(report.state).toBe('ready');
    expect(report.overview!.sources.length).toBeGreaterThan(2);
    const rpcErrors = await (await mf.dispatchFetch('https://synthetic.test/highreso')).json();
    expect(rpcErrors).toHaveLength(2);
    expect(JSON.stringify(rpcErrors)).not.toMatch(/not a function|unexpected/);
    const collector = await mf.getWorker('collector-test');
    expect((await collector.fetch('https://synthetic.test/highreso')).status).toBe(404);
    expect((await collector.fetch('https://synthetic.test/api/overview')).status).toBe(404);
    const db = await mf.getD1Database('PRIVATE_DB', 'collector-test');
    for (const table of [
      'collection_runs',
      'observations',
      'daily_summaries',
      'notification_outbox',
      'admin_release_ledger',
    ])
      expect(await db.prepare('SELECT COUNT(*) n FROM ' + table).first('n')).toBe(0);
  } finally {
    await mf.dispose();
  }
}, 30000);
