import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { localEnv } from '../scripts/local-env';
import { collectSource, collectAll } from '../src/pipeline';
import { ingestEvidence } from '../src/ingest';
import * as adapters from '../src/adapters';
import { revokeSource, syncSource, visibleJoin, visibleSQL } from '../src/publication';
import { handle } from '../src/api';
import { PublicObservationSchema, openapi } from '../src/openapi';
import { deliverNotifications, recordSummary, watchdog, expireEvidence } from '../src/operations';
import { hash } from '../src/util';
import type { Evidence } from '../src/schema';
import { source, modelSource, time, fxFetch, aiFetch, fixture, responder } from './helpers';
let local: Awaited<ReturnType<typeof localEnv>>;
beforeEach(async () => {
  local = await localEnv();
});
afterEach(async () => {
  await local?.mf.dispose();
});
const count = async (table: string, db = local.env.PRIVATE_DB) =>
  (await db.prepare('SELECT COUNT(*) AS n FROM ' + table).first<{ n: number }>())!.n;
const api = (path: string, now = time) =>
  handle(
    new Request('https://api.test' + path),
    { PUBLIC_DB: local.env.PUBLIC_DB, ENVIRONMENT: 'test' },
    now,
  );
const fx = () =>
  collectSource(local.env, source('ecb'), time, {
    synthetic: true,
    now: () => time,
    network: { fetcher: fxFetch() },
  });
describe('Cloudflare D1/R2 integration (synthetic only)', () => {
  it('runs ingestion, evidence, history, derivation and schema-checked API', async () => {
    expect((await fx()).state).toBe('complete');
    expect(await count('observations')).toBe(2);
    expect(await count('raw_artifacts')).toBe(1);
    expect(await count('derived_observations')).toBe(1);
    expect(await count('lineage')).toBe(2);
    const r = await api('/v1/fx?base=USD&quote=JPY'),
      body = (await r.json()) as any;
    expect(r.status).toBe(200);
    PublicObservationSchema.parse(body.data);
    expect(body.data.value.rate_decimal).toBe('150');
    expect(body.data.lineage).toHaveLength(2);
    expect(body.data.data_origin).toBe('synthetic');
    expect(JSON.stringify(body)).not.toMatch(/raw_artifact|payload_hash|lease_token|evidence\//);
    expect(r.headers.get('cache-control')).toBe('no-store');
  });
  it('is idempotent in one slot but records same price next day; absence is distinct', async () => {
    const fetcher = vi.fn(fxFetch());
    const opts = { synthetic: true, now: () => time, network: { fetcher } };
    await collectSource(local.env, source('ecb'), time, opts);
    await collectSource(local.env, source('ecb'), time, opts);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await count('observations')).toBe(2);
    const tomorrow = '2026-10-04T18:17:00.000Z';
    await collectSource(local.env, source('ecb'), tomorrow, { ...opts, now: () => tomorrow });
    expect(await count('observations')).toBe(4);
    expect(await count('change_events')).toBe(0);
    expect(await count('collection_runs')).toBe(2);
    const missing = await watchdog(
      local.env,
      [source('ecb')],
      '2026-10-05T18:17:00.000Z',
      '2026-10-05T18:47:00.000Z',
    );
    expect(missing[0].state).toBe('missing');
    expect(await count('observations')).toBe(4);
  });
  it('304 records a new validation without inventing a new FX source date', async () => {
    await fx();
    let conditional: string | null = null;
    const fetcher = (async (_u: unknown, init?: RequestInit) => {
      conditional = new Headers(init?.headers).get('if-none-match');
      return new Response(null, { status: 304 });
    }) as typeof fetch;
    const next = '2026-10-04T18:17:00.000Z';
    expect(
      (
        await collectSource(local.env, source('ecb'), next, {
          synthetic: true,
          now: () => next,
          network: { fetcher },
        })
      ).state,
    ).toBe('complete');
    expect(conditional).toBe('"synthetic-etag"');
    const rows = await local.env.PRIVATE_DB.prepare(
      'SELECT DISTINCT source_date FROM fx_observations',
    ).all();
    expect(rows.results).toEqual([{ source_date: '2026-10-02' }]);
    expect(await count('observations')).toBe(4);
  });
  it('isolates failed/blocked sources and does not fetch OpenRouter', async () => {
    const f = vi.fn((async (u: string | URL | Request) =>
      String(u).includes('ecb.europa')
        ? new Response(null, { status: 403 })
        : aiFetch()(u)) as typeof fetch);
    const results = await collectAll(
      local.env,
      [source('ecb'), modelSource(), source('openrouter')],
      time,
      { synthetic: true, now: () => time, network: { fetcher: f } },
    );
    expect(results.map((r) => r.state)).toEqual(['failed', 'complete', 'policy_skipped']);
    expect(await count('ai_api_prices')).toBe(1);
    expect(f).toHaveBeenCalledTimes(2);
    expect(f.mock.calls.some((c) => String(c[0]).includes('openrouter'))).toBe(false);
  });
  it('recovers evidence saved before DB registration without a refetch', async () => {
    const f = vi.fn(fxFetch());
    const bad = await collectSource(local.env, source('ecb'), time, {
      synthetic: true,
      now: () => time,
      network: { fetcher: f },
      afterEvidenceSaved: async () => {
        throw new Error('simulated_db_failure');
      },
    });
    expect(bad.state).toBe('failed');
    expect(await count('raw_artifacts')).toBe(0);
    const good = await collectSource(local.env, source('ecb'), time, {
      synthetic: true,
      now: () => time,
      network: { fetcher: f },
    });
    expect(good.state).toBe('complete');
    expect(f).toHaveBeenCalledTimes(1);
    expect(await count('observations')).toBe(2);
  });
  it('replays as an append-only parser correction without backdating knowledge', async () => {
    await fx();
    const run = await hash('ecb|' + time),
      key = 'evidence/ecb/' + run + '.json';
    const evidence = await (await local.env.EVIDENCE.get(key))!.json<Evidence>();
    const later = '2026-10-04T18:17:00.000Z';
    await ingestEvidence(
      local.env,
      source('ecb'),
      run,
      time,
      key,
      evidence,
      later,
      'correction-test-v2',
    );
    expect(await count('observations')).toBe(4);
    const corrections = await local.env.PRIVATE_DB.prepare(
      'SELECT observed_at,recorded_at,supersedes_observation_id FROM observations WHERE parser_version=?',
    )
      .bind('correction-test-v2')
      .all<any>();
    expect(
      corrections.results.every(
        (r) => r.observed_at === time && r.recorded_at === later && r.supersedes_observation_id,
      ),
    ).toBe(true);
    const old = (await (
      await api('/v1/fx?base=EUR&quote=USD&as_of=' + encodeURIComponent(time), later)
    ).json()) as any;
    expect(old.data.recorded_at).toBe(time);
    const current = (await (await api('/v1/fx?base=EUR&quote=USD', later)).json()) as any;
    expect(current.data.recorded_at).toBe(later);
    await expect(
      local.env.PRIVATE_DB.prepare("UPDATE observations SET fingerprint='changed'").run(),
    ).rejects.toThrow();
  });
  it('hides staging batches and allows completed batches atomically', async () => {
    await fx();
    await local.env.PUBLIC_DB.prepare("UPDATE publication_batches SET state='staging'").run();
    expect((await api('/v1/fx')).status).toBe(404);
    await local.env.PUBLIC_DB.prepare("UPDATE publication_batches SET state='complete'").run();
    expect((await api('/v1/fx')).status).toBe(200);
  });
  it('withdraws source and derived records, uses no cache and does not reactivate revoked policy', async () => {
    await fx();
    await revokeSource(local.env, 'ecb');
    await syncSource(local.env, source('ecb'), time);
    expect((await api('/v1/fx')).status).toBe(404);
    expect((await api('/v1/fx?base=USD&quote=JPY')).status).toBe(404);
    expect((await api('/v1/observations')).headers.get('cache-control')).toBe('no-store');
    expect(await count('published_observations', local.env.PUBLIC_DB)).toBe(3);
  });
  it('checks expiry at read time even without a running collector', async () => {
    await fx();
    const future = '2026-12-27T18:17:00.000Z';
    expect((await api('/v1/fx', future)).status).toBe(404);
    expect(((await (await api('/v1/sources', future)).json()) as any).data).toEqual([]);
  });
  it('prevents private-only or unapproved derived publication', async () => {
    const s = source('ecb');
    s.policy.version = 'private-only';
    s.policy.rights.normalized_redistribution = 'review_required';
    const r = await collectSource(local.env, s, time, {
      synthetic: true,
      now: () => time,
      network: { fetcher: fxFetch() },
    });
    expect(r.state).toBe('complete');
    expect(await count('observations')).toBe(2);
    expect(await count('published_observations', local.env.PUBLIC_DB)).toBe(0);
  });
  it('does not send synthetic values to development or production stores', async () => {
    const f = vi.fn(fxFetch());
    const r = await collectSource(
      { ...local.env, ENVIRONMENT: 'production' },
      source('ecb'),
      time,
      { synthetic: true, now: () => time, network: { fetcher: f } },
    );
    expect(r.reason).toBe('synthetic_data_blocked');
    expect(f).not.toHaveBeenCalled();
    expect(await count('observations')).toBe(0);
  });
  it('quarantines a large price change and marks a returned prior value stale', async () => {
    const s = modelSource();
    await collectSource(local.env, s, time, {
      synthetic: true,
      now: () => time,
      network: { fetcher: aiFetch() },
    });
    const next = '2026-10-04T18:17:00.000Z';
    const r = await collectSource(local.env, s, next, {
      synthetic: true,
      now: () => next,
      network: { fetcher: responder(fixture('models.synthetic.json').replace('1.25', '0.01')) },
    });
    expect(r.state).toBe('quarantined');
    expect(await count('observations')).toBe(2);
    expect(await count('change_events')).toBe(1);
    const body = (await (await api('/v1/latest?dataset=ai_api_prices', next)).json()) as any;
    expect(body.data[0].value.price_components[0].amount_decimal).toBe('1.25');
    expect(body.data[0].stale_reason).toBe('newer_observation_quarantined');
  });
  it('stable cursors exclude concurrent additions and reject changed filters', async () => {
    await fx();
    const first = (await (await api('/v1/observations?dataset=fx&limit=1')).json()) as any;
    expect(first.next_cursor).toBeTruthy();
    const next = '2026-10-04T18:17:00.000Z';
    await collectSource(local.env, source('ecb'), next, {
      synthetic: true,
      now: () => next,
      network: { fetcher: fxFetch() },
    });
    const second = (await (
      await api(
        '/v1/observations?dataset=fx&limit=100&cursor=' + encodeURIComponent(first.next_cursor),
        next,
      )
    ).json()) as any;
    expect(second.data).toHaveLength(2);
    expect(new Set([...first.data, ...second.data].map((o) => o.observation_id)).size).toBe(3);
    expect(
      (
        await api(
          '/v1/observations?dataset=ai_api_prices&cursor=' + encodeURIComponent(first.next_cursor),
          next,
        )
      ).status,
    ).toBe(400);
  });
  it('validates API filters, methods, errors, OpenAPI and optional rate limiting', async () => {
    await fx();
    for (const path of [
      '/v1/observations?limit=101',
      '/v1/observations?limit=0',
      '/v1/observations?url=http://evil',
      '/v1/observations?cursor=broken',
      '/v1/observations?cursor=bnVsbA',
      '/v1/observations?cursor=W10',
      '/v1/fx?base=usd',
      '/v1/observations?from=2020-01-01T00:00:00.000Z&to=2026-01-01T00:00:00.000Z',
    ])
      expect((await api(path)).status).toBe(400);
    expect((await api('/v1/fx?as_of=2026-10-02T00:00:00.000Z')).status).toBe(404);
    expect(
      (
        await handle(
          new Request('https://api.test/health', { method: 'POST' }),
          { PUBLIC_DB: local.env.PUBLIC_DB },
          time,
        )
      ).status,
    ).toBe(405);
    expect(
      (
        await handle(
          new Request('https://api.test/health'),
          {
            PUBLIC_DB: local.env.PUBLIC_DB,
            RATE_LIMITER: { limit: async () => ({ success: false }) },
          },
          time,
        )
      ).status,
    ).toBe(429);
    expect(((await (await api('/openapi.json')).json()) as any).paths).toEqual(openapi.paths);
    const history = (await (await api('/v1/observations')).json()) as any;
    history.data.forEach((x: unknown) => PublicObservationSchema.parse(x));
  });
  it('persists notifications without claiming delivery and suppresses unchanged notifications', async () => {
    const results = [await fx()];
    await recordSummary(local.env, time, results, time);
    await recordSummary(local.env, time, results, '2026-10-03T18:47:00.000Z');
    expect(await count('daily_summaries')).toBe(2);
    expect(await count('notification_outbox')).toBe(1);
    expect((await deliverNotifications(local.env, time)).state).toBe('not_configured');
    const fail = await deliverNotifications(
      { ...local.env, ALERT_WEBHOOK_URL: 'https://notify.example.test/hook' },
      time,
      responder('', undefined, 500),
    );
    expect(fail.state).toBe('pending');
    const success = await deliverNotifications(
      { ...local.env, ALERT_WEBHOOK_URL: 'https://notify.example.test/hook' },
      time,
      responder('{}'),
    );
    expect(success.sent).toBe(1);
  });
  it('expires raw evidence while keeping observation audit metadata', async () => {
    await fx();
    const n = await expireEvidence(local.env, '2028-01-01T00:00:00.000Z');
    expect(n).toBe(1);
    expect(await count('observations')).toBe(2);
    const raw = await local.env.EVIDENCE.list({ prefix: 'evidence/' });
    expect(raw.objects).toHaveLength(0);
  });

  it('normalizes UTC bounds and does not expose future quarantine knowledge', async () => {
    await fx();
    expect((await api('/v1/fx?as_of=2026-10-03T18:17:00Z')).status).toBe(200);
    const history = (await (
      await api('/v1/observations?from=2026-10-03T18:17:00Z&to=2026-10-03T18:17:00Z')
    ).json()) as any;
    expect(history.data).toHaveLength(3);
    await local.env.PUBLIC_DB.prepare('UPDATE source_publications SET held_at=?')
      .bind('2026-10-04T18:17:00.000Z')
      .run();
    const past = (await (
      await api('/v1/fx?as_of=2026-10-03T18:17:00Z', '2026-10-04T19:00:00.000Z')
    ).json()) as any;
    expect(past.data.stale_reason).not.toBe('newer_observation_quarantined');
    const cross = (await (await api('/v1/fx?base=USD&quote=JPY')).json()) as any;
    expect(cross.data.unit).toBe('quote_currency_per_USD');
  });
  it('recovers failed publication with original recording time and change events', async () => {
    const s = modelSource(),
      next = '2026-10-04T18:17:00.000Z',
      later = '2026-10-04T18:47:00.000Z';
    await collectSource(local.env, s, time, {
      synthetic: true,
      now: () => time,
      network: { fetcher: aiFetch() },
    });
    const db = local.env.PUBLIC_DB;
    const broken = {
      prepare(sql: string) {
        if (sql.startsWith('UPDATE publication_batches'))
          return {
            bind() {
              return {
                async run() {
                  throw new Error('publication_fault');
                },
              };
            },
          };
        return db.prepare(sql);
      },
      batch: db.batch.bind(db),
    } as unknown as D1Database;
    const f = vi.fn(responder(fixture('models.synthetic.json').replace('1.25', '1.375')));
    const failed = await collectSource({ ...local.env, PUBLIC_DB: broken }, s, next, {
      synthetic: true,
      now: () => next,
      network: { fetcher: f },
    });
    expect(failed.state).toBe('failed');
    expect(await count('observations')).toBe(2);
    expect(((await (await api('/v1/changes', next)).json()) as any).data).toHaveLength(0);
    const recovered = await collectSource(local.env, s, next, {
      synthetic: true,
      now: () => later,
      network: { fetcher: f },
    });
    expect(recovered.state).toBe('complete');
    expect(f).toHaveBeenCalledTimes(1);
    const changes = (await (await api('/v1/changes', later)).json()) as any;
    expect(changes.data).toHaveLength(1);
    expect(changes.data[0].details[0].percent_change).toBe('10');
    expect(changes.data[0].source.source_id).toBe('models_dev');
    expect(changes.data[0].methodology).toBe('same-series-change-v1');
    expect(
      ((await (await api('/v1/latest?dataset=ai_api_prices', later)).json()) as any).data[0]
        .recorded_at,
    ).toBe(next);
    // A change requires continued rights for its previous input, too.
    await db
      .prepare(
        "INSERT INTO source_publications(source_id,policy_version,active,derived_allowed,valid_from,public_json) VALUES ('models_dev','old-input',0,1,?,'{}')",
      )
      .bind(time)
      .run();
    await db
      .prepare("UPDATE published_observations SET policy_version='old-input' WHERE observed_at=?")
      .bind(time)
      .run();
    expect(((await (await api('/v1/changes', later)).json()) as any).data).toHaveLength(0);
  });
  it('leases concurrent runs so only one HTTP request and one observation set occurs', async () => {
    const f = vi.fn(fxFetch()),
      options = { synthetic: true, now: () => time, network: { fetcher: f } };
    const runs = await Promise.all([
      collectSource(local.env, source('ecb'), time, options),
      collectSource(local.env, source('ecb'), time, options),
    ]);
    expect(runs.some((r) => r.state === 'complete')).toBe(true);
    expect(runs.every((r) => ['complete', 'in_progress'].includes(r.state))).toBe(true);
    expect(f).toHaveBeenCalledTimes(1);
    expect(await count('observations')).toBe(2);
  });
  it('watchdog recovers only saved evidence and isolates policy failures', async () => {
    await collectSource(local.env, source('ecb'), time, {
      synthetic: true,
      now: () => time,
      network: { fetcher: fxFetch() },
      afterEvidenceSaved: async () => {
        throw new Error('fault');
      },
    });
    const later = '2026-10-03T18:47:00.000Z';
    const recovered = await watchdog(local.env, [source('ecb')], time, later);
    expect(recovered[0].state).toBe('complete');
    expect(await count('fetch_attempts')).toBe(1);
    const mutation = source('ecb');
    mutation.selection = ['USD'];
    const results = await watchdog(local.env, [mutation, modelSource()], time, later);
    expect(results.map((r) => r.state)).toEqual(['failed', 'missing']);
    expect(results[0].reason).toBe('policy_version_mutated');
    expect((await api('/v1/fx', later)).status).toBe(404);
  });
  it('blocks storage if a source is revoked while HTTP is in flight', async () => {
    const s = source('ecb'),
      fetcher = (async () => {
        await revokeSource(local.env, 'ecb');
        return fxFetch()('https://ignored.test');
      }) as typeof fetch;
    const result = await collectSource(local.env, s, time, {
      synthetic: true,
      now: () => time,
      network: { fetcher },
    });
    expect(result.reason).toBe('source_suspended_or_policy_changed');
    expect((await local.env.EVIDENCE.list()).objects).toHaveLength(0);
    expect(await count('observations')).toBe(0);
  });
  it('rejects expired or policy-mismatched evidence in direct reprocessing', async () => {
    await fx();
    const run = await hash('ecb|' + time),
      key = 'evidence/ecb/' + run + '.json';
    const evidence = await (await local.env.EVIDENCE.get(key))!.json<Evidence>();
    const s = source('ecb');
    s.policy.retention_days = 1;
    await expect(
      ingestEvidence(local.env, s, run, time, key, evidence, '2026-10-05T18:17:00.000Z', 'v2'),
    ).rejects.toThrow('evidence_retention_expired');
    await expect(
      ingestEvidence(
        local.env,
        source('ecb'),
        run,
        time,
        key,
        { ...evidence, source_policy_version: 'unreviewed' },
        time,
        'v2',
      ),
    ).rejects.toThrow('evidence_policy_mismatch');
  });
  it('circuit breaker counts failed runs rather than HTTP attempts and stops refetching', async () => {
    const s = source('ecb'),
      f = vi.fn(responder('', 'application/xml', 403));
    const first = await collectSource(local.env, s, time, {
      synthetic: true,
      now: () => time,
      network: { fetcher: f },
    });
    const secondSlot = '2026-10-04T18:17:00.000Z';
    await collectSource(local.env, s, secondSlot, {
      synthetic: true,
      now: () => secondSlot,
      network: { fetcher: f },
    });
    const thirdSlot = '2026-10-04T19:17:00.000Z';
    const third = await collectSource(local.env, s, thirdSlot, {
      synthetic: true,
      now: () => thirdSlot,
      network: { fetcher: f },
    });
    expect(first.state).toBe('failed');
    expect(third.state).toBe('circuit_open');
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('a condition correction supersedes the original series without deleting its history', async () => {
    const s = modelSource(),
      r = await collectSource(local.env, s, time, {
        synthetic: true,
        now: () => time,
        network: { fetcher: aiFetch() },
      });
    const original = ((await (await api('/v1/latest?dataset=ai_api_prices')).json()) as any)
      .data[0];
    const key = 'evidence/models_dev/' + r.run_id + '.json',
      evidence = await (await local.env.EVIDENCE.get(key))!.json<Evidence>();
    // Simulate a parser correction, preserving the exact original evidence.
    const parsed = adapters.parseEvidence(s, evidence);
    (parsed.candidates[0].domain as import('../src/schema').AIPrice).context_limit = '128000';
    const parse = vi.spyOn(adapters, 'parseEvidence').mockReturnValue(parsed);
    const later = '2026-10-04T18:17:00.000Z';
    try {
      await ingestEvidence(
        local.env,
        s,
        r.run_id,
        time,
        key,
        evidence,
        later,
        'condition-correction-v2',
      );
    } finally {
      parse.mockRestore();
    }
    const current = ((await (await api('/v1/latest?dataset=ai_api_prices', later)).json()) as any)
      .data;
    expect(current).toHaveLength(1);
    expect(current[0].value.context_limit).toBe('128000');
    expect(current[0].supersedes_observation_id).toBe(original.observation_id);
    expect(current[0].entity_key).not.toBe(original.entity_key);
    expect(
      (await api('/v1/latest?entity=' + encodeURIComponent(original.entity_key), later)).status,
    ).toBe(404);
    expect(
      ((await (await api('/v1/observations?dataset=ai_api_prices', later)).json()) as any).data,
    ).toHaveLength(2);
    expect(
      ((await (await api('/v1/latest?dataset=ai_api_prices', time)).json()) as any).data[0]
        .observation_id,
    ).toBe(original.observation_id);
  });
});
