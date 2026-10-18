import { describe, it, expect } from 'vitest';
import draft from '../docs/public-gpu-personal-research-draft-20261018.json';
import { inspectPersonalContract, PersonalContractSchema } from '../src/research/personal-contract';
import { assertResearchAllowed, assertResearchExport } from '../src/research/schema';
import { inspectPersonalPreparation } from '../scripts/personal-preparation';
import { personalFixture, gpuTime } from './personal-fixture';

describe('personal authority, synthetic contracts only', () => {
  it.each(['highreso_public', 'rebro_public'] as const)(
    'keeps %s rights unconfirmed while validating separate owner authority',
    async (source) => {
      const c = await personalFixture(source),
        before = JSON.stringify(c.config);
      expect(
        (await inspectPersonalContract(c, gpuTime, 'test', 'collect')).contract.decision
          .provider_permission,
      ).toBe('unconfirmed');
      expect(JSON.stringify(c.config)).toBe(before);
      expect(c.config.source.enabled).toBe(false);
      expect(Object.values(c.config.source.policy.rights)).not.toContain('allowed');
      expect(() => assertResearchAllowed(c.config, gpuTime, c.config.terms.version)).toThrow(
        'policy_blocked',
      );
      for (const purpose of ['public', 'raw', 'external_llm'] as const)
        expect(() => assertResearchExport(c.config, purpose)).toThrow(
          'research_export_not_supported',
        );
    },
  );
  it('rejects the draft and never reports configuration as live or production evidence', async () => {
    expect(await inspectPersonalPreparation(draft, gpuTime)).toMatchObject({
      status: 'blocked',
      reason: 'personal_contract_invalid',
      network_performed: false,
      storage_opened: false,
    });
    expect(await inspectPersonalPreparation(await personalFixture(), gpuTime)).toMatchObject({
      status: 'configuration_passed',
      provider_permission: 'unconfirmed',
      data_origin: 'synthetic',
      live_verified: false,
      production_ready: false,
    });
  });
  it('rejects missing approvals, denied rights, arbitrary endpoints, extra fields and unreviewed copies', async () => {
    const c = await personalFixture();
    const cases = [
      { ...c, status: 'draft' },
      { ...c, decision: { ...c.decision, owner_execution_approval_ref: null } },
      { ...c, decision: { ...c.decision, public_export: true } },
      {
        ...c,
        decision: {
          ...c.decision,
          retention: { ...c.decision.retention, backup_recoverability_days: 7 },
        },
      },
      {
        ...c,
        decision: {
          ...c.decision,
          retention: { ...c.decision.retention, copy_inventory_review_ref: '' },
        },
      },
      { ...c, config: { ...c.config, source: { ...c.config.source, enabled: true } } },
      {
        ...c,
        config: { ...c.config, source: { ...c.config.source, endpoint: 'https://example.test/' } },
      },
      {
        ...c,
        config: {
          ...c.config,
          source: {
            ...c.config.source,
            policy: {
              ...c.config.source.policy,
              rights: { ...c.config.source.policy.rights, private_storage: 'denied' },
            },
          },
        },
      },
      { ...c, bypass: true },
    ];
    for (const candidate of cases)
      expect(PersonalContractSchema.safeParse(candidate).success).toBe(false);
    c.config.source.known_limitations.push('changed');
    await expect(inspectPersonalContract(c, gpuTime, 'test', 'collect')).rejects.toThrow(
      'personal_config_hash_mismatch',
    );
  });
  it('keeps production and synthetic/live stores separate', async () => {
    const c = await personalFixture();
    await expect(inspectPersonalContract(c, gpuTime, 'production', 'maintain')).rejects.toThrow(
      'personal_production_forbidden',
    );
    await expect(inspectPersonalContract(c, gpuTime, 'development', 'collect')).rejects.toThrow(
      'personal_synthetic_boundary',
    );
    await expect(
      inspectPersonalContract({ ...c, data_origin: 'live' }, gpuTime, 'test', 'collect'),
    ).rejects.toThrow('personal_synthetic_boundary');
  });
  it('separates acquisition, terms review, analysis and finite storage windows', async () => {
    const c = await personalFixture();
    await expect(
      inspectPersonalContract(c, c.decision.acquisition_until, 'test', 'collect'),
    ).rejects.toThrow('personal_acquisition_window_closed');
    await expect(
      inspectPersonalContract(c, c.decision.acquisition_until, 'test', 'read'),
    ).resolves.toBeTruthy();
    await expect(
      inspectPersonalContract(c, c.decision.terms.review_after, 'test', 'read'),
    ).rejects.toThrow('personal_terms_review_required');
    await expect(
      inspectPersonalContract(c, c.decision.analysis_until, 'test', 'read'),
    ).rejects.toThrow('personal_analysis_expired');
    await expect(
      inspectPersonalContract(c, c.decision.storage_until, 'test', 'maintain'),
    ).resolves.toBeTruthy();
    c.decision.terms.review_after = '2026-11-01T00:00:00.000Z';
    expect(PersonalContractSchema.safeParse(c).success).toBe(false);
  });
});
