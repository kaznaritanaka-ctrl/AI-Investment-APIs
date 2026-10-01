import { describe, it, expect } from 'vitest';
import {
  projectModelCatalog,
  modelEvidence,
  readModelEvidence,
  modelScopeHash,
} from '../src/models';
import { modelsAuthorizationReady, canCollect } from '../src/policy';
import { catalog, expandedSource } from './models-helpers';
import { time, source } from './helpers';
import proposal from '../config/proposals/models_dev.v3.json';
import { SourceSchema } from '../src/schema';
import { hash, stable } from '../src/util';
import { inspectPreflight } from '../scripts/preflight-core';
import { readFileSync } from 'node:fs';
import { sources } from '../src/sources';

describe('provider-scoped Models.dev projection (synthetic)', () => {
  it('preserves legacy regression fixtures and rejects the original unapproved proposal', () => {
    expect(source('models_dev').selection).toHaveLength(2);
    expect(source('models_dev').models).toBeUndefined();
    expect(canCollect(SourceSchema.parse(proposal), time)).toBe(false);
    const s = expandedSource();
    delete s.policy.models_scope;
    expect(modelsAuthorizationReady(s)).toBe(false);
  });
  it('limits the approved deployment candidate to the reviewed providers, fields and independent rights', () => {
    const active = sources.find((s) => s.source_id === 'models_dev')!;
    expect(active.policy.version).toBe('models_dev-20261001-v3');
    expect(active.enabled).toBe(true);
    expect(active.selection).toEqual([]);
    expect(active.models!.providers).toEqual(['openai', 'anthropic', 'google', 'xai', 'mistral']);
    expect(active.models!.fields).toEqual(proposal.models.fields);
    expect(active.policy.models_scope).toEqual(proposal.policy.models_scope);
    expect(active.models!.retention.normalized_days).toBe(1095);
    expect(active.models!.retention.backup_days).toBe(30);
    expect(active.policy.rights.external_llm_processing).toBe('denied');
    expect(active.policy.rights.raw_redistribution).toBe('denied');
    expect(canCollect(active, time)).toBe(true);
    expect(canCollect(active, active.policy.valid_until!)).toBe(false);
  });
  it('retains multiple providers, exact numeric tokens, explicit author mapping and date precision without secrets', async () => {
    const s = expandedSource(),
      body = JSON.stringify(catalog()).replace('"input":1', '"input":1.234567890123456789');
    const e = await modelEvidence(s, body, time, true),
      p = await readModelEvidence(s, e);
    expect(p.complete).toBe(true);
    expect(p.records).toHaveLength(5);
    expect(
      p.records.find((r) => r.catalog.serving_provider === 'openai')!.price!.price_components[0]
        .amount_decimal,
    ).toBe('1.234567890123456789');
    expect(p.records[0].catalog.model_author).toBe('synthetic-lab');
    expect(p.records[0].catalog.release_date).toBe('2025-06');
    expect(p.records[0].catalog.model_version).toBeNull();
    expect(e.body).not.toMatch(/unapproved description|Authorization|forbidden credential/);
  });
  it('requires approved providers and fields before projection and omits fields outside the grant', async () => {
    const s = expandedSource(['openai']);
    s.models!.providers.push('unapproved');
    await expect(projectModelCatalog('{}', s)).rejects.toThrow('model_scope_not_authorized');
    s.models!.providers = ['openai'];
    s.models!.fields = s.models!.fields.filter((f) => f !== 'limit.context');
    s.policy.models_scope!.fields = s.models!.fields;
    const p = await projectModelCatalog(JSON.stringify(catalog(2)), s);
    expect(p.records).toHaveLength(1);
    expect(p.records[0].catalog.context_limit).toBeNull();
    expect(p.records[0].catalog.missing_reasons['limit.context']).toBe('not_in_policy');
    expect(p.records.every((r) => r.catalog.serving_provider === 'openai')).toBe(true);
  });
  it('keeps a catalog record when only its pricing is unsupported; missing and zero are not free', async () => {
    const body = catalog();
    body.openai.models['synthetic-model-0'].cost = { input: 0, output: null, image: 123 };
    delete body.anthropic.models['synthetic-model-1'].cost;
    const p = await projectModelCatalog(JSON.stringify(body), expandedSource());
    expect(p.complete).toBe(true);
    expect(p.records).toHaveLength(5);
    const a = p.records.find((r) => r.catalog.serving_provider === 'openai')!;
    expect(a.price_issues).toContain('unsupported_pricing_structure');
    expect(a.price!.price_components.map((c) => c.price_state)).toEqual([
      'zero_unverified',
      'unknown',
    ]);
    expect(
      p.records.find((r) => r.catalog.serving_provider === 'anthropic')!.price!.price_components[0]
        .price_state,
    ).toBe('missing');
    expect(JSON.stringify(p)).not.toContain('free_confirmed');
  });
  it('preserves exact context thresholds and modes without doubling the upstream compatibility alias', async () => {
    const body = catalog(1, ['openai']),
      m = body.openai.models['synthetic-model-0'];
    m.cost.tiers = [{ tier: { type: 'context', size: 272000 }, input: 3, output: 8 }];
    m.cost.context_over_200k = { input: 3, output: 8 };
    m.experimental = { modes: { batch: { cost: { input: 0.5, output: 2 } } } };
    const p = await projectModelCatalog(JSON.stringify(body), expandedSource(['openai'])),
      r = p.records[0];
    expect(r.price_issues).toEqual([]);
    expect(r.price!.price_components).toHaveLength(7);
    expect(r.price!.price_components[3].tier_conditions).toContain('272000');
    expect(r.price!.price_components[5].pricing_mode).toBe('batch');
    m.experimental.modes.batch.cost.tiers = [
      { tier: { type: 'context', size: 128000 }, input: 2, output: 3 },
    ];
    expect(
      (await projectModelCatalog(JSON.stringify(body), expandedSource(['openai']))).records[0]
        .price_issues,
    ).toContain('unsupported_mode_tiers');
    delete m.cost.tiers;
    expect(
      (await projectModelCatalog(JSON.stringify(body), expandedSource(['openai']))).records[0]
        .price_issues,
    ).toContain('ambiguous_legacy_context_tier');
  });
  it('never calls a truncated or malformed catalog complete', async () => {
    const s = expandedSource();
    s.models!.max_models = 50;
    const p = await projectModelCatalog(JSON.stringify(catalog(51)), s);
    expect(p.complete).toBe(false);
    expect(p.enumerated_count).toBe(51);
    expect(p.records).toEqual([]);
    const body = catalog();
    delete body.google;
    expect((await projectModelCatalog(JSON.stringify(body), expandedSource())).complete).toBe(
      false,
    );
    body.google = { id: 'google', models: { bad: 42 } };
    expect((await projectModelCatalog(JSON.stringify(body), expandedSource())).complete).toBe(
      false,
    );
  });
  it.each([50, 250, 1000])(
    'projects %i models with per-model bounds and explicit total coverage',
    async (n) => {
      const p = await projectModelCatalog(JSON.stringify(catalog(n)), expandedSource());
      expect(p.complete).toBe(true);
      expect(p.records).toHaveLength(n);
      expect(p.records.every((r) => r.price!.price_components.length === 3)).toBe(true);
      expect(p.parse_elapsed_ms).toBeGreaterThan(0);
    },
  );
  it('versions changed scope without changing a prior scope fingerprint', async () => {
    const s = expandedSource(),
      old = await modelScopeHash(s);
    s.models!.providers.pop();
    expect(await modelScopeHash(s)).not.toBe(old);
  });
  it('revalidates evidence field grants rather than trusting a matching hash alone', async () => {
    const s = expandedSource(['openai']);
    s.models!.fields = s.models!.fields.filter((f) => f !== 'limit.context');
    const e = await modelEvidence(s, JSON.stringify(catalog(1, ['openai'])), time, true);
    const payload = JSON.parse(e.body);
    payload.records[0].catalog.context_limit = '999';
    e.body = stable(payload);
    e.evidence_hash = await hash(e.body);
    await expect(readModelEvidence(s, e)).rejects.toThrow('evidence_scope_mismatch');
  });
  it('rejects malformed JSON rather than repairing number tokens and preserves escaped strings', async () => {
    await expect(projectModelCatalog('{1:2}', expandedSource())).rejects.toThrow();
    await expect(
      projectModelCatalog(
        '{"openai":{"id":"openai","models":{},"x":01}}',
        expandedSource(['openai']),
      ),
    ).rejects.toThrow();
    const body = catalog(1, ['openai']);
    body.openai.description = 'unapproved \\"quotes 123 1e50';
    const text = JSON.stringify(body).replace('"input":1', '"input":1.234567890123456789e-2');
    expect(
      (await projectModelCatalog(text, expandedSource(['openai']))).records[0].price!
        .price_components[0].amount_decimal,
    ).toBe('0.01234567890123456789');
  });
  it('keeps expansion gates independent from currently approved legacy sources', () => {
    const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
    const d = read('config/deployment.json'),
      c = read('wrangler.collector.jsonc'),
      a = read('wrangler.api.jsonc');
    expect(inspectPreflight(d, c, a, [source('ecb'), source('models_dev')]).ready).toBe(true);
    const s = expandedSource();
    s.models!.max_models = 500;
    const free = { ...d, workers_plan: 'free' };
    expect(inspectPreflight(free, c, a, [s]).blockers).toContain(
      'models_dev:models_parse_and_d1_budget_requires_confirmed_paid_plan',
    );
    const paid = { ...d, workers_plan: 'paid' };
    expect(inspectPreflight(paid, c, a, [s]).ready).toBe(true);
    s.models!.max_models = 1000;
    expect(inspectPreflight(paid, c, a, [s]).blockers).toContain(
      'models_dev:models_daily_capacity_exceeds_existing_72_continuations',
    );
    s.models!.owner_approval_ref = null;
    expect(inspectPreflight(paid, c, a, [s]).blockers).toContain(
      'models_dev:models_owner_approval_missing',
    );
  });
});
