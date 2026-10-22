import type { ResearchEnv } from './pipeline';
import { isDCSource } from './dc-contract';
import { isPublicGpu } from './public-gpu-contract';
import { ResearchConfigSchema, type ResearchConfig } from './schema';

// This opens only the explicitly flagged private GPU/DC paths. Acquisition/read authority is checked
// separately in schema.ts. Cleanup must still run after a grant expires or is revoked.
export function assertResearchFeatureEnabled(env: ResearchEnv) {
  if (
    env.ENVIRONMENT === 'production' &&
    env.PRIVATE_GPU_RESEARCH_ENABLED !== 'true' &&
    env.DC_TRACKER_ENABLED !== 'true'
  )
    throw new Error('research_production_not_integrated');
}

export function assertResearchExecution(env: ResearchEnv, sourceId?: string) {
  if (
    env.ENVIRONMENT === 'production' &&
    (!sourceId ||
      !(isPublicGpu(sourceId)
        ? env.PRIVATE_GPU_RESEARCH_ENABLED === 'true'
        : isDCSource(sourceId) && env.DC_TRACKER_ENABLED === 'true'))
  )
    throw new Error('research_production_not_integrated');
}

export function assertResearchConfigExecution(env: ResearchEnv, config: ResearchConfig) {
  assertResearchExecution(env, config.source.source_id);
  if (env.ENVIRONMENT === 'production') {
    ResearchConfigSchema.parse(config);
    if (
      isDCSource(config.source.source_id) &&
      (config.adapter !== 'dc_tracker' || !config.dc_access)
    )
      throw new Error('dc_tracker_live_scope_unreviewed');
  }
}
