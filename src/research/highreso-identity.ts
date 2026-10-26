import { hash, stable } from '../canonical';
import type { PublicGpuRecord } from './public-gpu-html';
import type { ResearchConfig } from './schema';

export const HIGHRESO_METHOD = 'domestic-gpu-html-v3' as const;
export const isHighresoIdentityUpgrade = (before: ResearchConfig, after: ResearchConfig) =>
  before.adapter === 'highreso_public' &&
  after.adapter === 'highreso_public' &&
  before.method_version === 'domestic-gpu-html-v2' &&
  after.method_version === HIGHRESO_METHOD &&
  stable(before.scope) === stable(after.scope) &&
  before.source.source_url === after.source.source_url;

export function highresoOS(instance: string | null) {
  const tokens = instance?.split(/[-_]/).filter((s) => /^ubs\d{2}$/.test(s)) ?? [];
  if (tokens.length !== 1) throw new Error('highreso_os_unrecognized');
  return tokens[0];
}
export function highresoContent(record: PublicGpuRecord) {
  return {
    reported_product: record.offer.reported_product,
    gpu_count: record.offer.gpu_count,
    vram: record.identity.vram_gb,
    storage_gb: record.storage_gb,
    os_family: highresoOS(record.instance_id),
    unit: record.offer.unit,
  };
}
// Occurrence is a deterministic multiset position, not a provider/physical machine ID.
export async function highresoKeys(records: PublicGpuRecord[]) {
  const groups = new Map<string, PublicGpuRecord[]>();
  for (const record of records) {
    let content: string;
    try {
      content = stable(highresoContent(record));
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'highreso_os_unrecognized') throw error;
      // Unknown OS must not abort the page or imply a rename. Keep the exact
      // instance name and all identity conditions in a separate key namespace.
      content = stable({
        fallback_reason: 'highreso_os_unrecognized',
        instance_id: record.instance_id,
        reported_product: record.offer.reported_product,
        gpu_count: record.offer.gpu_count,
        vram: record.identity.vram_gb,
        storage_gb: record.storage_gb,
        unit: record.offer.unit,
      });
    }
    const group = groups.get(content) ?? [];
    group.push(record);
    groups.set(content, group);
  }
  const keys = new Map<PublicGpuRecord, string>();
  for (const [content, group] of groups) {
    group.sort((a, b) =>
      a.instance_id! < b.instance_id! ? -1 : a.instance_id! > b.instance_id! ? 1 : 0,
    );
    if (new Set(group.map((r) => r.instance_id)).size !== group.length)
      throw new Error('research_duplicate_record');
    const digest = await hash(content);
    const prefix = JSON.parse(content).fallback_reason ? 'hr:fallback:v1' : 'hr:v2';
    group.forEach((record, i) => keys.set(record, `${prefix}:${digest}:${i + 1}`));
  }
  return keys;
}
export function withHighresoKey(record: PublicGpuRecord, key: string): PublicGpuRecord {
  return { ...record, record_key: key, offer: { ...record.offer, record_key: key } };
}
