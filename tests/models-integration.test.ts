import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { localEnv } from '../scripts/local-env';
import { applyMigrations } from '../scripts/migrations';
import { catalog, expandedSource, finishModels } from './models-helpers';
import { time, source, fxFetch, responder } from './helpers';
import { collectSource, collectAll } from '../src/pipeline';
import { collectModels, resumeModelRuns } from '../src/models-pipeline';
import { expireModels } from '../src/models-retention';
import { revokeSource } from '../src/publication';
import { handle } from '../src/api';
import { PublicObservationSchema } from '../src/openapi';
import { ModelCoverageSchema, ModelEventSchema } from '../src/models-schema';
import { modelStatusSQL, formatModelStatus } from '../src/models-status';
let local: Awaited<ReturnType<typeof localEnv>>;
beforeEach(async () => {
  local = await localEnv();
});
afterEach(async () => {
  await local?.mf.dispose();
});
const next = '2026-10-04T18:17:00.000Z',
  third = '2026-10-05T18:17:00.000Z';
const api = async (path: string, now = time) => {
  const r = await handle(
    new Request('https://local.test' + path),
    { PUBLIC_DB: local.env.PUBLIC_DB },
    now,
  );
  return { status: r.status, body: (await r.json()) as any };
};
const count = async (table: string) =>
  (await local.env.PRIVATE_DB.prepare('SELECT COUNT(*) n FROM ' + table).first<{ n: number }>())!.n;
describe('Models.dev bounded D1/R2 history (synthetic only)', () => {
  it('keeps staging private, completes multiple providers and preserves legacy default API shape', async () => {
    const s = expandedSource(),
      body = catalog();
    s.models!.models_per_invocation = 2;
    const fetched = vi.fn(responder(JSON.stringify(body))),
      opts = { synthetic: true, now: () => time, network: { fetcher: fetched } };
    expect((await collectModels(local.env, s, time, opts)).state).toBe('pending');
    expect((await collectModels(local.env, s, time, opts)).state).toBe('pending');
    expect((await api('/v1/latest?dataset=ai_model_catalog')).status).toBe(404);
    const { result } = await finishModels(local.env, s, body, time, opts);
    expect(result.state).toBe('complete');
    expect(fetched).toHaveBeenCalledTimes(1);
    expect(await count('ai_model_catalog')).toBe(5);
    expect(await count('ai_api_prices')).toBe(5);
    const models = (await api('/v1/latest?dataset=ai_model_catalog')).body.data;
    expect(models).toHaveLength(5);
    models.forEach((o: any) => PublicObservationSchema.parse(o));
    expect(models[0].source_effective_at).toBeNull();
    expect(models[0].first_model_observed_at).toBe(time);
    expect(
      (await api('/v1/latest')).body.data.every((o: any) => o.dataset === 'ai_api_prices'),
    ).toBe(true);
    const coverage = (await api('/v1/models/coverage')).body.data[0];
    ModelCoverageSchema.parse(coverage);
    expect(coverage.model_count).toBe(5);
    expect(coverage.price_component_count).toBe(15);
    expect((await api('/v1/models/events')).body.data.map((e: any) => e.kind)).toEqual(
      Array(5).fill('baseline_seen'),
    );
    (await api('/v1/models/events')).body.data.forEach((e: unknown) => ModelEventSchema.parse(e));
    expect((await api('/v1/models/events?cursor=invalid')).status).toBe(400);
    expect((await api('/v1/models/coverage?cursor=bnVsbA')).status).toBe(400);
    expect(JSON.stringify(models)).not.toMatch(
      /artifact_ref|payload_hash|lease_token|unapproved description|Authorization/,
    );
    expect((await collectModels(local.env, s, time, opts)).reason).toBe('already_processed');
    expect(await count('observations')).toBe(10);
    const status = formatModelStatus(
      (await local.env.PRIVATE_DB.prepare(modelStatusSQL).all()).results,
      [s],
      time,
    )[0];
    expect(status.fetch_attempts).toBe(1);
    expect(status.latest_complete_observed_at).toBe(time);
    expect(status.event_counts.baseline_seen).toBe(5);
    expect(status.freshness.stale).toBe(false);
  });
  it('keeps same-price daily observations and detects price, conditions and canonical changes separately', async () => {
    const s = expandedSource(['openai']),
      body = catalog(1, ['openai']);
    await finishModels(local.env, s, body);
    await finishModels(local.env, s, body, next);
    expect(await count('observations')).toBe(4);
    let obs = (await api('/v1/latest?dataset=ai_model_catalog', next)).body.data[0];
    expect(obs.first_seen_at).toBe(time);
    expect(obs.observed_at).toBe(next);
    body.openai.models['synthetic-model-0'].cost.input = 1.25;
    await finishModels(local.env, s, body, third);
    expect((await api('/v1/changes', third)).body.data).toHaveLength(1);
    const fourth = '2026-10-06T18:17:00.000Z';
    body.openai.models['synthetic-model-0'].canonical_model_id = 'synthetic-lab/version-new';
    body.openai.models['synthetic-model-0'].limit.context = 128000;
    body.openai.models['synthetic-model-0'].status = 'deprecated';
    await finishModels(local.env, s, body, fourth);
    const events = (await api('/v1/models/events', fourth)).body.data.map((e: any) => e.kind);
    expect(events).toContain('metadata_changed');
    expect(events).toContain('source_mapping_changed');
    expect(events).toContain('source_deprecated');
    expect(events).toContain('price_conditions_changed');
    expect((await api('/v1/changes', fourth)).body.data).toHaveLength(1);
  });
  // Five daily snapshots cross local D1/R2 RPC; allow slower Windows hosts without weakening assertions.
  it('separates disappearance and reappearance from deprecation and never treats partial or scope change as absence', async () => {
    const s = expandedSource(['openai']),
      body = catalog(2, ['openai']);
    await finishModels(local.env, s, body);
    const removed = body.openai.models['synthetic-model-1'];
    delete body.openai.models['synthetic-model-1'];
    await finishModels(local.env, s, body, next);
    let events = (await api('/v1/models/events', next)).body.data;
    expect(events.filter((e: any) => e.kind === 'not_seen')).toHaveLength(1);
    expect(events.some((e: any) => e.kind === 'source_deprecated')).toBe(false);
    expect((await api('/v1/latest?dataset=ai_model_catalog', next)).body.data).toHaveLength(1);
    body.openai.models['synthetic-model-1'] = removed;
    body.openai.models['synthetic-new'] = { ...removed, id: 'synthetic-new' };
    await finishModels(local.env, s, body, third);
    events = (await api('/v1/models/events', third)).body.data;
    expect(events.some((e: any) => e.kind === 'reappeared')).toBe(true);
    expect(events.some((e: any) => e.kind === 'first_seen')).toBe(true);
    const fourth = '2026-10-06T18:17:00.000Z';
    expect((await finishModels(local.env, s, {}, fourth)).result.state).toBe('partial');
    expect(
      (await api('/v1/models/events', fourth)).body.data.filter((e: any) => e.kind === 'not_seen'),
    ).toHaveLength(1);
    const changed = structuredClone(s);
    changed.policy.version = 'synthetic-scope-v4';
    changed.models!.max_models = 1;
    await finishModels(local.env, changed, catalog(1, ['openai']), '2026-10-07T18:17:00.000Z');
    const after = (await api('/v1/models/events', '2026-10-07T18:17:00.000Z')).body.data;
    expect(after.map((e: any) => e.kind)).toEqual(['baseline_seen']);
  }, 60_000);
  it('quarantines per-model unsupported and large price changes while catalog membership and other models remain valid', async () => {
    const s = expandedSource(['openai']),
      body = catalog(3, ['openai']);
    await finishModels(local.env, s, body);
    body.openai.models['synthetic-model-0'].cost.extra_unknown = { private_text: 'do not store' };
    body.openai.models['synthetic-model-1'].cost.input = 100;
    const r = await finishModels(local.env, s, body, next);
    expect(r.result.state).toBe('complete');
    expect(r.result.quarantined).toBe(2);
    expect((await api('/v1/latest?dataset=ai_model_catalog', next)).body.data).toHaveLength(3);
    expect((await api('/v1/latest?dataset=ai_api_prices', next)).body.data).toHaveLength(1);
    expect((await api('/v1/models/coverage', next)).body.data.at(-1).capture_complete).toBe(true);
    expect((await api('/v1/changes', next)).body.data).toEqual([]);
    expect(
      (await local.env.PUBLIC_DB.prepare(
        "SELECT COUNT(*) n FROM published_model_events WHERE json_extract(public_json,'$.kind')='price_changed'",
      ).first<{ n: number }>())!.n,
    ).toBe(0);
    expect((await finishModels(local.env, s, body, third)).result.quarantined).toBe(2);
  });
  it('resumes evidence after failure, rejects changed grants, and allows authorized private-only storage', async () => {
    const s = expandedSource(['openai']),
      body = catalog(1, ['openai']),
      fetcher = vi.fn(responder(JSON.stringify(body)));
    const first = await collectModels(local.env, s, time, {
      synthetic: true,
      now: () => time,
      network: { fetcher },
      afterEvidenceSaved: async () => {
        throw new Error('synthetic_failure');
      },
    });
    expect(first.state).toBe('failed');
    await finishModels(local.env, s, body, time, { network: { fetcher } });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const changed = structuredClone(s);
    changed.models!.fields = changed.models!.fields.filter((f) => f !== 'status');
    const fail = await collectModels(local.env, changed, next, {
      now: () => next,
      network: { fetcher },
    });
    expect(fail.reason).toBe('policy_version_mutated');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect((await api('/v1/latest', next)).status).toBe(404);
  });
  it('keeps private-only and revoked or expired lineage off all public endpoints', async () => {
    const s = expandedSource(['openai']);
    s.policy.rights.public_display = 'review_required';
    await finishModels(local.env, s, catalog(1, ['openai']));
    expect(await count('ai_model_catalog')).toBe(1);
    expect((await api('/v1/latest?dataset=ai_model_catalog')).status).toBe(404);
    expect((await api('/v1/models/events')).body.data).toEqual([]);
    expect((await api('/v1/models/coverage')).body.data).toEqual([]);
  });
  it('current revocation and normalized expiry hide both inputs and derived events', async () => {
    const s = expandedSource(['openai']),
      body = catalog(1, ['openai']);
    s.models!.retention.normalized_days = 2;
    await finishModels(local.env, s, body);
    body.openai.models['synthetic-model-0'].cost.input = 1.2;
    await finishModels(local.env, s, body, next);
    expect((await api('/v1/changes', next)).body.data).toHaveLength(1);
    expect((await api('/v1/changes', third)).body.data).toHaveLength(0);
    await expireModels(local.env, [s], third);
    expect(await count('observations')).toBe(2);
    expect((await local.env.PRIVATE_DB.prepare('PRAGMA foreign_key_check').all()).results).toEqual(
      [],
    );
    await revokeSource(local.env, s.source_id);
    expect((await api('/v1/latest?dataset=ai_model_catalog', third)).status).toBe(404);
    expect((await api('/v1/models/events', third)).body.data).toEqual([]);
  });
  it('only publishes after completion and returns append-only reviewed corrections under as_of', async () => {
    const s = expandedSource(['openai']),
      body = catalog(1, ['openai']);
    await finishModels(local.env, s, body);
    const original = (await api('/v1/latest?dataset=ai_model_catalog')).body.data[0];
    const snapshot = original.model_snapshot_id,
      later = '2026-10-03T19:00:00.000Z';
    const r = await finishModels(local.env, s, body, time, {
      now: () => later,
      parser: 'synthetic-models-parser-v2',
      revision: { snapshot_id: snapshot, review_ref: 'synthetic parser review' },
    });
    expect(r.result.state).toBe('complete');
    const current = (await api('/v1/latest?dataset=ai_model_catalog', later)).body.data[0];
    expect(current.supersedes_observation_id).toBe(original.observation_id);
    expect(current.observed_at).toBe(time);
    expect(
      (await api('/v1/latest?dataset=ai_model_catalog&as_of=' + time, later)).body.data[0]
        .observation_id,
    ).toBe(original.observation_id);
    await expect(
      local.env.PRIVATE_DB.prepare('UPDATE observations SET observed_at=? WHERE observation_id=?')
        .bind(later, original.observation_id)
        .run(),
    ).rejects.toThrow();
  });
  it('migration preserves populated Phase 1/2 observations, foreign keys and immutable triggers', async () => {
    await local.mf.dispose();
    local = await localEnv('test', undefined, 2);
    await collectSource(local.env, source('ecb'), time, {
      synthetic: true,
      now: () => time,
      network: { fetcher: fxFetch() },
    });
    const before = await local.env.PRIVATE_DB.prepare(
      'SELECT * FROM observations ORDER BY observation_id',
    ).all();
    await applyMigrations(local.env.PRIVATE_DB, 'private');
    await applyMigrations(local.env.PUBLIC_DB, 'public');
    expect(
      (
        await local.env.PRIVATE_DB.prepare(
          'SELECT * FROM observations ORDER BY observation_id',
        ).all()
      ).results,
    ).toEqual(before.results);
    expect((await local.env.PRIVATE_DB.prepare('PRAGMA foreign_key_check').all()).results).toEqual(
      [],
    );
    expect((await api('/v1/fx')).status).toBe(200);
    await expect(
      local.env.PRIVATE_DB.prepare("UPDATE observations SET recorded_at='bad'").run(),
    ).rejects.toThrow();
  });
  it('isolates parser failures and unauthorized expansion before HTTP while FX continues', async () => {
    const s = expandedSource(['openai']),
      fx = source('ecb');
    const bad = vi.fn((async (url: RequestInfo | URL, init?: RequestInit) =>
      String(url).includes('models.dev')
        ? responder('{broken')(url, init)
        : fxFetch()(url, init)) as typeof fetch);
    const results = await collectAll(local.env, [s, fx], time, {
      synthetic: true,
      now: () => time,
      network: { fetcher: bad },
    });
    expect(results.map((r) => r.state)).toEqual(['failed', 'complete']);
    expect(results[0].reason).toBe('catalog_parse_error');
    expect(await count('model_events')).toBe(0);
    expect((await api('/v1/fx')).status).toBe(200);
    const blocked = expandedSource(['openai']);
    blocked.source_id = 'synthetic_unapproved';
    blocked.models!.providers.push('unauthorized');
    const calls = bad.mock.calls.length;
    expect(
      (
        await collectModels(local.env, blocked, time, {
          now: () => time,
          network: { fetcher: bad },
        })
      ).state,
    ).toBe('policy_skipped');
    expect(bad.mock.calls.length).toBe(calls);
  });
  it('leases prevent parallel capture and checkpoint replay repairs an interrupted archive write', async () => {
    const s = expandedSource(['openai']),
      body = catalog(2, ['openai']);
    await collectModels(local.env, s, time, {
      synthetic: true,
      now: () => time,
      network: { fetcher: responder(JSON.stringify(body)) },
    });
    await local.env.PRIVATE_DB.prepare(
      'UPDATE collection_runs SET lease_token=?,lease_until=? WHERE source_id=?',
    )
      .bind('synthetic-held', next, s.source_id)
      .run();
    expect((await collectModels(local.env, s, time, { now: () => time })).state).toBe(
      'in_progress',
    );
    await local.env.PRIVATE_DB.prepare(
      'UPDATE collection_runs SET lease_token=NULL,lease_until=NULL WHERE source_id=?',
    )
      .bind(s.source_id)
      .run();
    const bucket = new Proxy(local.env.EVIDENCE, {
      get(target, key) {
        const value = (target as any)[key];
        return key === 'put'
          ? async () => {
              throw new Error('synthetic_archive_interrupted');
            }
          : typeof value === 'function'
            ? value.bind(target)
            : value;
      },
    });
    expect(
      (await collectModels({ ...local.env, EVIDENCE: bucket }, s, time, { now: () => time })).state,
    ).toBe('failed');
    expect(await count('observations')).toBe(4);
    expect((await api('/v1/latest?dataset=ai_model_catalog')).status).toBe(404);
    expect((await finishModels(local.env, s, body)).result.state).toBe('complete');
    expect(await count('observations')).toBe(4);
    expect((await api('/v1/latest?dataset=ai_model_catalog')).body.data).toHaveLength(2);
  });
  it('purges reviewed corrections before originals even when recorded timestamps tie and config is rolled back', async () => {
    const s = expandedSource(['openai']),
      body = catalog(1, ['openai']);
    s.models!.retention.normalized_days = 1;
    await finishModels(local.env, s, body);
    const original = (await api('/v1/latest?dataset=ai_model_catalog')).body.data[0];
    await finishModels(local.env, s, body, time, {
      parser: 'synthetic-revision',
      revision: { snapshot_id: original.model_snapshot_id, review_ref: 'synthetic review' },
    });
    expect(await count('observations')).toBe(4);
    await expireModels(local.env, [], next);
    await expireModels(local.env, [], next);
    expect(await count('observations')).toBe(0);
    expect((await local.env.PRIVATE_DB.prepare('PRAGMA foreign_key_check').all()).results).toEqual(
      [],
    );
  });
});
