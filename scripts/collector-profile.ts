// Synthetic local probes only. Timings overlap; do not add them as pipeline stages.
import { parse as lossless } from 'lossless-json';
import { benchmarkInput, benchmarkTime, type BenchmarkCase } from './collector-benchmark-data';
import { sources } from '../src/sources';
import { SourceSchema } from '../src/schema';
import { canCollect } from '../src/policy';
import { projectModels, evidenceFromBody, parseEvidence } from '../src/adapters';
import { projectModelCatalog, modelEvidence, readModelEvidence } from '../src/models';
import { hash, stable } from '../src/util';
const kind = process.argv[2] as BenchmarkCase;
if (!['A', 'B', 'C'].includes(kind)) throw new Error('invalid_case');
const input = benchmarkInput(kind);
const measurements: Record<string, unknown>[] = [];
async function probe<T>(name: string, fn: () => T | Promise<T>): Promise<T> {
  global.gc?.();
  const before = process.memoryUsage(),
    cpu = process.cpuUsage(),
    start = performance.now();
  const result = await fn();
  const elapsed = performance.now() - start,
    used = process.cpuUsage(cpu),
    after = process.memoryUsage();
  measurements.push({
    name,
    elapsed_ms: elapsed,
    node_process_cpu_ms: (used.user + used.system) / 1000,
    rss_before_bytes: before.rss,
    rss_after_bytes: after.rss,
    heap_delta_bytes: after.heapUsed - before.heapUsed,
  });
  return result;
}
await probe('configuration_schema_policy', () =>
  sources.map((s) => canCollect(SourceSchema.parse(s), benchmarkTime)),
);
await probe('response_body_read_synthetic', () => new Response(input.text).text());
await probe('json_parse_only', () =>
  kind === 'A'
    ? lossless(input.text, undefined, (token) => token)
    : JSON.parse(input.text, (_key, value, context?: { source?: string }) =>
        typeof value === 'number' ? context!.source : value,
      ),
);
await probe<unknown>('projection_including_parse_schema_decimal', () =>
  kind === 'A'
    ? projectModels(input.text, input.source)
    : projectModelCatalog(input.text, input.source),
);
const evidence = await probe('evidence_including_projection_hash_serialization', () =>
  kind === 'A'
    ? evidenceFromBody(input.source, input.text, benchmarkTime, 200, new Headers(), true)
    : modelEvidence(input.source, input.text, benchmarkTime, true),
);
const domains = await probe('saved_evidence_validation', async () => {
  if (kind === 'A') {
    if ((await hash(evidence.body)) !== evidence.evidence_hash) throw new Error('integrity');
    return parseEvidence(input.source, evidence).candidates.map((c) => c.domain);
  }
  const p = await readModelEvidence(input.source, evidence);
  return p.records.flatMap((r) => [r.catalog, ...(r.price ? [r.price] : [])]);
});
const identities = await probe('domain_serialization_and_fingerprint_probe', async () => {
  const ids: string[] = [];
  for (const domain of domains) ids.push(await hash(stable({ domain, source_date: null })));
  return ids;
});
console.log(
  JSON.stringify({
    kind,
    input_bytes: Buffer.byteLength(input.text),
    unselected_padding_bytes: 8 * 1024 * 1024,
    selected_models: input.models,
    projection_bytes: Buffer.byteLength(evidence.body),
    output_observations: domains.length,
    components_per_model: input.components_per_model,
    field_count: input.field_count,
    output_domain_digest: await hash(stable(identities)),
    process_peak_rss_bytes: process.resourceUsage().maxRSS * 1024,
    node: process.version,
    measurements,
    cloud_cpu_measured: false,
    cloud_memory_measured: false,
    external_requests: 0,
    cold_module_startup_cpu: null,
  }),
);
