// Synthetic only. Run in a fresh Node process per case; never fetch a live catalog.
import { catalog, expandedSource } from '../tests/models-helpers';
import { modelEvidence, readModelEvidence } from '../src/models';
const n = Number(process.argv[2]),
  padding = Number(process.argv[3]);
const input = catalog(n);
input.synthetic_unselected = {
  id: 'synthetic_unselected',
  models: {},
  description: 'x'.repeat(padding),
};
const text = JSON.stringify(input),
  s = expandedSource();
global.gc?.();
const baseline = process.memoryUsage(),
  cpu = process.cpuUsage(),
  start = performance.now();
const e = await modelEvidence(s, text, '2026-10-03T18:17:00.000Z', true);
const p = await readModelEvidence(s, e),
  used = process.cpuUsage(cpu),
  after = process.memoryUsage();
console.log(
  JSON.stringify({
    models: n,
    components_per_model: 3,
    unselected_padding_bytes: padding,
    payload_bytes: Buffer.byteLength(text),
    projection_bytes: Buffer.byteLength(e.body),
    model_count: p.records.length,
    selected_domain_bytes: p.records.reduce(
      (sum, r) =>
        sum +
        Buffer.byteLength(JSON.stringify(r.catalog)) +
        Buffer.byteLength(JSON.stringify(r.price)),
      0,
    ),
    elapsed_ms: performance.now() - start,
    node_cpu_ms: (used.user + used.system) / 1000,
    rss_before_bytes: baseline.rss,
    rss_after_bytes: after.rss,
    rss_delta_bytes: after.rss - baseline.rss,
    process_peak_rss_bytes: process.resourceUsage().maxRSS * 1024,
    heap_before_bytes: baseline.heapUsed,
    heap_after_bytes: after.heapUsed,
    cloud_isolate_memory_measured: false,
    cloud_cpu_measured: false,
    external_requests: 0,
  }),
);
