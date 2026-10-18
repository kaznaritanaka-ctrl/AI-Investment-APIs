import {
  ResearchConfigSchema,
  assertResearchAllowed,
  assertResearchRetentionReviewed,
} from '../src/research/schema';
import { isPublicGpu } from '../src/research/public-gpu-contract';
import { errorCode, isoTime } from '../src/util';

// Offline diagnostics only. This neither establishes rights nor authorizes a live run.
export function inspectPublicGpuPreparation(input: unknown, now: string) {
  const base = {
    scope: 'offline_configuration_only',
    network_performed: false,
    storage_opened: false,
    live_verified: false,
    production_ready: false,
  } as const;
  const parsed = ResearchConfigSchema.safeParse(input);
  if (!parsed.success || !isPublicGpu(parsed.data.adapter) || !isoTime(now))
    return {
      ...base,
      source_id: null,
      status: 'blocked',
      gate_reason: !isoTime(now) ? 'invalid_research_time' : 'invalid_public_gpu_config',
      checks: [],
    };
  const c = parsed.data;
  const passes = (fn: () => void) => {
    try {
      fn();
      return true;
    } catch {
      return false;
    }
  };
  const checks = [
    { name: 'source_enabled', passed: c.source.enabled },
    ...(['automated_collection', 'private_storage', 'internal_analysis'] as const).map((right) => ({
      name: right,
      passed: c.source.policy.rights[right] === 'allowed',
    })),
    {
      name: 'policy_window',
      passed:
        now >= c.source.policy.valid_from &&
        (c.source.policy.valid_until === null || now < c.source.policy.valid_until),
    },
    { name: 'owner_review', passed: !!c.owner_approval_ref },
    { name: 'wire_contract_review', passed: !!c.wire_contract_review_ref },
    {
      name: 'projection_scope',
      passed: c.source.policy.fields.includes('domestic_gpu_projection_v1'),
    },
    { name: 'retention_review', passed: passes(() => assertResearchRetentionReviewed(c)) },
    {
      name: 'public_access_review',
      passed: !!(
        c.public_access?.reviewed_ref &&
        c.public_access.robots_sha256 &&
        c.public_access.terms_sha256 &&
        c.public_access.robots_decision === 'allowed'
      ),
    },
    {
      name: 'configured_terms_review_window',
      passed:
        c.source.policy.evidence_version === c.terms.version &&
        now >= c.terms.checked_at &&
        now < c.terms.review_after,
    },
  ];
  let gateReason: string | null = null;
  try {
    // Use the actual acquisition gate as the verdict, not the explanatory checklist.
    // The configured version is not independently verified against the website here.
    assertResearchAllowed(c, now, c.terms.version);
  } catch (error) {
    gateReason = errorCode(error);
  }
  return {
    ...base,
    source_id: c.source.source_id,
    status: gateReason === null ? 'configuration_passed' : 'blocked',
    gate_reason: gateReason,
    configured_terms_review_after: c.terms.review_after,
    checks,
  };
}
