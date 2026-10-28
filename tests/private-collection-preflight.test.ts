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

it('permits 500 models plus three private 50-row SKUs within the existing Crons', () => {
  expect(inspect()).toMatchObject({ ready: true, errors: [], blockers: [] });
  const models = fixture().find((s) => s.source_id === 'models_dev')!.models!;
  const modelSlots =
    2 +
    Math.ceil(models.max_models / models.models_per_invocation) +
    Math.ceil(models.max_models / 50) +
    Math.ceil(models.max_models / 25) +
    2;
  expect(modelSlots).toBe(54);
  expect(
    fixture()
      .find((s) => s.source_id === 'price_of_compute')!
      .gpu!.partitions.map((p) => p.id),
  ).toEqual(['h100-sxm', 'b200', 'b300']);
  expect(modelSlots + 4 * 3 + 2).toBe(68);
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
      poc.gpu!.partitions.push({ id: 'gb300', query: { sku: 'gb300' }, models: [] });
    if (kind === 'source') selected.find((s) => s.source_id === 'lambda')!.enabled = true;
    if (kind === 'rows') poc.max_records = 51;
    if (kind === 'window') poc.gpu!.snapshot_max_age_minutes = 720;
    expect(inspect(selected).blockers).toContain(
      'models_dev:shared_gpu_models_budget_requires_separate_review',
    );
  },
);

it.each([501, 650])(
  'blocks %i models because the full two-slot margin must fit after intake',
  (max) => {
    const selected = fixture();
    selected.find((s) => s.source_id === 'models_dev')!.models!.max_models = max;
    expect(inspect(selected).blockers).toContain(
      'models_dev:combined_daily_capacity_exceeds_existing_68_continuations',
    );
  },
);

it.each([
  ['COLLECTION_CRON', '12 18 * * *'],
  ['GPU_RESUME_CRON', '*/10 18-23 * * *'],
])('blocks EffectStory if %s no longer supplies the reviewed separate window', (key, value) => {
  const changed = structuredClone(collector);
  changed.vars[key] = value;
  changed.triggers.crons = Object.values({
    COLLECTION_CRON: changed.vars.COLLECTION_CRON,
    WATCHDOG_CRON: changed.vars.WATCHDOG_CRON,
    GPU_RESUME_CRON: changed.vars.GPU_RESUME_CRON,
  });
  expect(inspectPreflight(deployment, changed, api, fixture()).blockers).toContain(
    'effectstory:early_window_unavailable',
  );
});
