import proposal from '../config/proposals/models_dev.v3.json';
import { SourceSchema, type Source, type CollectorEnv } from '../src/schema';
import { collectModels } from '../src/models-pipeline';
import type { ModelCollectOptions } from '../src/models-pipeline';
const time = '2026-10-03T18:17:00.000Z';
const responder = (body: string): typeof fetch =>
  (async () =>
    new Response(body, { headers: { 'content-type': 'application/json' } })) as typeof fetch;
export function expandedSource(
  providers = ['openai', 'anthropic', 'google', 'xai', 'mistral'],
): Source {
  const s = SourceSchema.parse(structuredClone(proposal));
  s.enabled = true;
  s.policy.version = 'synthetic-models-v3';
  s.policy.valid_from = '2026-01-01T00:00:00.000Z';
  s.policy.valid_until = '2030-01-01T00:00:00.000Z';
  s.models!.providers = [...providers];
  s.models!.max_models = 1000;
  s.policy.models_scope!.providers = [...providers];
  s.models!.owner_approval_ref = 'synthetic owner approval';
  s.models!.runtime_review_ref = 'synthetic workerd test';
  s.models!.retention.reviewed_ref = 'synthetic retention review';
  for (const key of [
    'automated_collection',
    'private_storage',
    'internal_analysis',
    'public_display',
    'normalized_redistribution',
    'derived_redistribution',
    'commercial_redistribution',
  ] as const)
    s.policy.rights[key] = 'allowed';
  return s;
}
export function catalog(
  count = 5,
  providers = ['openai', 'anthropic', 'google', 'xai', 'mistral'],
): Record<string, any> {
  const root: Record<string, any> = Object.fromEntries(
    providers.map((id) => [id, { id, models: {} }]),
  );
  for (let i = 0; i < count; i++) {
    const provider = providers[i % providers.length],
      id = 'synthetic-model-' + i;
    root[provider].models[id] = {
      id,
      canonical_model_id: 'synthetic-lab/version-' + i,
      limit: { context: 64000, input: 32000, output: 8000 },
      modalities: { input: ['text', 'image'], output: ['text'] },
      reasoning: true,
      tool_call: true,
      structured_output: false,
      attachment: true,
      temperature: true,
      release_date: '2025-06',
      last_updated: '2026-08-10',
      cost: { input: 1, output: 4, cache_read: 0.25 },
      description: 'SYNTHETIC unapproved description must never be retained',
      provider: { headers: { Authorization: 'SYNTHETIC forbidden credential' } },
    };
  }
  return root;
}
export async function finishModels(
  env: CollectorEnv,
  s: Source,
  body: Record<string, any>,
  slot = time,
  opt: ModelCollectOptions = {},
) {
  let calls = 0,
    steps = 0,
    result;
  do {
    result = await collectModels(env, s, slot, {
      synthetic: true,
      now: () => slot,
      network: {
        fetcher: (async (...args: any[]) => {
          calls++;
          return (responder(JSON.stringify(body)) as any)(...args);
        }) as typeof fetch,
      },
      ...opt,
    });
    steps++;
    if (steps > 100) throw new Error('synthetic_step_limit');
  } while (result.state === 'pending');
  return { result, calls, steps };
}
