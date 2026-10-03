import { hash, isoTime } from './util';

// collection_runs contains collection work only. Watchdog and continuation are
// invocation kinds which inspect/resume that work; they never mint a new run.
export function minuteSlot(scheduled: string): string {
  if (!isoTime(scheduled)) throw new Error('invalid_schedule');
  return new Date(Math.floor(Date.parse(scheduled) / 60000) * 60000).toISOString();
}

// Anchor to the event's scheduledTime, never the wall clock at handler execution.
// Only the explicitly supported daily UTC Cron is accepted (fail closed).
export function dailyCollectionSlot(cron: string | undefined, scheduledTime: number): string {
  const parts = cron?.trim().split(/\s+/);
  if (
    !parts ||
    parts.length !== 5 ||
    !/^\d+$/.test(parts[0]) ||
    !/^\d+$/.test(parts[1]) ||
    Number(parts[0]) > 59 ||
    Number(parts[1]) > 23 ||
    parts.slice(2).some((part) => part !== '*') ||
    !Number.isFinite(scheduledTime)
  )
    throw new Error('invalid_collection_cron');
  const day = new Date(scheduledTime);
  day.setUTCHours(Number(parts[1]), Number(parts[0]), 0, 0);
  if (day.getTime() > scheduledTime) day.setUTCDate(day.getUTCDate() - 1);
  return day.toISOString();
}

type StoredRun = {
  run_id: string;
  scheduled_for: string;
  state: string;
  lease_until: string | null;
  recovery_count: number;
  observation_count: number;
  accepted_count: number;
};

export async function collectionIdentity(db: D1Database, source: string, scheduled: string) {
  const slot = minuteSlot(scheduled);
  // Uses the existing UNIQUE(source_id,scheduled_for) index. A successful legacy
  // row must win over the erroneous zero-second missing row left by old watchdogs.
  const row = await db
    .prepare(
      "SELECT run_id,scheduled_for,state,lease_until,recovery_count,observation_count,accepted_count FROM collection_runs WHERE source_id=? AND scheduled_for>=? AND scheduled_for<? ORDER BY CASE state WHEN 'complete' THEN 0 WHEN 'quarantined' THEN 1 WHEN 'missing' THEN 3 ELSE 2 END,scheduled_for,run_id LIMIT 1",
    )
    .bind(source, slot, new Date(Date.parse(slot) + 60000).toISOString())
    .first<StoredRun>();
  const storedSlot = row?.scheduled_for ?? slot;
  // Keep the existing collection namespace and legacy IDs/evidence/checkpoints.
  const id = await hash(source + '|' + storedSlot);
  if (row && id !== row.run_id) throw new Error('collection_run_identity_mismatch');
  return { kind: 'collection' as const, slot, storedSlot, run_id: id, row };
}
