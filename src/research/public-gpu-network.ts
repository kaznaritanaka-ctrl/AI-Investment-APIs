import { fetchBounded, FetchFailure, type NetworkOptions } from '../network';
import { assertResearchAllowed, type ResearchConfig } from './schema';
import { isPublicGpu, publicGpuEndpoints, PUBLIC_GPU_UA } from './public-gpu-contract';
import { robotsFingerprint, termsFingerprint } from './public-gpu-html';

export async function fetchPublicGpuPage(config: ResearchConfig, opt: NetworkOptions) {
  assertResearchAllowed(
    config,
    (opt.now ?? (() => new Date().toISOString()))(),
    config.terms.version,
  );
  if (!isPublicGpu(config.adapter) || !config.public_access)
    throw new Error('public_access_review_required');
  return readReviewedPublicGpu(config, config.public_access, opt);
}

// Bounded transport only, like fetchBounded. Callers must check their own authority
// before entry and before each fetch. It never accepts arbitrary URLs or rights overrides.
export async function readReviewedPublicGpu(
  config: ResearchConfig,
  review: { robots_sha256: string | null; terms_sha256: string | null },
  opt: NetworkOptions,
) {
  if (!isPublicGpu(config.adapter)) throw new Error('public_gpu_scope_invalid');
  const endpoints = publicGpuEndpoints[config.adapter];
  const read = (url: string, format: 'html' | 'csv', maxBytes: number) =>
    fetchBounded(
      { ...config.source, max_bytes: maxBytes },
      { url, method: 'GET', headers: { 'user-agent': PUBLIC_GPU_UA } },
      {
        ...opt,
        max_attempts: 1,
        timeout_ms: Math.min(opt.timeout_ms ?? 15000, 15000),
        onBody: undefined,
        validators: undefined,
      },
      format,
    );
  const robots = await read(endpoints.robots, 'csv', 16384);
  if (robots.status !== 200 || (await robotsFingerprint(robots.text)) !== review.robots_sha256)
    throw new FetchFailure('public_gpu_robots_review_required');
  const terms = await read(endpoints.terms, 'html', 1000000);
  if (terms.status !== 200 || (await termsFingerprint(terms.text)) !== review.terms_sha256)
    throw new FetchFailure('public_gpu_terms_review_required');
  return read(endpoints.page, 'html', config.source.max_bytes);
}

export const gpuReviewErrors = [
  'public_gpu_schema_invalid',
  'http_401',
  'http_403',
  'redirect_blocked',
  'public_gpu_access_challenge',
  'public_gpu_robots_review_required',
  'public_gpu_terms_review_required',
  'public_gpu_table_schema_changed',
  'public_gpu_table_missing',
  'public_gpu_nested_table',
  'public_gpu_price_schema_changed',
  'public_gpu_quantity_schema_changed',
  'public_gpu_storage_schema_changed',
  'public_gpu_period_schema_changed',
  'public_gpu_execution_basis_unconfirmed',
  'unexpected_content_type',
  'research_duplicate_record',
  'research_page_limit',
  'response_too_large',
] as const;
