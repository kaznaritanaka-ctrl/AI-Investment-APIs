import { catalog, expandedSource } from '../tests/models-helpers';
import { sources } from '../src/sources';
export type BenchmarkCase = 'A' | 'B' | 'C';
export const benchmarkTime = '2026-10-03T18:17:35.000Z';
export function benchmarkInput(kind: BenchmarkCase) {
  const count = kind === 'A' ? 500 : kind === 'B' ? 250 : 500;
  const input = catalog(count);
  input.synthetic_unselected = {
    id: 'synthetic_unselected',
    models: {},
    description: 'x'.repeat(8 * 1024 * 1024),
  };
  const source =
    kind === 'A'
      ? structuredClone(sources.find((s) => s.source_id === 'models_dev')!)
      : expandedSource();
  source.source_id = 'synthetic_benchmark_' + kind;
  source.policy.version = 'synthetic-benchmark-v1';
  if (kind === 'A') source.selection = ['mistral/synthetic-model-4', 'mistral/synthetic-model-9'];
  else source.models!.max_models = 500;
  return {
    source,
    text: JSON.stringify(input),
    models: kind === 'A' ? 2 : count,
    components_per_model: 3,
    field_count: kind === 'A' ? 5 : source.models!.fields.length,
  };
}
