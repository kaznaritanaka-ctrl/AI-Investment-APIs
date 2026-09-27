import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { localEnv } from './local-env';
import { activeSources } from '../src/sources';
import { collectSource } from '../src/pipeline';
import { handle } from '../src/api';
import { PublicObservationSchema } from '../src/openapi';
import { recordSummary, deliverNotifications } from '../src/operations';
if (!process.argv.includes('--allow-network'))
  throw new Error('Explicit --allow-network opt-in is required.');
const started = new Date().toISOString();
const stateDir = resolve(process.env.AI_APIS_LOCAL_STATE_DIR ?? 'work/live/state');
const { env, mf } = await localEnv('development', stateDir);
const results: unknown[] = [];
try {
  for (const source of activeSources.filter((s) =>
    ['fx', 'ai_api_prices'].includes(s.dataset_type),
  )) {
    const wall = performance.now(),
      cpu = process.cpuUsage();
    let requests = 0;
    const result = await collectSource(env, source, started, {
      network: {
        fetcher: (async (...args: Parameters<typeof fetch>) => {
          requests++;
          return fetch(...args);
        }) as typeof fetch,
      },
    });
    const used = process.cpuUsage(cpu);
    const artifact = await env.PRIVATE_DB.prepare(
      'SELECT bytes,payload_hash,evidence_hash,observed_at FROM raw_artifacts WHERE run_id=?',
    )
      .bind(result.run_id)
      .first();
    const run = await env.PRIVATE_DB.prepare(
      'SELECT metrics_json FROM collection_runs WHERE run_id=?',
    )
      .bind(result.run_id)
      .first<{ metrics_json: string | null }>();
    const row = {
      ...result,
      http_requests: requests,
      elapsed_ms: Math.round(performance.now() - wall),
      node_host_cpu_ms: (used.user + used.system) / 1000,
      artifact,
      metrics: run?.metrics_json ? JSON.parse(run.metrics_json) : null,
    };
    results.push(row);
    console.log(
      JSON.stringify({
        source: source.source_id,
        state: result.state,
        reason: result.reason,
        requests,
        observations: result.observations,
        accepted: result.accepted,
        elapsed_ms: row.elapsed_ms,
      }),
    );
  }
  const response = await handle(new Request('https://local.invalid/v1/latest'), {
    PUBLIC_DB: env.PUBLIC_DB,
    ENVIRONMENT: 'development',
  });
  const apiBody = (await response.json()) as { data?: unknown[] };
  apiBody.data?.forEach((o) => PublicObservationSchema.parse(o));
  const summary = await recordSummary(
    env,
    started,
    results as Parameters<typeof recordSummary>[2],
    new Date().toISOString(),
  );
  const notification = await deliverNotifications(env, new Date().toISOString());
  const report = {
    test_kind: 'live_source_smoke_with_local_cloudflare_d1_r2',
    started_at: started,
    finished_at: new Date().toISOString(),
    production_deployed: false,
    scheduled_collection_running: false,
    fixture_data_used: false,
    agent_enabled: false,
    notification,
    measurement_limits:
      'Host CPU and elapsed time only; not Workers CPU, billed usage or a cloud free-tier guarantee.',
    node_max_rss_kib: process.resourceUsage().maxRSS,
    results,
    api: {
      status: response.status,
      schema_validated: !!apiBody.data,
      visible_records: apiBody.data?.length ?? 0,
    },
    summary,
  };
  await mkdir('work/live', { recursive: true });
  await writeFile('work/live/report.json', JSON.stringify(report, null, 2) + '\n');
  const publicReport = {
    ...report,
    summary: undefined,
    results: results.map((r) => {
      const x = r as any;
      return {
        source_id: x.source_id,
        state: x.state,
        reason: x.reason,
        observations: x.observations,
        accepted: x.accepted,
        quarantined: x.quarantined,
        issues: x.issues,
        http_requests: x.http_requests,
        elapsed_ms: x.elapsed_ms,
        node_host_cpu_ms: x.node_host_cpu_ms,
        response_bytes: x.artifact?.bytes ?? null,
        write_batch_metrics: x.metrics?.metrics ?? null,
        published: x.metrics?.publication?.published ?? 0,
      };
    }),
  };
  await writeFile('docs/live-smoke-report.json', JSON.stringify(publicReport, null, 2) + '\n');
  if (
    results.some((r) => ['failed', 'quarantined'].includes((r as { state: string }).state)) ||
    response.status !== 200
  )
    process.exitCode = 1;
} finally {
  await mf.dispose();
}
