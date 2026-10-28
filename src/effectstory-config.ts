import type { Source } from './schema';

const providerKey = (name: string) => name.trim().toLowerCase();
export function effectstoryProviderExcluded(s: Source, provider: string) {
  const key = providerKey(provider);
  return (
    s.policy.excluded_upstream_providers?.some((entry) =>
      [entry.provider, ...entry.aliases].some((name) => providerKey(name) === key),
    ) ?? false
  );
}

// These explicit prohibitions cannot silently disappear from a reviewed policy.
export function effectstoryExclusionsReady(s: Source) {
  const entries = s.policy.excluded_upstream_providers;
  return (
    Array.isArray(entries) &&
    entries.length > 0 &&
    entries.every(
      (entry) =>
        entry &&
        typeof entry.provider === 'string' &&
        entry.provider.trim() &&
        entry.provider.length <= 120 &&
        Array.isArray(entry.aliases) &&
        entry.aliases.length > 0 &&
        entry.aliases.every(
          (name) => typeof name === 'string' && name.trim() && name.length <= 120,
        ) &&
        typeof entry.reason === 'string' &&
        entry.reason.trim() &&
        Array.isArray(entry.evidence_refs) &&
        entry.evidence_refs.length > 0 &&
        entry.evidence_refs.every((ref) => typeof ref === 'string' && ref.trim()) &&
        Object.keys(entry).every((key) =>
          ['provider', 'aliases', 'reason', 'evidence_refs'].includes(key),
        ),
    ) &&
    [
      { provider: 'runpod', names: ['runpod', 'runpod.io'] },
      { provider: 'openrouter', names: ['openrouter'] },
    ].every(({ provider, names }) =>
      entries.some(
        (entry) =>
          providerKey(entry.provider) === provider &&
          names.every((name) =>
            [entry.provider, ...entry.aliases].some((alias) => providerKey(alias) === name),
          ) &&
          entry.evidence_refs.includes('docs/license-review-20261021.md#' + provider),
      ),
    )
  );
}

// Shared by the runtime rights gate and offline preflight; no grants for other
// GPU sources or arbitrary endpoints follow from the public EffectStory grant.
export function effectstoryAuthorizationReady(s: Source) {
  if (s.adapter !== 'effectstory' && s.source_id !== 'effectstory') return true;
  const g = s.gpu;
  return (
    s.adapter === 'effectstory' &&
    s.source_id === 'effectstory' &&
    s.dataset_type === 'gpu_rental' &&
    s.endpoint === 'https://effectstory.com/en/data/cloud-gpu-pricing' &&
    s.source_url === s.endpoint &&
    s.license_url === 'https://creativecommons.org/licenses/by/4.0/' &&
    s.attribution_text ===
      'Data: EffectStory, Cloud GPU Hourly Pricing (https://effectstory.com/en/data/cloud-gpu-pricing), CC BY 4.0' &&
    s.max_bytes <= 2000000 &&
    s.max_records <= 50 &&
    s.policy.fields.length === 1 &&
    s.policy.fields[0] === 'gpu_projection_v1' &&
    effectstoryExclusionsReady(s) &&
    s.policy.retention_days === 7 &&
    s.policy.rights.raw_redistribution === 'denied' &&
    s.policy.rights.external_llm_processing === 'denied' &&
    g?.owner_approval_ref === 'Kaz owner approval 2026-10-29 00:00 JST EffectStory public' &&
    g.retention.reviewed_ref === 'docs/effectstory.md#retention' &&
    g.retention.evidence_days === 7 &&
    g.retention.archive_days === 7 &&
    g.retention.normalized_days === 180 &&
    g.retention.backup_days === 30 &&
    g.page_size === 50 &&
    g.max_pages === 1 &&
    g.pages_per_invocation === 1 &&
    g.snapshot_max_age_minutes === 360 &&
    g.partitions.length === 1 &&
    g.partitions[0].id === 'full-table' &&
    Object.keys(g.partitions[0].query).length === 0 &&
    g.partitions[0].models.length === 0 &&
    Object.keys(g.region_map).length === 0 &&
    s.selection.length === 0
  );
}
