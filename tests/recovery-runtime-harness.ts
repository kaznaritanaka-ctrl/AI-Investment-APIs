import type { CollectorEnv } from '../src/schema';
import { collectModels } from '../src/models-pipeline';
import { loadRecoveryEvidence } from '../src/recovery-evidence';
import { reparseWrapperCandidate } from '../src/repair';
import { projectModelCatalog } from '../src/models';
import { catalog, expandedSource } from './models-helpers';

export async function recoveryRuntime(env: CollectorEnv) {
  const isolated = { ...env, SCHEMA_RECOVERY_ENABLED: 'true' },
    s = expandedSource();
  s.source_id = 'synthetic_recovery_models';
  const now = '2026-10-03T18:17:00.000Z',
    body = catalog();
  body.unselected = { id: 'unselected', description: 'x'.repeat(8 * 1024 * 1024), models: {} };
  const text = JSON.stringify({ data: body }),
    started = performance.now();
  let calls = 0;
  const result = await collectModels(isolated, s, now, {
    synthetic: true,
    now: () => now,
    network: {
      fetcher: (async () => {
        calls++;
        return new Response(text, { headers: { 'content-type': 'application/json' } });
      }) as typeof fetch,
    },
  });
  const e = await loadRecoveryEvidence(isolated, s, result.run_id, now);
  if (!e) throw new Error('synthetic_recovery_evidence_missing');
  const plan = await reparseWrapperCandidate(
    s,
    e,
    now,
    await projectModelCatalog(JSON.stringify(body), s),
  );
  const observations = await env.PRIVATE_DB.prepare(
    'SELECT COUNT(*) n FROM observations WHERE source_id=?',
  )
    .bind(s.source_id)
    .first<number>('n');
  const publicRows = await env.PUBLIC_DB.prepare(
    'SELECT COUNT(*) n FROM published_observations WHERE source_id=?',
  )
    .bind(s.source_id)
    .first<number>('n');
  return Response.json({
    state: result.state,
    reason: result.reason,
    calls,
    observations,
    publicRows,
    evidence_preserved: !!e.body,
    observed_at: e.observed_at,
    reparse: plan.reparse_result,
    records: plan.record_count,
    payload_bytes: new TextEncoder().encode(text).byteLength,
    retained_bytes: new TextEncoder().encode(e.body ?? '').byteLength,
    local_workerd_elapsed_ms: Math.round(performance.now() - started),
    gate: plan.gate,
  });
}
