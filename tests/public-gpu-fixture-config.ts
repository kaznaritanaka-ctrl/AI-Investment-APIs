import highreso from '../config/proposals/research/highreso_public.json';
import rebro from '../config/proposals/research/rebro_public.json';
import { ResearchConfigSchema } from '../src/research/schema';
import { robotsFingerprint, termsFingerprint } from '../src/research/public-gpu-html';
import type { PublicGpuAdapter } from '../src/research/public-gpu-contract';
export const gpuTime = '2026-10-18T01:00:00.000Z';
export const robots = 'User-agent: *\nAllow: /\n# SYNTHETIC ONLY';
export const terms = '<html><body>SYNTHETIC terms fixture, no real grant</body></html>';
export async function publicGpuSource(adapter: PublicGpuAdapter = 'highreso_public') {
  const c = ResearchConfigSchema.parse(
    structuredClone(adapter === 'highreso_public' ? highreso : rebro),
  );
  // Synthetic regression covers both counts; the unapproved real proposal selects one GPU only.
  if (c.scope.kind === 'highreso_public') c.scope.gpu_counts = [1, 2];
  c.source.enabled = true;
  for (const right of ['automated_collection', 'private_storage', 'internal_analysis'] as const)
    c.source.policy.rights[right] = 'allowed';
  c.owner_approval_ref = 'synthetic-owner';
  c.wire_contract_review_ref = 'synthetic-html-contract';
  c.public_access = {
    robots_sha256: await robotsFingerprint(robots),
    terms_sha256: await termsFingerprint(terms),
    robots_decision: 'allowed',
    reviewed_ref: 'synthetic-access-only',
  };
  Object.assign(c.retention, {
    normalized_mode: 'fixed_days',
    normalized_days: 90,
    time_travel_days: 7,
    reviewed_ref: 'synthetic-retention',
    lifecycle_review_ref: 'synthetic-lifecycle',
  });
  return c;
}
