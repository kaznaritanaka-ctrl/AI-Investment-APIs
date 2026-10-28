import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseEffectStory, EFFECTSTORY_URL, EFFECTSTORY_ATTRIBUTION } from '../src/effectstory';
import { gpuEvidenceFromBody, parseGPUProjection } from '../src/gpu-adapters';
import { canCollect, canPublish } from '../src/policy';
import { fetchGPURequest } from '../src/network';
import { collectSource } from '../src/pipeline';
import { queueGPURuns, resumeGPURuns } from '../src/gpu-pipeline';
import { collectGPU } from '../src/gpu-pipeline';
import { expireGPUData } from '../src/gpu-retention';
import { handle } from '../src/api';
import { source } from './helpers';
import { effectstoryOfflineEnv } from './effectstory-offline-env';
import { collectResearchPage } from '../src/research/pipeline';
import { publicGpuSource, gpuOptions } from './public-gpu-helpers';
import { effectstoryHTML, effectstoryTime as time } from './effectstory-helpers';
import { inspectPreflight } from '../scripts/preflight-core';
import deployment from '../config/deployment.json';
import { sources } from '../src/sources';
import { SourceSchema } from '../src/schema';

const projectedEvidence = (rows: string[][], s = source('effectstory')) =>
  gpuEvidenceFromBody(
    s,
    s.gpu!.partitions[0],
    'snap',
    'scope',
    0,
    time,
    effectstoryHTML(rows),
    time,
    true,
  );
const syntheticRow = (provider: string, label = 'GB300 NVL72') => [
  provider,
  label,
  '$4.500/GPU-hr',
  'Synthetic basis',
  '2026-10-26',
];

it.each([
  'RunPod',
  'Runpod',
  ' Runpod.io ',
  '\tRUNPOD\n',
  ' rUnPoD.Io ',
  'OpenRouter',
  ' OPENROUTER ',
])('drops %j before projecting evidence and keeps only count metadata', async (provider) => {
  const evidence = await projectedEvidence([
    syntheticRow(provider, 'EXCLUDED_ROW_CONTENT'),
    syntheticRow('Synthetic RunPod Partner'),
  ]);
  const body = JSON.parse(evidence.body);
  expect(body.effectstory).toEqual({ dropped_count: 1 });
  expect(body.records.map((r: any) => r.provider)).toEqual(['Synthetic RunPod Partner']);
  expect(evidence.body).not.toContain('EXCLUDED_ROW_CONTENT');
  expect(evidence.gpu_page).toMatchObject({ received_count: 1, reported_total: 1, complete: true });
  expect(parseGPUProjection(source('effectstory'), evidence)).toHaveLength(1);
});

it('measures the row cap before exclusion, including all-excluded pages', async () => {
  const rows = Array.from({ length: 50 }, (_, i) => syntheticRow('RunPod', 'Synthetic GPU ' + i));
  const evidence = await projectedEvidence(rows);
  expect(JSON.parse(evidence.body)).toEqual({ records: [], effectstory: { dropped_count: 50 } });
  expect(parseGPUProjection(source('effectstory'), evidence)).toEqual([]);
  await expect(projectedEvidence([...rows, syntheticRow('OpenRouter')])).rejects.toThrow(
    'effectstory_record_limit',
  );
  const limited = source('effectstory');
  limited.max_records = 1;
  await expect(projectedEvidence(rows.slice(0, 2), limited)).rejects.toThrow(
    'effectstory_record_limit',
  );
});

it('applies additional provider exclusions from the reviewed policy', async () => {
  const s = source('effectstory');
  s.policy.excluded_upstream_providers!.push({
    provider: 'Synthetic Restricted',
    aliases: ['Synthetic Restricted Alias'],
    reason: 'Synthetic prohibition',
    evidence_refs: ['synthetic-review'],
  });
  const evidence = await projectedEvidence(
    [syntheticRow(' SYNTHETIC RESTRICTED ALIAS '), syntheticRow('Synthetic Allowed')],
    s,
  );
  expect(JSON.parse(evidence.body).effectstory).toEqual({ dropped_count: 1 });
  expect(parseGPUProjection(s, evidence)).toHaveLength(1);
  expect(evidence.body).not.toContain('RESTRICTED');
});

it('rejects excluded providers and invalid exclusion metadata during evidence replay', async () => {
  const s = source('effectstory');
  const evidence = await projectedEvidence([syntheticRow('Synthetic Allowed')]);
  expect(JSON.parse(evidence.body).effectstory).toEqual({ dropped_count: 0 });
  for (const provider of [' Runpod.io ', 'RunPod', ' OPENROUTER ']) {
    const body = JSON.parse(evidence.body);
    body.records[0].provider = provider;
    expect(() => parseGPUProjection(s, { ...evidence, body: JSON.stringify(body) })).toThrow(
      'effectstory_excluded_provider',
    );
  }
  for (const metadata of [
    undefined,
    { dropped_count: -1 },
    { dropped_count: 0.5 },
    { dropped_count: 50 },
    { dropped_count: 0, rows: ['forbidden'] },
  ]) {
    const body = { ...JSON.parse(evidence.body), effectstory: metadata };
    expect(() => parseGPUProjection(s, { ...evidence, body: JSON.stringify(body) })).toThrow();
  }
});

it('requires both provider prohibitions, aliases, reasons and evidence in schema and preflight', async () => {
  const collector = JSON.parse(readFileSync('wrangler.collector.jsonc', 'utf8'));
  const api = JSON.parse(readFileSync('wrangler.api.jsonc', 'utf8'));
  const s = source('effectstory');
  for (const mutate of [
    (x: typeof s) => {
      delete x.policy.excluded_upstream_providers;
    },
    (x: typeof s) => {
      x.policy.excluded_upstream_providers = [];
    },
    (x: typeof s) => {
      x.policy.excluded_upstream_providers!.pop();
    },
    (x: typeof s) => {
      x.policy.excluded_upstream_providers!.shift();
    },
    (x: typeof s) => {
      x.policy.excluded_upstream_providers![0].aliases = ['RunPod'];
    },
    (x: typeof s) => {
      x.policy.excluded_upstream_providers![0].reason = ' ';
    },
    (x: typeof s) => {
      x.policy.excluded_upstream_providers![0].evidence_refs = [];
    },
    (x: typeof s) => {
      x.policy.excluded_upstream_providers![0].evidence_refs = ['unreviewed'];
    },
    ...[
      'null',
      '{}',
      '[null]',
      '[{"provider":123}]',
      '[{"provider":"RunPod","reason":"reason","evidence_refs":["ref"]}]',
      '[{"provider":"RunPod","aliases":[123],"reason":"reason","evidence_refs":["ref"]}]',
      '[{"provider":"RunPod","aliases":["Runpod.io"],"reason":null,"evidence_refs":["ref"]}]',
      '[{"provider":"RunPod","aliases":["Runpod.io"],"reason":"reason","evidence_refs":[null]}]',
    ].map((json) => (x: typeof s) => {
      x.policy.excluded_upstream_providers = JSON.parse(json);
    }),
  ]) {
    const bad = structuredClone(s);
    mutate(bad);
    expect(canCollect(bad, time)).toBe(false);
    expect(canPublish(bad, time)).toBe(false);
    expect(
      inspectPreflight(
        deployment,
        collector,
        api,
        sources.map((x) => (x.source_id === s.source_id ? bad : x)),
      ).blockers,
    ).toContain('effectstory:effectstory_scope_not_approved');
    await expect(projectedEvidence([syntheticRow('RunPod')], bad)).rejects.toThrow(
      'effectstory_exclusions_not_approved',
    );
  }
  for (const entry of [
    { provider: 'RunPod', aliases: [], reason: 'reason', evidence_refs: ['ref'] },
    { provider: 'RunPod', aliases: [' '], reason: 'reason', evidence_refs: ['ref'] },
    { provider: 'RunPod', aliases: ['RunPod'], reason: ' ', evidence_refs: ['ref'] },
    { provider: 'RunPod', aliases: ['RunPod'], reason: 'reason', evidence_refs: [] },
  ]) {
    expect(
      SourceSchema.safeParse({
        ...s,
        policy: { ...s.policy, excluded_upstream_providers: [entry] },
      }).success,
    ).toBe(false);
  }
});

it('projects only the reviewed table, with decimal precision and published text preserved', async () => {
  const rows = parseEffectStory(effectstoryHTML(), time);
  expect(rows).toHaveLength(3);
  expect(rows[0]).toEqual({
    provider: 'Synthetic Cloud',
    gpu_label: 'GB300 NVL72',
    amount_decimal: '3.2500',
    basis: 'Synthetic on-demand list, 72-GPU system, test-region',
    checked_date: '2026-10-25',
    source_url: EFFECTSTORY_URL,
  });
  const s = source('effectstory');
  const evidence = await gpuEvidenceFromBody(
    s,
    s.gpu!.partitions[0],
    'snap',
    'scope',
    0,
    time,
    effectstoryHTML(),
    time,
    true,
  );
  expect(evidence.body).not.toMatch(/<table|__next_f|untrusted RSC/);
  const candidates = parseGPUProjection(s, evidence);
  expect(
    candidates.map((c) => ('accelerator_model' in c.domain ? c.domain.accelerator_model : null)),
  ).toEqual(['GB300', 'B300', null]);
  expect(candidates[0].source_date).toBe('2026-10-25');
  expect(candidates[0].domain).toMatchObject({
    amount_decimal: '3.2500',
    billing_unit: 'gpu_hour',
    currency: 'USD',
    gpu_count: null,
    gpu_sku_id: null,
    country: null,
    region: null,
    contract_type: 'unknown',
    secondary_source: true,
  });
  const forged = JSON.parse(evidence.body);
  forged.records[0].accelerator_model = 'B300';
  expect(() => parseGPUProjection(s, { ...evidence, body: JSON.stringify(forged) })).toThrow(
    'gpu_source_metadata_mismatch',
  );
  expect(() => parseGPUProjection(source('price_of_compute'), evidence)).toThrow();
});

it.each([
  ['missing header', (h: string) => h.replace('<th>Checked</th>', '')],
  ['unknown header', (h: string) => h.replace('Hourly (USD)', 'Hourly (EUR)')],
  ['node-hour price', (h: string) => h.replace('$3.2500/GPU-hr', '$3.2500/node-hr')],
  ['price range', (h: string) => h.replace('$3.2500/GPU-hr', '$3–4/GPU-hr')],
  ['missing price', (h: string) => h.replace('$3.2500/GPU-hr', 'N/A')],
  ['bad date', (h: string) => h.replace('2026-10-25', '2026-02-30')],
  ['future date', (h: string) => h.replace('2026-10-25', '2026-11-01')],
  ['truncation', (h: string) => h.replace('</tbody>', '').replace('</table>', '')],
  ['spanning cells', (h: string) => h.replace('<td>', '<td colspan="2">')],
  [
    'nested table',
    (h: string) => h.replace('Synthetic Cloud', '<table><tr><td>inner</td></tr></table>'),
  ],
  ['duplicate tables', (h: string) => h + h],
  ['only RSC', (_h: string) => '<html><script>"<table>RSC</table>"</script></html>'],
  ['DTD', (h: string) => '<!DOCTYPE html [<!ENTITY x "bad">]>' + h],
])('rejects the whole page on %s', (_name, transform) => {
  expect(() => parseEffectStory(transform(effectstoryHTML()), time)).toThrow();
});
it('enforces complete nonempty unique tables and bounded bytes/rows, including entity decoding', () => {
  expect(() => parseEffectStory(effectstoryHTML([]), time)).toThrow('effectstory_record_limit');
  const row = [
    'Synthetic',
    'GB300 SXM6',
    '$9.90/GPU-hr',
    'Synthetic basis &amp; text',
    '2026-10-25',
  ];
  expect(parseEffectStory(effectstoryHTML([row]), time)[0].basis).toBe('Synthetic basis & text');
  expect(() => parseEffectStory(effectstoryHTML([row, row]), time)).toThrow(
    'effectstory_duplicate_record',
  );
  const many = Array.from({ length: 50 }, (_, i) => [
    ...row.slice(0, 1),
    'GPU-' + i,
    ...row.slice(2),
  ]);
  expect(parseEffectStory(effectstoryHTML(many), time)).toHaveLength(50);
  expect(() => parseEffectStory(effectstoryHTML([...many, row]), time)).toThrow(
    'effectstory_record_limit',
  );
  expect(() => parseEffectStory('x'.repeat(2000001), time)).toThrow('response_too_large');
});
it('recognizes the exact new public grant without widening other sources, and offline preflight accepts it', () => {
  const s = source('effectstory');
  expect(canCollect(s, time)).toBe(true);
  expect(canPublish(s, time)).toBe(true);
  expect(s.policy.rights.raw_redistribution).toBe('denied');
  expect(s.attribution_text).toBe(EFFECTSTORY_ATTRIBUTION);
  expect(s.rights_checked_at).toBe('2026-10-29T00:00:00.000Z');
  for (const id of ['price_of_compute', 'gpusoroban', 'gpu_index'])
    expect(canPublish(source(id), time)).toBe(false);
  const collector = JSON.parse(readFileSync('wrangler.collector.jsonc', 'utf8'));
  const api = JSON.parse(readFileSync('wrangler.api.jsonc', 'utf8'));
  expect(inspectPreflight(deployment, collector, api, sources).blockers).toEqual([]);
  expect(inspectPreflight(deployment, collector, api, sources).errors).toEqual([]);
  const bad = structuredClone(s);
  bad.max_records = 100;
  expect(canCollect(bad, time)).toBe(false);
  expect(
    inspectPreflight(
      deployment,
      collector,
      api,
      sources.map((x) => (x.source_id === s.source_id ? bad : x)),
    ).blockers,
  ).toContain('effectstory:effectstory_scope_not_approved');
});

describe('EffectStory storage and transport', () => {
  let local: Awaited<ReturnType<typeof effectstoryOfflineEnv>>;
  beforeEach(async () => {
    local = await effectstoryOfflineEnv();
  });
  afterEach(async () => {
    await local?.dispose();
  });
  const env = () => ({ ...local.env, COLLECTION_CRON: '17 18 * * *' });
  const api = async (path: string, now = time) =>
    (
      await handle(
        new Request('https://fixture.test' + path),
        { PUBLIC_DB: local.env.PUBLIC_DB },
        now,
      )
    ).json() as Promise<any>;

  it.each([false, true])(
    'never persists excluded row contents (all excluded: %s)',
    async (allExcluded) => {
      const rows = [
        ...['RunPod', 'Runpod', ' Runpod.io ', ' RUNPOD '].map((p, i) =>
          syntheticRow(p, 'EXCLUDED_ROW_CONTENT_' + i),
        ),
        ...(allExcluded
          ? [syntheticRow('OpenRouter', 'EXCLUDED_ROW_CONTENT_4')]
          : Array.from({ length: 18 }, (_, i) => syntheticRow('Synthetic Allowed ' + i))),
      ];
      const s = source('effectstory');
      const opts = {
        synthetic: true,
        now: () => time,
        network: {
          fetcher: (async () =>
            new Response(effectstoryHTML(rows), {
              headers: { 'content-type': 'text/html' },
            })) as typeof fetch,
        },
      };
      let state;
      for (let i = 0; i < 3; i++) {
        state = (await collectSource(env(), s, time, opts)).state;
        if (state === 'complete' || state === 'failed') break;
      }
      expect(state).toBe('complete');
      expect(local.objects.size).toBeGreaterThan(0);
      for (const [key, stored] of local.objects) {
        expect(stored.body).not.toContain('EXCLUDED_ROW_CONTENT');
        expect(stored.body).not.toMatch(/runpod|openrouter/i);
        const evidence = JSON.parse(stored.body);
        if (key.startsWith('evidence/')) {
          const body = JSON.parse(evidence.body);
          expect(body.effectstory).toEqual({ dropped_count: allExcluded ? 5 : 4 });
          expect(body.records).toHaveLength(allExcluded ? 0 : 18);
        } else {
          expect(key).toMatch(/^archive\//);
          expect(evidence.observations).toHaveLength(allExcluded ? 0 : 18);
        }
      }
      for (const [db, table] of [
        [local.env.PRIVATE_DB, 'observations'],
        [local.env.PUBLIC_DB, 'published_observations'],
      ] as const) {
        const observations = (await db.prepare('SELECT * FROM ' + table).all()).results;
        expect(observations).toHaveLength(allExcluded ? 0 : 18);
        expect(JSON.stringify(observations)).not.toContain('EXCLUDED_ROW_CONTENT');
      }
      const rentals = (
        await local.env.PRIVATE_DB.prepare('SELECT provider FROM gpu_rental').all<{
          provider: string;
        }>()
      ).results;
      expect(rentals).toHaveLength(allExcluded ? 0 : 18);
      expect(rentals.every((r) => r.provider.startsWith('Synthetic Allowed '))).toBe(true);
      const coverage = (await api('/v1/gpu/coverage?source=effectstory')).data;
      expect(coverage).toHaveLength(1);
      expect(coverage[0].coverage).toBe('complete');
    },
  );

  it('publishes EffectStory rows only, with license, attribution, immutable daily snapshots and R2 expiry', async () => {
    const s = source('effectstory');
    let calls = 0;
    const fetcher = (async (input, init) => {
      calls++;
      expect(String(input)).toBe(EFFECTSTORY_URL);
      expect(new Headers(init?.headers).get('user-agent')).toContain('AIInvestmentResearch/0.1');
      expect(new Headers(init?.headers).get('accept')).toBe('text/html');
      expect(init?.redirect).toBe('manual');
      return new Response(effectstoryHTML(), {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }) as typeof fetch;
    const opts = { synthetic: true, now: () => time, network: { fetcher } };
    expect((await collectSource(env(), s, time, opts)).state).toBe('pending');
    expect((await collectSource(env(), s, time, opts)).state).toBe('complete');
    expect((await collectSource(env(), s, time, opts)).reason).toBe('already_processed');
    expect(calls).toBe(1);
    const data = (await api('/v1/observations?dataset=gpu_rental&source=effectstory')).data;
    expect(data).toHaveLength(3);
    for (const o of data) {
      expect(o.source).toMatchObject({
        source_id: 'effectstory',
        secondary: true,
        source_url: EFFECTSTORY_URL,
      });
      expect(o.attribution).toBe(EFFECTSTORY_ATTRIBUTION);
      expect(o.reuse.license_url).toBe('https://creativecommons.org/licenses/by/4.0/');
      expect(o.source_date).toBe(o.value.effectstory.checked_date);
      expect(o.statistical_exclusions).toContain('secondary_source_not_independent');
    }
    const artifacts = (
      await local.env.PRIVATE_DB.prepare('SELECT * FROM raw_artifacts WHERE source_id=?')
        .bind(s.source_id)
        .all<any>()
    ).results;
    expect(artifacts).toHaveLength(2);
    for (const a of artifacts) {
      expect(a.expires_at).toBe('2026-11-05T18:00:00.000Z');
      expect(await (await local.env.EVIDENCE.get(a.artifact_ref))!.text()).not.toMatch(
        /<table|__next_f/,
      );
    }
    const next = '2026-10-30T18:00:00.000Z';
    const nextOpts = { ...opts, now: () => next };
    await collectSource(env(), s, next, nextOpts);
    await collectSource(env(), s, next, nextOpts);
    expect(calls).toBe(2);
    expect(
      (await api('/v1/observations?dataset=gpu_rental&source=effectstory', next)).data,
    ).toHaveLength(6);
    expect(
      (await api('/v1/gpu/coverage?source=effectstory', next)).data.every(
        (c: any) => c.coverage === 'complete',
      ),
    ).toBe(true);
    // Exercise an actual enabled private-only source beside EffectStory. The public
    // table must receive no PoC observations, coverage, metrics or source payloads.
    const poc = source('price_of_compute');
    await collectSource(env(), poc, time, {
      synthetic: true,
      now: () => time,
      network: {
        fetcher: (async () =>
          new Response(
            JSON.stringify({
              sku: 'H100-SXM',
              day: '2026-10-28',
              updated_at: '2026-10-29T17:00:00Z',
              providers: [
                {
                  provider: 'Synthetic private cloud',
                  pricing_type: 'on_demand',
                  usd_per_gpu_hr: '1.25',
                  region: 'synthetic-region',
                  observed_at: null,
                },
              ],
            }),
            {
              headers: { 'content-type': 'application/json' },
            },
          )) as typeof fetch,
      },
    });
    expect(
      await local.env.PRIVATE_DB.prepare(
        "SELECT COUNT(*) n FROM observations WHERE source_id='price_of_compute'",
      ).first('n'),
    ).toBe(1);
    const research = await publicGpuSource();
    const researchRun = await collectResearchPage(
      local.env,
      research,
      { kind: 'highreso_public' },
      time,
      gpuOptions(research, time),
    );
    expect(researchRun.state).toBe('complete');
    expect(
      await local.env.PRIVATE_DB.prepare('SELECT COUNT(*) n FROM research_gpu_observations').first(
        'n',
      ),
    ).toBeGreaterThan(0);
    for (const id of ['gpusoroban', 'gpu_index'])
      await collectSource(env(), source(id), time, opts);
    for (const table of ['published_observations', 'published_coverage', 'published_gpu_metrics']) {
      const ids = (
        await local.env.PUBLIC_DB.prepare('SELECT DISTINCT source_id FROM ' + table).all<any>()
      ).results.map((r) => r.source_id);
      expect(ids.every((id) => id === 'effectstory')).toBe(true);
    }
    for (const id of ['price_of_compute', 'gpusoroban', 'highreso', 'research'])
      expect(
        (await api('/v1/observations?dataset=gpu_rental&source=' + id, next)).data,
      ).toHaveLength(0);
    expect((await api('/v1/gpu/metrics?source=effectstory', next)).data).toHaveLength(0);
  });

  it.each(['http', 'parse', 'r2'])(
    'reserves one HTTP per day even after %s failure',
    async (failure) => {
      const s = source('effectstory');
      let calls = 0;
      const fetcher = (async () => {
        calls++;
        return new Response(failure === 'parse' ? '<table>broken</table>' : effectstoryHTML(), {
          status: failure === 'http' ? 503 : 200,
          headers: { 'content-type': 'text/html' },
        });
      }) as typeof fetch;
      const selectedEnv =
        failure === 'r2'
          ? {
              ...env(),
              EVIDENCE: new Proxy(local.env.EVIDENCE, {
                get(target, key) {
                  if (key === 'put')
                    return async () => {
                      throw new Error('synthetic_r2_failure');
                    };
                  const value = (target as any)[key];
                  return typeof value === 'function' ? value.bind(target) : value;
                },
              }),
            }
          : env();
      const opts = {
        synthetic: true,
        now: () => time,
        network: { fetcher, max_attempts: 3 as const, sleep: async () => {} },
      };
      expect((await collectSource(selectedEnv, s, time, opts)).state).toBe('failed');
      await collectSource(selectedEnv, s, time, opts);
      // A different same-day run ID cannot bypass the durable reservation either.
      await collectSource(selectedEnv, s, '2026-10-29T18:16:00.000Z', opts);
      expect(calls).toBe(1);
      expect(
        await local.env.PRIVATE_DB.prepare(
          "SELECT COUNT(*) AS n FROM fetch_attempts WHERE code='effectstory_daily_reservation'",
        ).first('n'),
      ).toBe(1);
      expect(
        (await api('/v1/observations?dataset=gpu_rental&source=effectstory')).data,
      ).toHaveLength(0);
    },
  );

  it('keeps full 50-row replacements atomic within two continuation slots and makes no extra HTTP', async () => {
    const s = source('effectstory');
    let calls = 0;
    const run = async (at: string, prefix: string) => {
      const rows = Array.from({ length: 50 }, (_, i) => [
        prefix + i,
        'GB300 NVL72',
        '$4.500/GPU-hr',
        'Synthetic basis',
        '2026-10-26',
      ]);
      const opts = {
        synthetic: true,
        now: () => at,
        network: {
          fetcher: (async () => {
            calls++;
            return new Response(effectstoryHTML(rows), {
              headers: { 'content-type': 'text/html' },
            });
          }) as typeof fetch,
        },
      };
      const states = [];
      for (let i = 0; i < 3; i++) {
        const result = await collectGPU(env(), s, at, {
          ...opts,
          now: () => new Date(Date.parse(at) + i * 5 * 60000).toISOString(),
          savedOnly: i > 0,
        });
        states.push(result.state);
        if (result.state === 'complete') break;
      }
      expect(states.at(-1)).toBe('complete');
      return states;
    };
    expect(await run(time, 'First synthetic ')).toHaveLength(2);
    const next = '2026-10-30T18:00:00.000Z';
    expect(await run(next, 'Replacement synthetic ')).toHaveLength(3);
    expect(calls).toBe(2);
    const completed = '2026-10-30T18:10:00.000Z';
    expect(
      (await api('/v1/latest?dataset=gpu_rental&source=effectstory', completed)).data,
    ).toHaveLength(50);
    const changes = (
      await api('/v1/changes?dataset=gpu_rental&source=effectstory&limit=100', completed)
    ).data;
    expect(changes).toHaveLength(50);
    expect(
      changes.every(
        (c: any) =>
          c.sold === false &&
          c.attribution === EFFECTSTORY_ATTRIBUTION &&
          c.reuse.license_url === 'https://creativecommons.org/licenses/by/4.0/',
      ),
    ).toBe(true);
    const cleanupAt = new Date(Date.parse(time) + 180 * 86400000 + 15 * 60000).toISOString();
    let statements = 0;
    const counted = { ...env() };
    for (const key of ['PRIVATE_DB', 'PUBLIC_DB'] as const) {
      const db = counted[key];
      counted[key] = {
        prepare: (sql: string) => {
          statements++;
          return db.prepare(sql);
        },
        batch: db.batch.bind(db),
      } as D1Database;
    }
    expect(await expireGPUData(counted, [s], cleanupAt)).toBe(50);
    expect(statements).toBeLessThan(1000);
    expect(
      await env()
        .PRIVATE_DB.prepare(
          "SELECT COUNT(*) AS n FROM gpu_snapshots WHERE source_id='effectstory' AND state='purged'",
        )
        .first('n'),
    ).toBe(1);
    expect(
      await env()
        .PRIVATE_DB.prepare("SELECT COUNT(*) AS n FROM observations WHERE source_id='effectstory'")
        .first('n'),
    ).toBe(50);
  });

  it('selects GPU resume work within the supplied sources before applying LIMIT', async () => {
    const s = source('effectstory');
    await queueGPURuns(env(), [source('price_of_compute')], time, time);
    await collectSource(env(), s, time, {
      synthetic: true,
      now: () => time,
      network: {
        fetcher: (async () =>
          new Response(effectstoryHTML(), {
            headers: { 'content-type': 'text/html' },
          })) as typeof fetch,
      },
    });
    const resumed = await resumeGPURuns(env(), [s], '2026-10-29T18:05:00.000Z', true);
    expect(resumed).toMatchObject([{ source_id: 'effectstory', state: 'complete' }]);
    expect(
      await env()
        .PRIVATE_DB.prepare("SELECT state FROM collection_runs WHERE source_id='price_of_compute'")
        .first('state'),
    ).toBe('pending');
    expect(await resumeGPURuns(env(), [source('price_of_compute')], time, true)).toMatchObject([
      { source_id: 'price_of_compute' },
    ]);
  });

  it('does not repeat a failed logical run even when a delayed invocation crosses UTC midnight', async () => {
    const s = source('effectstory');
    let calls = 0;
    const fetcher = (async () => {
      calls++;
      return new Response('synthetic failure', {
        status: 503,
        headers: { 'content-type': 'text/html' },
      });
    }) as typeof fetch;
    await collectSource(env(), s, time, { synthetic: true, now: () => time, network: { fetcher } });
    const delayed = '2026-10-30T00:01:00.000Z';
    const retry = await collectSource(env(), s, time, {
      synthetic: true,
      now: () => delayed,
      network: { fetcher },
    });
    // The 18:00 capture window has expired by midnight; no new HTTP is allowed.
    expect(retry.state).toBe('partial');
    expect(calls).toBe(1);
  });

  it('replays saved evidence after a crash without HTTP and completes in continuation', async () => {
    const s = source('effectstory');
    let calls = 0;
    const opts = {
      synthetic: true,
      now: () => time,
      network: {
        fetcher: (async () => {
          calls++;
          return new Response(effectstoryHTML(), { headers: { 'content-type': 'text/html' } });
        }) as typeof fetch,
      },
    };
    expect(
      (
        await collectSource(env(), s, time, {
          ...opts,
          afterEvidenceSaved: async () => {
            throw new Error('synthetic_crash');
          },
        })
      ).state,
    ).toBe('failed');
    const later = '2026-10-29T18:05:00.000Z';
    expect((await resumeGPURuns(env(), [s], later))[0].state).toBe('pending');
    expect((await resumeGPURuns(env(), [s], later))[0].state).toBe('complete');
    expect(calls).toBe(1);
  });
  it('continuation cannot acquire missing evidence; unapproved policies and old slots never fetch', async () => {
    const s = source('effectstory');
    let calls = 0;
    const opts = {
      synthetic: true,
      now: () => time,
      network: {
        fetcher: (async () => {
          calls++;
          throw new Error('unexpected');
        }) as typeof fetch,
      },
    };
    const denied = structuredClone(s);
    denied.policy.rights.private_storage = 'review_required';
    denied.policy.version = 'effectstory-synthetic-denied';
    expect((await collectSource(env(), denied, '2026-10-29T17:59:00.000Z', opts)).state).toBe(
      'policy_skipped',
    );
    await queueGPURuns(env(), [s], time, time);
    expect((await resumeGPURuns(env(), [s], time))[0]).toMatchObject({
      state: 'failed',
      reason: 'effectstory_no_saved_evidence',
    });
    expect((await collectSource(env(), s, '2026-10-28T18:00:00.000Z', opts)).state).toBe('partial');
    expect(calls).toBe(0);
  });

  it('bounded HTML transport refuses oversized, redirects and wrong content type with one attempt', async () => {
    const s = source('effectstory');
    for (const response of [
      new Response('a'.repeat(2000001), { headers: { 'content-type': 'text/html' } }),
      new Response('redirect', { status: 302, headers: { location: 'https://untrusted.invalid' } }),
      new Response('{}', { headers: { 'content-type': 'application/json' } }),
    ]) {
      let calls = 0;
      await expect(
        fetchGPURequest(s, env(), s.gpu!.partitions[0], 0, time, {
          now: () => time,
          max_attempts: 3 as const,
          fetcher: (async () => {
            calls++;
            return response;
          }) as typeof fetch,
        }),
      ).rejects.toThrow();
      expect(calls).toBe(1);
    }
  });
});
