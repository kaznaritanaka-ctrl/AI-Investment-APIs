import { z } from 'zod';

export const publicGpuEndpoints = {
  highreso_public: {
    page: 'https://soroban.highreso.jp/compute/instances',
    robots: 'https://soroban.highreso.jp/robots.txt',
    terms: 'https://soroban.highreso.jp/terms',
  },
  rebro_public: {
    page: 'https://gpu-kaitori.com/reason/',
    robots: 'https://gpu-kaitori.com/robots.txt',
    terms: 'https://gpu-kaitori.com/rules/',
  },
} as const;
export type PublicGpuAdapter = keyof typeof publicGpuEndpoints;
export const isPublicGpu = (adapter: string): adapter is PublicGpuAdapter =>
  adapter === 'highreso_public' || adapter === 'rebro_public';
export const PublicAccessReviewSchema = z
  .object({
    // These are reviewed fingerprints, not permissions inferred from HTTP 200 or robots.
    robots_sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    terms_sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    robots_decision: z.enum(['unreviewed', 'allowed']),
    reviewed_ref: z.string().trim().min(1).nullable(),
  })
  .strict();
export const PUBLIC_GPU_UA =
  'AIInvestmentResearch/0.1 (+https://github.com/kaznaritanaka-ctrl/AI-Investment-APIs; private-research)';

// Only constants chosen by the validated adapter may become SQL identifiers.
export const researchTable = (adapter: string) =>
  isPublicGpu(adapter) ? 'research_gpu_observations' : 'research_observations';
