import { readFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
const args = process.argv.slice(2);
if (
  args.some((a) => !['--remote', '--allow-network'].includes(a)) ||
  args.includes('--remote') !== args.includes('--allow-network')
)
  throw new Error('Use offline default or --remote --allow-network (fixed GET/SELECT only)');
const remote = args.includes('--remote');
if (!remote) {
  console.log(
    JSON.stringify(
      {
        mode: 'offline',
        network_performed: false,
        external_monitor: 'not_verified',
        next: 'Run synthetic tests; remote checks require an existing read-only token and --remote --allow-network.',
      },
      null,
      2,
    ),
  );
  process.exit(0);
}
const settings = JSON.parse(readFileSync('config/deployment.json', 'utf8'));
const collector = JSON.parse(readFileSync('wrangler.collector.jsonc', 'utf8'));
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!token) throw new Error('read_only_cloudflare_token_not_configured');
if (process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_ACCOUNT_ID !== settings.account_id)
  throw new Error('account_mismatch');
const now = new Date().toISOString();
async function request(path, body) {
  const r = await fetch(
    'https://api.cloudflare.com/client/v4/accounts/' + settings.account_id + path,
    {
      method: body ? 'POST' : 'GET',
      headers: {
        authorization: 'Bearer ' + token,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(20000),
    },
  );
  if (!r.ok) {
    await r.body?.cancel();
    throw new Error('metadata_http_' + r.status);
  }
  const data = await r.json();
  if (!data.success) throw new Error('metadata_query_failed');
  return data.result;
}
function database(id) {
  return {
    prepare(sql) {
      if (!/^SELECT\b/i.test(sql.trim()) || sql.includes(';'))
        throw new Error('only_single_select_allowed');
      let params = [];
      const statement = {
        bind(...p) {
          params = p;
          return statement;
        },
        async all() {
          const results = await request('/d1/database/' + id + '/query', { sql, params });
          if (
            results.length !== 1 ||
            results[0].success !== true ||
            (results[0].meta?.rows_written ?? 0) !== 0
          )
            throw new Error('unexpected_query_result');
          return { results: results[0].results };
        },
        async first(column) {
          const row = (await statement.all()).results[0] ?? null;
          return column && row ? row[column] : row;
        },
      };
      return statement;
    },
  };
}
mkdirSync('work', { recursive: true });
await build({
  entryPoints: ['src/operational-status.ts', 'src/sources.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outdir: 'work/operations-check',
  logLevel: 'warning',
});
const { readOperationalStatus, apiReachability } = await import(
  pathToFileURL(resolve('work/operations-check/operational-status.js')).href
);
const { sources } = await import(pathToFileURL(resolve('work/operations-check/sources.js')).href);
const deployed = await request('/workers/scripts/ai-investment-collector/settings');
const vars = Object.fromEntries(
  deployed.bindings
    .filter((b) => ['COLLECTION_CRON', 'COLLECTION_ENABLED'].includes(b.name))
    .map((b) => [b.name, b.text]),
);
const bindings = Object.fromEntries(collector.d1_databases.map((b) => [b.binding, b.database_id]));
for (const name of ['PRIVATE_DB', 'PUBLIC_DB'])
  if (deployed.bindings.find((b) => b.name === name)?.id !== bindings[name])
    throw new Error('database_binding_mismatch');
const report = await readOperationalStatus(
  {
    ...vars,
    PRIVATE_DB: database(bindings.PRIVATE_DB),
    PUBLIC_DB: database(bindings.PUBLIC_DB),
    ENVIRONMENT: 'production',
  },
  sources,
  now,
);
let status = null;
try {
  const r = await fetch('https://api.' + settings.owned_domain + '/health', {
    redirect: 'manual',
    signal: AbortSignal.timeout(10000),
  });
  status = r.status;
  await r.body?.cancel();
} catch {
  /* No response body or request credentials are recorded. */
}
report.api_reachability = apiReachability(status);
console.log(
  JSON.stringify(
    {
      ...report,
      mode: 'remote_read_only',
      http_status: status,
      network_performed: true,
      notification_delivery: 'not_attempted',
    },
    null,
    2,
  ),
);
if (
  report.api_reachability !== 'reachable' ||
  report.sources.some((s) => s.signals.some((x) => ['alert', 'unknown'].includes(x.condition)))
)
  process.exitCode = 2;
