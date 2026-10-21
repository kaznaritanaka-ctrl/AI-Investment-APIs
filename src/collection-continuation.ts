import type { CollectorEnv, Source } from './schema';
import type { SourceObserver } from './telemetry';
import { expireModels } from './models-retention';
import { resumeModelRuns } from './models-pipeline';
import { resumeGPURuns } from './gpu-pipeline';

// A continuation spends its ingestion budget on one workload. Existing Models
// collection/retention keeps priority; private GPU capture uses the remaining slots.
export async function resumeCollections(
  env: CollectorEnv,
  sources: Source[],
  now: string,
  observer?: SourceObserver,
) {
  const retired = await expireModels(env, sources, now);
  if (retired) return { results: [], models_work: true };
  const models = await resumeModelRuns(env, sources, now, false, observer);
  if (models.length) return { results: models, models_work: true };
  return { results: await resumeGPURuns(env, sources, now, false, observer), models_work: false };
}
