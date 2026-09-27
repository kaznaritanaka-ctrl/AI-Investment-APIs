import type { Source } from './schema';
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
    'SELECT suspended,enabled,policy_version FROM sources WHERE source_id=?',
  )
    .bind(source.source_id)
    .first<{ suspended: number; enabled: number; policy_version: string }>();
  if (!row || row.suspended || !row.enabled || row.policy_version !== source.policy.version)
    throw new Error('source_suspended_or_policy_changed');
}
