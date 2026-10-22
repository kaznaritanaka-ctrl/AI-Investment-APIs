import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SourceSchema } from '../src/schema';
import { ResearchConfigSchema } from '../src/research/schema';
import { canCollect, canPublish } from '../src/policy';
import { hash, stable } from '../src/util';
import { ESTAT_CREDIT } from '../src/estat-schema';

const reviewDate = '2026-10-21T00:00:00.000Z';
const reviewPath = 'docs/license-review-20261021.md';
const review = readFileSync(reviewPath, 'utf8');
const register = readFileSync('docs/source-register.md', 'utf8');
const sources = readdirSync('config/sources')
  .filter((name) => name.endsWith('.json'))
  .map((name) => SourceSchema.parse(JSON.parse(readFileSync('config/sources/' + name, 'utf8'))));
const publicationRights = [
  'public_display',
  'raw_redistribution',
  'normalized_redistribution',
  'derived_redistribution',
  'commercial_redistribution',
] as const;
const explicitRestrictions = ['openrouter', 'runpod', 'ccir'];

describe('owner-commissioned license metadata (offline)', () => {
  it('documents terms or a null reason and a valid review timestamp for every source file', () => {
    for (const s of sources) {
      expect(new Date(s.rights_checked_at).toISOString()).toBe(s.rights_checked_at);
      if (s.terms_url === null) {
        expect(s.known_limitations.join(' ')).toContain(
          'terms_url/license_url are null: provider/dataset not selected',
        );
        expect(register).toContain('| ' + s.source_id + ' |');
        expect(s.rights_evidence_ref).toBe(reviewPath + '#' + s.source_id);
      } else expect(new URL(s.terms_url).protocol).toBe('https:');
    }
  });

  it('keeps every disabled source blocked and records only explicit publication denials', () => {
    expect(
      sources
        .filter((s) => s.enabled)
        .map((s) => s.source_id)
        .sort(),
    ).toEqual(['ecb', 'estat_meti_iip', 'estat_meti_seidou', 'models_dev', 'price_of_compute']);
    for (const s of sources.filter((s) => !s.enabled)) {
      expect(canCollect(s, reviewDate)).toBe(false);
      expect(canPublish(s, reviewDate, true)).toBe(false);
      if (s.estat) continue; // The separately approved 2026-10-22 scope is checked below.
      expect(s.rights_checked_at).toBe(reviewDate);
      expect(s.rights_evidence_ref).toBe(reviewPath + '#' + s.source_id);
      expect(review).toContain('<a id="' + s.source_id + '"></a>');
      expect(s.license_url).toBeNull();
      expect(s.known_limitations.join(' ')).toContain('2026-10-21 license review:');
      for (const [right, status] of Object.entries(s.policy.rights)) {
        const denied =
          explicitRestrictions.includes(s.source_id) &&
          publicationRights.some((publicationRight) => publicationRight === right);
        expect(status, s.source_id + ':' + right).toBe(denied ? 'denied' : 'review_required');
      }
      if (explicitRestrictions.includes(s.source_id)) {
        expect(s.policy.version).toBe(s.source_id + '-20261021-license-review-v2');
        expect(s.policy.evidence_refs).toContain(s.rights_evidence_ref);
        expect(s.policy.conditions.join(' ')).toContain(s.rights_evidence_ref);
        expect(s.policy.conditions.join(' ')).toContain(s.terms_url);
      }
      expect(canCollect(s, reviewDate)).toBe(false);
      expect(canPublish(s, reviewDate, true)).toBe(false);
    }
    expect(sources.some((s) => s.source_id === 'rebro')).toBe(false);
    expect(register).toContain('| Rebro (G3) |');
  });

  it('registers the two owner-approved e-Stat public scopes, enabled after the reviewed layout check', () => {
    const approved = sources.filter((s) => s.estat);
    expect(approved.map((s) => s.source_id).sort()).toEqual([
      'estat_meti_iip',
      'estat_meti_seidou',
    ]);
    for (const s of approved) {
      expect(s.enabled).toBe(true);
      expect(s.estat!.owner_approval_ref).toBe('Kaz owner approval 2026-10-22T09:43Z estat');
      expect(s.attribution_text).toContain(ESTAT_CREDIT);
      expect(s.rights_evidence_ref).toBe('docs/supply-chain-stats.md#rights');
      for (const [right, status] of Object.entries(s.policy.rights))
        expect(status).toBe(
          ['raw_redistribution', 'external_llm_processing'].includes(right) ? 'denied' : 'allowed',
        );
      expect(canCollect(s, '2026-10-22T09:43:00.000Z')).toBe(true);
      expect(canPublish(s, '2026-10-22T09:43:00.000Z')).toBe(true);
      // Outside the approved policy window nothing is collected or published.
      expect(canCollect(s, '2027-01-22T00:00:00.000Z')).toBe(false);
    }
  });

  it('preserves the license review metadata and existing private-only PoC approval', async () => {
    const s = sources.find((s) => s.source_id === 'price_of_compute')!;
    expect(s.rights_checked_at).toBe(reviewDate);
    expect(s.rights_evidence_ref).toBe(reviewPath + '#price_of_compute');
    expect(s.terms_url).toBe('https://www.priceofcompute.com/api');
    expect(s.license_url).toBeNull();
    expect(s.attribution_text).toBe(
      'Data: Price of Compute (https://www.priceofcompute.com/); visible link required, not a redistribution grant',
    );
    expect(s.known_limitations).toContain(
      '2026-10-21 license review: API page requires a visible Price of Compute link for free use; redistribution/commercial scope and upstream terms remain ambiguous. Non-public, review_required.',
    );
    expect(canCollect(s, reviewDate)).toBe(true);
    expect(canPublish(s, reviewDate, true)).toBe(false);
    // Canonical hashes from production 0abf2b6: no new grant, SKU or retention change.
    expect(await hash(stable(s.policy))).toBe(
      'a9954a7e462de0a2388b80c8122dbd8e9c3e641d502780a3b1aadf21ac8d2af8',
    );
    expect(
      await hash(
        stable({
          policy: s.policy,
          adapter: s.adapter,
          endpoint: s.endpoint,
          selection: s.selection,
          gpu: s.gpu,
        }),
      ),
    ).toBe('cf525a8bc60a902190cd50cf907fa01ce64fc8e7e724a9a18b9a7cce5bfacb3f');
  });

  // Captured before this metadata change, using the same canonical serialization as syncSource.
  it.each([
    [
      'ecb',
      'fed1df58743881cd94d575d36fb7dcae7e0679f6f70570b46b0a29bdc9465231',
      '0b66092a9aacac0e27f9d9bb62d0c5a28f8696b490b2407ab416232850fb5e67',
    ],
    [
      'models_dev',
      'cc050637ee3852946a35bf96cd340c9bece0d3d05cbaa5fd9a5866212843e3de',
      'fd08bb9f3d7edc37b54a284cfc2e0c45d944f0567974f2f001381d879239459d',
    ],
  ])(
    'preserves the production policy and configuration hashes for %s',
    async (id, policy, config) => {
      const s = sources.find((s) => s.source_id === id)!;
      expect(await hash(stable(s.policy))).toBe(policy);
      expect(
        await hash(
          stable({
            policy: s.policy,
            adapter: s.adapter,
            endpoint: s.endpoint,
            selection: s.selection,
            ...(s.gpu ? { gpu: s.gpu } : {}),
            ...(s.models ? { models: s.models } : {}),
          }),
        ),
      ).toBe(config);
    },
  );

  it('records research findings without approving collection, publication or retention', () => {
    for (const name of readdirSync('config/proposals/research').filter(
      (name) => (name.startsWith('eia_') || name === 'jepx_tokyo.json') && name.endsWith('.json'),
    )) {
      const c = ResearchConfigSchema.parse(
        JSON.parse(readFileSync('config/proposals/research/' + name, 'utf8')),
      );
      const id = name.startsWith('eia_') ? 'eia' : 'jepx';
      expect(c.source.rights_checked_at).toBe(reviewDate);
      expect(c.source.rights_evidence_ref).toBe(reviewPath + '#' + id);
      expect(review).toContain('<a id="' + id + '"></a>');
      expect(c.source.license_url).toBe(
        id === 'eia' ? 'https://www.eia.gov/about/copyrights_reuse.php' : null,
      );
      expect(c.source.enabled).toBe(false);
      expect(Object.values(c.source.policy.rights)).not.toContain('allowed');
      expect(c.owner_approval_ref).toBeNull();
      expect(c.wire_contract_review_ref).toBeNull();
      expect(c.retention.normalized_mode).toBe('unapproved');
      expect(c.retention.normalized_days).toBeNull();
      expect(canCollect(c.source, reviewDate)).toBe(false);
      expect(canPublish(c.source, reviewDate)).toBe(false);
    }
  });
});
