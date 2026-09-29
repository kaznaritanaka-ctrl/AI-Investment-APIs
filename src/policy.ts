import type { Source } from './schema';
import { stable } from './util';
export function modelsAuthorizationReady(s: Source) {
  if (!s.models) return true;
  const m = s.models,
    grant = s.policy.models_scope;
  if (
    s.adapter !== 'models_dev' ||
    s.dataset_type !== 'ai_api_prices' ||
    s.selection.length ||
    !m.owner_approval_ref ||
    !m.runtime_review_ref ||
    !m.retention.reviewed_ref ||
    !grant ||
    !m.fields.includes('id') ||
    !s.policy.fields.includes('models_projection_v2')
  )
    return false;
  if (
    new Set(m.providers).size !== m.providers.length ||
    new Set(m.fields).size !== m.fields.length
  )
    return false;
  if (
    !m.providers.every((p) => grant.providers.includes(p)) ||
    !m.fields.every((f) => grant.fields.includes(f))
  )
    return false;
  if (s.policy.retention_days !== m.retention.evidence_days) return false;
  const limit = s.policy.retention_limit_days;
  return (
    !limit ||
    (m.retention.evidence_days <= limit &&
      m.retention.archive_days <= limit &&
      m.retention.normalized_days + m.retention.backup_days <= limit)
  );
}
export function gpuAuthorizationReady(s: Source) {
  if (!['gpu_rental', 'gpu_secondary'].includes(s.dataset_type)) return true;
  const g = s.gpu;
  if (
    !g?.owner_approval_ref ||
    !g.retention.reviewed_ref ||
    !s.policy.fields.includes('gpu_projection_v1')
  )
    return false;
  if (
    s.policy.retention_limit_days &&
    g.retention.normalized_days &&
    g.retention.backup_days &&
    g.retention.normalized_days + g.retention.backup_days > s.policy.retention_limit_days
  )
    return false;
  return [
    g.retention.evidence_days,
    g.retention.archive_days,
    g.retention.normalized_days,
    g.retention.backup_days,
  ].every(
    (n) =>
      n !== null && n > 0 && (!s.policy.retention_limit_days || n <= s.policy.retention_limit_days),
  );
}
export function validPolicy(source: Source, now: string): boolean {
  const p = source.policy;
  return source.enabled && now >= p.valid_from && (!p.valid_until || now < p.valid_until);
}
export function canCollect(source: Source, now: string): boolean {
  return (
    validPolicy(source, now) &&
    gpuAuthorizationReady(source) &&
    modelsAuthorizationReady(source) &&
    ['automated_collection', 'private_storage', 'internal_analysis'].every(
      (k) => source.policy.rights[k as keyof typeof source.policy.rights] === 'allowed',
    )
  );
}
export function canPublish(source: Source, now: string, derived = false): boolean {
  return (
    canCollect(source, now) &&
    [
      'public_display',
      'normalized_redistribution',
      'commercial_redistribution',
      ...(derived ? ['derived_redistribution'] : []),
    ].every((k) => source.policy.rights[k as keyof typeof source.policy.rights] === 'allowed')
  );
}
export function canPublishDerived(inputs: Source[], now: string): boolean {
  return inputs.length > 0 && inputs.every((s) => canPublish(s, now, true));
}

export async function assertPersistenceAllowed(
  env: import('./schema').CollectorEnv,
  source: Source,
  now: string,
) {
  if (!canCollect(source, now)) throw new Error('policy_blocked');
  const row = await env.PRIVATE_DB.prepare(
    'SELECT suspended,enabled,policy_version,config_json FROM sources WHERE source_id=?',
  )
    .bind(source.source_id)
    .first<{ suspended: number; enabled: number; policy_version: string; config_json: string }>();
  if (!row || row.suspended || !row.enabled || row.policy_version !== source.policy.version)
    throw new Error('source_suspended_or_policy_changed');
  if (source.models && stable(JSON.parse(row.config_json)) !== stable(source))
    throw new Error('model_scope_changed');
}
