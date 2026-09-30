import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const load = async (label) =>
  JSON.parse(await readFile('work/collector-benchmark-' + label + '.json', 'utf8'));
const before = await load('before'),
  after = await load('after');
const stats = (values) => {
  const v = values.toSorted((a, b) => a - b);
  return { min: v[0], median: v[Math.floor(v.length / 2)], max: v.at(-1) };
};
const sum = (steps, key) => steps.reduce((n, r) => n + r[key], 0);
const cases = ['A', 'B', 'C'].map((kind) => {
  const outputs = [before, after].flatMap((r) => r.probes.filter((p) => p.kind === kind));
  assert.equal(new Set(outputs.map((p) => p.output_domain_digest)).size, 1, 'domain changed');
  const first = outputs[0];
  return {
    kind,
    input_bytes: first.input_bytes,
    unselected_padding_bytes: first.unselected_padding_bytes,
    selected_models: first.selected_models,
    output_observations: first.output_observations,
    fields: first.field_count,
    components_per_model: first.components_per_model,
    unchanged_domain_digest: first.output_domain_digest,
    measurements: Object.fromEntries(
      [before, after].map((r) => {
        const probes = r.probes.filter((p) => p.kind === kind),
          rt = r.runtime.find((p) => p.kind === kind),
          steps = rt.steps;
        return [
          r.label,
          {
            node_trials: probes.length,
            process_peak_rss_bytes: stats(probes.map((p) => p.process_peak_rss_bytes)),
            probes: probes[0].measurements.map((m) => ({
              name: m.name,
              elapsed_ms: stats(
                probes.map((p) => p.measurements.find((x) => x.name === m.name).elapsed_ms),
              ),
              node_process_cpu_ms: stats(
                probes.map(
                  (p) => p.measurements.find((x) => x.name === m.name).node_process_cpu_ms,
                ),
              ),
              heap_delta_bytes: stats(
                probes.map((p) => p.measurements.find((x) => x.name === m.name).heap_delta_bytes),
              ),
            })),
            workerd: {
              trials: 1,
              invocations: steps.length,
              published: rt.published,
              total_elapsed_ms: sum(steps, 'local_workerd_elapsed_ms'),
              invocation_elapsed_ms: stats(steps.map((s) => s.local_workerd_elapsed_ms)),
              sql_statements: sum(steps, 'sql_statements'),
              private_statements: sum(steps, 'private_statements'),
              public_statements: sum(steps, 'public_statements'),
              max_sql_statements_per_invocation: Math.max(...steps.map((s) => s.sql_statements)),
              max_sql_statements_per_binding_per_invocation: Math.max(
                ...steps.flatMap((s) => [s.private_statements, s.public_statements]),
              ),
              d1_calls: sum(steps, 'd1_calls'),
              max_d1_calls_per_invocation: Math.max(...steps.map((s) => s.d1_calls)),
              max_batch: Math.max(...steps.map((s) => s.max_batch)),
              rows_read: sum(steps, 'rows_read'),
              rows_written: sum(steps, 'rows_written'),
              r2_get: sum(steps, 'r2_get'),
              r2_put: sum(steps, 'r2_put'),
              r2_head: sum(steps, 'r2_head'),
              mock_http: sum(steps, 'mock_http'),
              cloud_cpu_ms: null,
              isolate_memory_bytes: null,
            },
          },
        ];
      }),
    ),
  };
});
const result = {
  measured_on: '2026-09-30',
  node: before.probes[0].node,
  kind: 'synthetic_local_only',
  notes: [
    ...before.notes,
    'Windows process CPU has coarse resolution; a zero sample does not mean zero CPU.',
    'Microprobe process peak RSS includes multiple probes/allocator high water; it is not a Worker isolate peak.',
    'Runtime measures the pipeline, excluding scheduled summary, notification and retention overhead.',
  ],
  cold_startup_cpu_ms: null,
  production_cpu_after_change_ms: null,
  external_source_requests: 0,
  cases,
};
await writeFile('docs/collector-performance-results.json', JSON.stringify(result, null, 2) + '\n');
for (const c of cases)
  console.log(
    JSON.stringify({
      case: c.kind,
      bytes: c.input_bytes,
      models: c.selected_models,
      before: c.measurements.before.probes.map((p) => [
        p.name,
        p.elapsed_ms.median,
        p.node_process_cpu_ms.median,
      ]),
      after: c.measurements.after.probes.map((p) => [
        p.name,
        p.elapsed_ms.median,
        p.node_process_cpu_ms.median,
      ]),
      before_runtime: c.measurements.before.workerd,
      after_runtime: c.measurements.after.workerd,
      rss_before: c.measurements.before.process_peak_rss_bytes,
      rss_after: c.measurements.after.process_peak_rss_bytes,
    }),
  );
