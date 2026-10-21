import { readFileSync } from 'node:fs';
import { it, expect } from 'vitest';
import deployment from '../config/deployment.json';
import { sources } from '../src/sources';
import { inspectPreflight } from '../scripts/preflight-core';

const collector = JSON.parse(readFileSync('wrangler.collector.jsonc', 'utf8'));
const api = JSON.parse(readFileSync('wrangler.api.jsonc', 'utf8'));
const fixture = () => structuredClone(sources);
const inspect = (selected = fixture(), d = deployment) =>
  inspectPreflight(d, collector, api, selected);

it('permits the reviewed 500-model plus one 50-row private H100 workload without extra Crons', () => {
  expect(inspect()).toMatchObject({ ready: true, errors: [], blockers: [] });
});

it('keeps combined collection blocked without its workload review', () => {
  expect(
    inspect(fixture(), { ...deployment, shared_collection_budget_review_ref: '' }).blockers,
  ).toContain('models_dev:shared_gpu_models_budget_requires_separate_review');
});

it.each(['public', 'sku', 'source', 'rows', 'window'] as const)(
  'requires a new workload review after widening %s',
  (kind) => {
    const selected = fixture();
    const poc = selected.find((s) => s.source_id === 'price_of_compute')!;
    if (kind === 'public') poc.policy.rights.public_display = 'allowed';
    if (kind === 'sku')
      poc.gpu!.partitions.push({ id: 'b200', query: { sku: 'b200' }, models: [] });
    if (kind === 'source') selected.find((s) => s.source_id === 'lambda')!.enabled = true;
    if (kind === 'rows') poc.max_records = 51;
    if (kind === 'window') poc.gpu!.snapshot_max_age_minutes = 720;
    expect(inspect(selected).blockers).toContain(
      'models_dev:shared_gpu_models_budget_requires_separate_review',
    );
  },
);

it('requires enough actual post-intake continuation slots for collection and retention', () => {
  const selected = fixture();
  selected.find((s) => s.source_id === 'models_dev')!.models!.max_models = 650;
  expect(inspect(selected).blockers).toContain(
    'models_dev:combined_daily_capacity_exceeds_existing_68_continuations',
  );
});
