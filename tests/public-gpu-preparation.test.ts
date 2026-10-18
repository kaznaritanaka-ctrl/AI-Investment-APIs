import { afterEach, describe, expect, it, vi } from 'vitest';
import highreso from '../config/proposals/research/highreso_public.json';
import rebro from '../config/proposals/research/rebro_public.json';
import { inspectPublicGpuPreparation } from '../scripts/public-gpu-preparation';
import { publicGpuSource, gpuTime } from './public-gpu-fixture-config';

afterEach(() => vi.unstubAllGlobals());
describe('public GPU offline preparation (synthetic permissions only)', () => {
  it('reports both blocked proposals without network, mutation or approving evidence', () => {
    const fetcher = vi.fn(() => {
      throw new Error('unexpected_network');
    });
    vi.stubGlobal('fetch', fetcher);
    const before = JSON.stringify([highreso, rebro]);
    const results = [highreso, rebro].map((c) => inspectPublicGpuPreparation(c, gpuTime));
    for (const result of results) {
      expect(result).toMatchObject({
        status: 'blocked',
        gate_reason: 'policy_blocked',
        network_performed: false,
        storage_opened: false,
        live_verified: false,
        production_ready: false,
      });
      expect(result.checks.filter((c) => !c.passed).map((c) => c.name)).toEqual([
        'source_enabled',
        'automated_collection',
        'private_storage',
        'internal_analysis',
        'owner_review',
        'wire_contract_review',
        'retention_review',
        'public_access_review',
      ]);
    }
    expect(JSON.stringify([highreso, rebro])).toBe(before);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('distinguishes a synthetic configuration pass from legal, live and production approval', async () => {
    const result = inspectPublicGpuPreparation(await publicGpuSource(), gpuTime);
    expect(result).toMatchObject({
      status: 'configuration_passed',
      gate_reason: null,
      scope: 'offline_configuration_only',
      live_verified: false,
      production_ready: false,
    });
    expect(result.checks.every((c) => c.passed)).toBe(true);
  });
  it('requires the existing three rights even if access fingerprints are populated', async () => {
    const c = await publicGpuSource();
    c.source.policy.rights.private_storage = 'review_required';
    expect(inspectPublicGpuPreparation(c, gpuTime).gate_reason).toBe('policy_blocked');
  });
  it('stops at the configured review deadline even without an HTML fingerprint change', async () => {
    const c = await publicGpuSource();
    // Proposed conservative JST midnight boundary, not a real grant or legal timezone finding.
    c.terms.review_after = '2026-10-31T15:00:00.000Z';
    expect(inspectPublicGpuPreparation(c, '2026-10-31T14:59:59.999Z').status).toBe(
      'configuration_passed',
    );
    expect(inspectPublicGpuPreparation(c, c.terms.review_after).gate_reason).toBe(
      'terms_review_required',
    );
  });
  it('uses the runtime retention gate and isolates malformed input from the other source', async () => {
    const c = await publicGpuSource('rebro_public');
    c.retention.time_travel_days = null;
    const results = [null, c].map((input) => inspectPublicGpuPreparation(input, gpuTime));
    expect(results.map((r) => r.gate_reason)).toEqual([
      'invalid_public_gpu_config',
      'retention_review_required',
    ]);
    expect(results[1].source_id).toBe('rebro_public');
  });
  it('returns only fixed diagnostics for invalid time or arbitrary input', () => {
    expect(inspectPublicGpuPreparation(highreso, 'not-a-date').gate_reason).toBe(
      'invalid_research_time',
    );
    const result = inspectPublicGpuPreparation({ secret: 'DO_NOT_OUTPUT' }, gpuTime);
    expect(JSON.stringify(result)).not.toContain('DO_NOT_OUTPUT');
    expect(result.source_id).toBeNull();
  });
});
