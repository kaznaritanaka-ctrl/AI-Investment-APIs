import { highresoKeys, HIGHRESO_METHOD } from './highreso-identity';
import { PublicGpuRecordSchema, type PublicGpuRecord } from './public-gpu-html';
import type { ResearchEnv } from './pipeline';

export type GpuHistoryRow = {
  observation_id: string;
  previous_observation_id: string | null;
  record_key: string;
  domain_json: string;
  change_kind: string;
  observed_at: string;
  method_version?: string;
  original_record_key?: string;
  stored_change_kind?: string;
};
// Projection only: saved rows/counts are verified before calling this function.
// Both endpoints must have passed the caller's current rights/retention/marker gates.
export async function resolveHighresoHistory<T extends GpuHistoryRow>(
  env: ResearchEnv,
  snapshots: { rows: T[] }[],
) {
  const rows = snapshots.flatMap((s) => s.rows);
  if (!rows.length) return;
  const byId = new Map(rows.map((r) => [r.observation_id, r]));
  const links = (
    await env.PRIVATE_DB.prepare(
      `SELECT from_observation_id,to_observation_id FROM research_identity_links
     WHERE source_id='highreso_public' AND to_observation_id IN (SELECT value FROM json_each(?))`,
    )
      .bind(JSON.stringify([...byId.keys()]))
      .all<{ from_observation_id: string; to_observation_id: string }>()
  ).results;
  const aliases = new Map<string, string>();
  const resolve = (key: string) => {
    const visited = new Set<string>();
    while (aliases.has(key)) {
      if (visited.has(key)) throw new Error('research_identity_link_conflict');
      visited.add(key);
      key = aliases.get(key)!;
    }
    return key;
  };
  const join = (from: string, to: string) => {
    const a = resolve(from),
      b = resolve(to);
    if (a !== b) aliases.set(a, b);
  };
  const parsed = new Map<string, PublicGpuRecord>();
  for (const row of rows) {
    if (row.change_kind !== 'not_seen')
      parsed.set(row.observation_id, PublicGpuRecordSchema.parse(JSON.parse(row.domain_json)));
  }
  const readableLinks = links.filter(
    (link) => byId.has(link.from_observation_id) && byId.has(link.to_observation_id),
  );
  const canonicalKeys = new Map<string, string>();
  if (readableLinks.length || rows.some((r) => r.method_version === HIGHRESO_METHOD)) {
    for (const snapshot of snapshots) {
      const legacy = snapshot.rows.filter(
        (r) => r.method_version === 'domestic-gpu-html-v2' && parsed.has(r.observation_id),
      );
      const records = legacy.map((r) => parsed.get(r.observation_id)!);
      const keys = await highresoKeys(records);
      // Resolve each observation separately: a reused legacy instance name may
      // have different storage/OS/product conditions on different days.
      for (const row of legacy)
        canonicalKeys.set(row.observation_id, keys.get(parsed.get(row.observation_id)!)!);
    }
  }
  const keyOf = (row: GpuHistoryRow) => canonicalKeys.get(row.observation_id) ?? row.record_key;
  for (const row of rows) {
    const previous = row.previous_observation_id && byId.get(row.previous_observation_id);
    if (!previous) continue;
    if (row.change_kind === 'not_seen' && row.method_version !== HIGHRESO_METHOD)
      canonicalKeys.set(row.observation_id, keyOf(previous));
    // The forward boundary was matched at write time, with immutable lineage.
    if (row.record_key.startsWith('hr:v2:') && row.change_kind !== 'not_seen')
      join(keyOf(previous), keyOf(row));
  }
  const renames = new Map<string, string>();
  for (const link of readableLinks) {
    const from = byId.get(link.from_observation_id),
      to = byId.get(link.to_observation_id);
    if (!from || !to) continue;
    const old = parsed.get(from.observation_id),
      current = parsed.get(to.observation_id);
    if (!old || !current) throw new Error('research_identity_link_conflict');
    join(keyOf(from), keyOf(to));
    if (old.instance_id && old.instance_id !== current.instance_id)
      renames.set(to.observation_id, old.instance_id);
  }
  for (const snapshot of snapshots) {
    for (const row of snapshot.rows) {
      const key = resolve(keyOf(row));
      if (key !== row.record_key) row.original_record_key = row.record_key;
      row.record_key = key;
      const record = parsed.get(row.observation_id);
      if (record) {
        const changedFrom = renames.get(row.observation_id);
        row.domain_json = JSON.stringify({
          ...record,
          record_key: row.record_key,
          offer: { ...record.offer, record_key: row.record_key },
          ...(changedFrom ? { instance_id_changed_from: changedFrom } : {}),
        });
        if (changedFrom) {
          row.stored_change_kind = row.change_kind;
          row.change_kind = 'revised';
        }
      }
    }
    const active = new Set(
      snapshot.rows.filter((r) => r.change_kind !== 'not_seen').map((r) => r.record_key),
    );
    snapshot.rows = snapshot.rows.filter(
      (r) => r.change_kind !== 'not_seen' || !active.has(r.record_key),
    );
  }
}
