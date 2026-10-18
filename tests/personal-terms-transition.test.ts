import { describe, it, expect, vi } from 'vitest';
import { personalFixture } from './personal-fixture';
import { PersonalV1Schema, inspectPersonalContract } from '../src/research/personal-contract';
import {
  HIGHRESO_POST_TERMS_URL,
  HIGHRESO_DOMESTIC_TERMS_BOUNDARY,
  publicGpuEndpoints,
} from '../src/research/public-gpu-contract';
import { readReviewedPublicGpu } from '../src/research/public-gpu-network';
import { termsFingerprint } from '../src/research/public-gpu-html';
import { gpuFetcher, terms } from './public-gpu-helpers';
const newTerms = terms.replace('fixture', 'synthetic new edition');
async function post() {
  const c = await personalFixture();
  return {
    ...c,
    decision: {
      ...c.decision,
      acquisition_from: HIGHRESO_DOMESTIC_TERMS_BOUNDARY,
      acquisition_until: '2026-11-01T15:00:00.000Z',
      analysis_until: '2026-11-10T00:00:00.000Z',
      storage_until: '2026-11-20T00:00:00.000Z',
      terms: {
        ...c.decision.terms,
        version: 'SYNTHETIC revised terms',
        applicability: 'highreso_domestic_post_20261101',
        monitored_url: HIGHRESO_POST_TERMS_URL,
        review_after: '2026-11-10T00:00:00.000Z',
        terms_sha256: await termsFingerprint(newTerms),
        transition: {
          effective_from: HIGHRESO_DOMESTIC_TERMS_BOUNDARY,
          previous_terms_sha256: c.decision.terms.terms_sha256,
          new_document_review_ref: 'SYNTHETIC ONLY',
          public_page_applicability_ref: 'SYNTHETIC ONLY',
          private_acquisition_storage_analysis_basis_ref: 'SYNTHETIC ONLY',
        },
      },
    },
  };
}
describe('separately reviewed Highreso November terms, synthetic only', () => {
  it('stops the old contract exactly at the JST boundary and never extends it from the old hash', async () => {
    const c = await personalFixture();
    c.decision.acquisition_until = HIGHRESO_DOMESTIC_TERMS_BOUNDARY;
    c.decision.terms.review_after = HIGHRESO_DOMESTIC_TERMS_BOUNDARY;
    c.decision.analysis_until = '2026-11-01T00:00:00.000Z';
    await expect(
      inspectPersonalContract(c, '2026-10-31T14:59:59.999Z', 'test', 'collect'),
    ).resolves.toBeDefined();
    await expect(
      inspectPersonalContract(c, HIGHRESO_DOMESTIC_TERMS_BOUNDARY, 'test', 'collect'),
    ).rejects.toThrow('personal_terms_review_required');
    c.decision.terms.review_after = '2026-11-02T00:00:00.000Z';
    expect(PersonalV1Schema.safeParse(c).success).toBe(false);
  });
  it('requires new document hash, fixed monitor, application/basis review and a separate post-change window', async () => {
    const c = await post();
    expect(PersonalV1Schema.safeParse(c).success).toBe(true);
    for (const patch of [
      { transition: undefined },
      { terms_sha256: c.decision.terms.transition.previous_terms_sha256 },
      { monitored_url: publicGpuEndpoints.highreso_public.terms },
      { transition: { ...c.decision.terms.transition, public_page_applicability_ref: '' } },
    ])
      expect(
        PersonalV1Schema.safeParse({
          ...c,
          decision: { ...c.decision, terms: { ...c.decision.terms, ...patch } },
        }).success,
      ).toBe(false);
    expect(
      PersonalV1Schema.safeParse({
        ...c,
        decision: { ...c.decision, acquisition_from: '2026-10-30T00:00:00.000Z' },
      }).success,
    ).toBe(false);
    const rebro = await personalFixture('rebro_public');
    expect(
      PersonalV1Schema.safeParse({
        ...rebro,
        decision: { ...rebro.decision, terms: c.decision.terms },
      }).success,
    ).toBe(false);
  });
  it('uses only three fixed URLs and blocks wrong post-change hashes before the price GET', async () => {
    const c = PersonalV1Schema.parse(await post()),
      fallback = gpuFetcher('highreso_public');
    const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) =>
      String(url) === HIGHRESO_POST_TERMS_URL
        ? new Response(newTerms, { headers: { 'content-type': 'text/html' } })
        : fallback(url, init),
    );
    await readReviewedPublicGpu(c.config, c.decision.terms, { fetcher });
    expect(fetcher.mock.calls.map(([u]) => String(u))).toEqual([
      publicGpuEndpoints.highreso_public.robots,
      HIGHRESO_POST_TERMS_URL,
      publicGpuEndpoints.highreso_public.page,
    ]);
    fetcher.mockClear();
    await expect(
      readReviewedPublicGpu(
        c.config,
        { ...c.decision.terms, terms_sha256: '0'.repeat(64) },
        { fetcher },
      ),
    ).rejects.toThrow('public_gpu_terms_review_required');
    expect(fetcher).toHaveBeenCalledTimes(2);
    fetcher.mockClear();
    await expect(
      readReviewedPublicGpu(
        c.config,
        { ...c.decision.terms, monitored_url: 'https://example.test' },
        { fetcher },
      ),
    ).rejects.toThrow('public_gpu_terms_monitor_invalid');
    expect(fetcher).not.toHaveBeenCalled();
  });
});
