import { collectResearchPage, type ResearchEnv } from './pipeline';
import { isPublicGpu } from './public-gpu-contract';
import type { ResearchConfig } from './schema';
import { errorCode } from '../util';

// Private orchestration only. No HTTP entrypoint, export or notification delivery.
// One source's rights or network failure must not prevent the next reviewed source.
export async function collectPublicGpuDay(
  env: ResearchEnv,
  configs: ResearchConfig[],
  scheduled: string,
  options: (config: ResearchConfig) => Parameters<typeof collectResearchPage>[4],
) {
  const results = [];
  for (const config of configs) {
    try {
      if (!isPublicGpu(config.adapter)) throw new Error('research_scope_mismatch');
      const result = await collectResearchPage(
        env,
        config,
        { kind: config.adapter },
        scheduled,
        options(config),
      );
      const meta = await env.PRIVATE_DB.prepare(
        'SELECT observation_count,http_page_attempts,last_error,retry_at,synthetic FROM research_runs WHERE run_id=?',
      )
        .bind(result.run_id)
        .first();
      results.push({
        source_id: config.source.source_id,
        ...result,
        coverage: result.state === 'complete' ? 'complete' : 'partial',
        metadata: meta,
        reason: null,
      });
    } catch (error) {
      results.push({
        source_id: config.source.source_id,
        state: 'blocked',
        run_id: null,
        coverage: 'unknown',
        metadata: null,
        reason: errorCode(error),
      });
    }
  }
  return results;
}
