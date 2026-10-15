import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import eiaProposal from '../config/proposals/research/eia_retail_co_ind.json';
import jepxProposal from '../config/proposals/research/jepx_tokyo.json';
import { ResearchConfigSchema } from '../src/research/schema';
export const researchTime = '2026-10-15T01:00:00.000Z';
export const eiaQuery = { kind: 'eia_retail', from: '2026-07', to: '2026-08' } as const;
export const jepxQuery = { kind: 'jepx_spot', delivery_date: '2026-10-15' } as const;
export function researchSource(adapter: 'eia_retail' | 'jepx_spot' = 'eia_retail') {
  const c = ResearchConfigSchema.parse(
    structuredClone(adapter === 'eia_retail' ? eiaProposal : jepxProposal),
  );
  // Artificial grants exist in test memory only, never in deployable source config.
  c.source.enabled = true;
  for (const right of ['automated_collection', 'private_storage', 'internal_analysis'] as const)
    c.source.policy.rights[right] = 'allowed';
  c.owner_approval_ref = 'synthetic-owner';
  c.wire_contract_review_ref = 'synthetic-wire-contract';
  c.retention.reviewed_ref = 'synthetic-retention';
  return c;
}
export const researchFixture = (name: string) =>
  readFileSync(new NodeURL('./fixtures/research/' + name, import.meta.url), 'utf8');
export function eiaPage(index: number, total = 2) {
  const fixture = JSON.parse(researchFixture('eia.synthetic.json'));
  fixture.response.total = String(total);
  fixture.response.data = fixture.response.data.slice(index, index + 1);
  return JSON.stringify(fixture);
}
export const opts = (
  text: string,
  now = researchTime,
  adapter: 'eia_retail' | 'jepx_spot' = 'eia_retail',
) => ({
  synthetic_text: text,
  now: () => now,
  current_terms_version: researchSource(adapter).terms.version,
});
