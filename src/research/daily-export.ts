import { PersonalDailySchema } from './personal-contract';
import {
  dailyJSON,
  dailyAuthority,
  exportDailyHistory,
  publishDailyCatalog,
  type DailyEnv,
  type DailyExportInput,
} from './personal-daily';
import { dailyRoot, DailyCatalog, DailyPage } from './daily-protocol';
import { syncNasExport } from './nas-export';
import type { NasExportPin } from './nas-export-protocol';
import { hash, stable } from '../util';

// Per source, per idle daily continuation. Never enlarge source HTTP/Cron budgets.
export const DAILY_EXPORT_LIMIT = 4;
export const DAILY_EXPORT_BYTES = DAILY_EXPORT_LIMIT * 524288;
export const DAILY_REFRESH_DAYS = 30;
const day = 86400000;
const later = (at: string, ms: number) => new Date(Date.parse(at) + ms).toISOString();
type ExportRow = DailyExportInput['row'];

export async function refreshDailyExports(env: DailyEnv, source: string, at: string) {
  const started = Date.now();
  const rows = await env.PRIVATE_DB.prepare(
    `SELECT r.*,c.contract_json,v.coverage_json,v.plan_hash FROM personal_daily_runs r
     JOIN personal_daily_contracts c ON c.contract_hash=r.contract_hash
     LEFT JOIN personal_daily_coverage v ON v.run_id=r.run_id
     LEFT JOIN personal_daily_export_work w ON w.run_id=r.run_id
     WHERE r.source_id=? AND r.state='complete' AND
       (r.exported_at IS NULL OR julianday(r.exported_at)<=julianday(?)-MIN(30,MAX(1,(CAST(json_extract(c.contract_json,'$.decision.retention.backup.retention_days') AS INTEGER)-2)/2))) AND
       (w.export_retry_after IS NULL OR w.export_retry_after<=?)
     ORDER BY r.exported_at, r.ordinal DESC LIMIT 4`,
  )
    .bind(source, at, at)
    .all<ExportRow>();
  if (!rows.results.length) return { state: 'current', runs: 0, bytes: 0, failed: 0 };
  const allowed: ExportRow[] = [],
    contracts = new Map<string, ReturnType<typeof PersonalDailySchema.parse>>();
  let failed = 0;
  for (const row of rows.results) {
    try {
      const c = PersonalDailySchema.parse(JSON.parse(row.contract_json));
      if (c.config.source.source_id !== source || (await hash(stable(c))) !== row.contract_hash)
        throw new Error('daily_export_scope');
      await dailyAuthority(env, c, row.contract_hash, at);
      if (await env.EVIDENCE.head(dailyRoot(source) + 'deleted/' + row.run_id + '.json'))
        throw new Error('daily_export_scope');
      allowed.push(row);
      contracts.set(row.run_id, c);
    } catch {
      failed++;
      await env.PRIVATE_DB.prepare(
        `INSERT INTO personal_daily_export_work(run_id,export_retry_after,failure_code) VALUES (?,?,'export_failed') ON CONFLICT(run_id) DO UPDATE SET export_retry_after=excluded.export_retry_after,failure_code=excluded.failure_code`,
      )
        .bind(row.run_id, later(at, 3600000))
        .run();
    }
  }
  if (!allowed.length) return { state: 'blocked', runs: 0, bytes: 0, failed };
  // Current storage authority must precede reading any normalized price body.
  // The exporter rechecks authority again before committing each snapshot.
  const ids = allowed.map((r) => r.run_id);
  const records = await env.PRIVATE_DB.prepare(
    `SELECT * FROM personal_daily_observations WHERE run_id IN (${ids.map(() => '?').join(',')}) ORDER BY run_id,record_key LIMIT 1025`,
  )
    .bind(...ids)
    .all<{ run_id: string }>();
  let runs = 0,
    bytes = 0;
  const cleared: string[] = [];
  const expiries = allowed.map((row) => ({
    source,
    run: row.run_id,
    generation: at.slice(0, 10),
    expiry: later(at, contracts.get(row.run_id)!.decision.retention.backup.retention_days * day),
  }));
  await env.PRIVATE_DB.prepare(
    `INSERT INTO personal_daily_export_expiry SELECT json_extract(value,'$.source'),json_extract(value,'$.run'),json_extract(value,'$.generation'),json_extract(value,'$.expiry') FROM json_each(?) WHERE true
     ON CONFLICT(source_id,run_id,generation_day) DO UPDATE SET expires_at=MIN(expires_at,excluded.expires_at)`,
  )
    .bind(stable(expiries))
    .run();
  // Each selected run has a durable expiry job BEFORE any generation object can
  // be written. A crash/retry never loses an orphan's deletion deadline.
  for (const row of allowed) {
    if (Date.now() - started >= 20000) break;
    try {
      const r = await exportDailyHistory(env, source, at, {
        row,
        records: records.results.filter((r) => r.run_id === row.run_id),
      });
      if (r.state === 'exported') {
        runs++;
        bytes += r.bytes!;
      }
      cleared.push(row.run_id);
    } catch {
      failed++;
      await env.PRIVATE_DB.prepare(
        `INSERT INTO personal_daily_export_work(run_id,export_retry_after,failure_code) VALUES (?,?,'export_failed')
         ON CONFLICT(run_id) DO UPDATE SET export_retry_after=excluded.export_retry_after,failure_code=excluded.failure_code`,
      )
        .bind(row.run_id, later(at, 3600000))
        .run();
    }
  }
  if (cleared.length)
    await env.PRIVATE_DB.prepare(
      `INSERT INTO personal_daily_export_work(run_id,export_retry_after) SELECT value,NULL FROM json_each(?) WHERE true
     ON CONFLICT(run_id) DO UPDATE SET export_retry_after=NULL`,
    )
      .bind(stable(cleared))
      .run();
  // Normal capture already published membership. Repair a missing/stale catalog
  // after a partial restore, without pretending a restored ordinal is current.
  const head = await dailyJSON(env.EVIDENCE, dailyRoot(source) + 'catalog.json');
  const max = await env.PRIVATE_DB.prepare(
    'SELECT MAX(ordinal) n FROM personal_daily_runs WHERE source_id=?',
  )
    .bind(source)
    .first<number>('n');
  if (!head || DailyCatalog.parse(head).max_ordinal < (max ?? 0)) {
    await publishDailyCatalog(env, source, rows.results[0].run_id, at);
  } else if (DailyCatalog.parse(head).max_ordinal > (max ?? 0))
    throw new Error('daily_catalog_rollback');
  return { state: runs ? 'exported' : failed ? 'blocked' : 'leased', runs, bytes, failed };
}

type Transport = {
  EVIDENCE: R2Bucket;
  NAS_EXPORT?: R2Bucket;
  NAS_HEALTH?: R2Bucket;
  PERSONAL_EXPORT_PINS?: string;
};
export async function projectDailyExports(
  env: DailyEnv,
  base: Transport,
  pin: NasExportPin,
  source: string,
  at: string,
) {
  await repairDailyExportCatalog(env, source);
  const jobs = await env.PRIVATE_DB.prepare(
    `SELECT r.run_id FROM personal_daily_runs r LEFT JOIN personal_daily_export_work w ON w.run_id=r.run_id
     WHERE r.source_id=? AND r.state='complete' AND r.export_expires_at>? AND
       (w.projected_generation IS NULL OR w.projected_generation<r.exported_at) AND
       (w.projection_retry_after IS NULL OR w.projection_retry_after<=?)
     ORDER BY r.exported_at,r.ordinal LIMIT 4`,
  )
    .bind(source, at, at)
    .all<{ run_id: string }>();
  const ids = jobs.results.map((r) => r.run_id);
  try {
    const result = await syncNasExport(base, pin, source, 'daily', at, ids);
    if (result.projected?.length)
      await env.PRIVATE_DB.prepare(
        `INSERT INTO personal_daily_export_work(run_id,projected_generation,projected_at)
         SELECT r.run_id,json_extract(j.value,'$.generation_at'),? FROM personal_daily_runs r
         JOIN json_each(?) j ON r.run_id=json_extract(j.value,'$.run_id')
         WHERE r.exported_at=json_extract(j.value,'$.generation_at')
         ON CONFLICT(run_id) DO UPDATE SET projected_generation=excluded.projected_generation,projected_at=excluded.projected_at,projection_retry_after=NULL`,
      )
        .bind(at, stable(result.projected))
        .run();
    for (const id of result.failed ?? [])
      await env.PRIVATE_DB.prepare(
        `INSERT INTO personal_daily_export_work(run_id,projection_retry_after,failure_code) VALUES (?,?,'projection_failed')
         ON CONFLICT(run_id) DO UPDATE SET projection_retry_after=excluded.projection_retry_after,failure_code=excluded.failure_code`,
      )
        .bind(id, later(at, 3600000))
        .run();
    return result;
  } catch {
    // Retry a failed group without source HTTP. Backoff stops a damaged old run
    // monopolising all later work; per-run authority is still checked on retry.
    for (const id of ids)
      await env.PRIVATE_DB.prepare(
        `INSERT INTO personal_daily_export_work(run_id,projection_retry_after,failure_code) VALUES (?,?,'projection_failed')
         ON CONFLICT(run_id) DO UPDATE SET projection_retry_after=excluded.projection_retry_after,failure_code=excluded.failure_code`,
      )
        .bind(id, later(at, 3600000))
        .run();
    return { state: 'projection_failed', projected: [], failed: ids };
  }
}

// Catalog pages missing after a partial R2 restore are repaired independently
// of generation age. One fixed page/call, CAS against concurrent acquisition.
export async function repairDailyExportCatalog(env: DailyEnv, source: string) {
  const root = dailyRoot(source),
    raw = await dailyJSON(env.EVIDENCE, root + 'catalog.json');
  if (!raw) return;
  const head = DailyCatalog.parse(raw),
    key = root + 'export-catalog-repair.json';
  const cp = await dailyJSON(env.EVIDENCE, key, 8192);
  const n = head.pages.find((p) => p >= (cp?.next_page ?? 0)) ?? head.pages[0];
  if (n === undefined) return;
  const pageKey = root + 'catalog/' + n + '.json',
    old = await env.EVIDENCE.get(pageKey);
  const rows = await env.PRIVATE_DB.prepare(
    'SELECT ordinal,run_id,state,contract_hash,reason FROM personal_daily_runs WHERE source_id=? AND ordinal>? AND ordinal<=? ORDER BY ordinal',
  )
    .bind(source, n * 32, (n + 1) * 32)
    .all();
  const body = stable(DailyPage.parse(rows.results));
  if (!old || stable(await old.json()) !== body) {
    if (
      !(await env.EVIDENCE.put(pageKey, body, {
        onlyIf: old ? { etagMatches: old.etag } : { etagDoesNotMatch: '*' },
      }))
    )
      throw new Error('daily_catalog_conflict');
  }
  await env.EVIDENCE.put(key, stable({ next_page: n + 1 }));
}

export async function expireDailyExports(env: DailyEnv, out: R2Bucket, source: string, at: string) {
  const jobs = await env.PRIVATE_DB.prepare(
    'SELECT * FROM personal_daily_export_expiry WHERE source_id=? AND expires_at<=? ORDER BY expires_at LIMIT 8',
  )
    .bind(source, at)
    .all<{ run_id: string; generation_day: string }>();
  for (const j of jobs.results) {
    const prefix = dailyRoot(source) + 'exports/' + j.run_id + '/' + j.generation_day + '/';
    // Deterministic <=7 origin / <=4 export keys. Keep tombstones and controls.
    await env.EVIDENCE.delete(
      [
        'snapshot.json',
        'manifest.json',
        'lease.json',
        ...Array.from({ length: 4 }, (_, i) => 'part-' + i + '.json'),
      ].map((k) => prefix + k),
    );
    await out.delete(Array.from({ length: 4 }, (_, i) => prefix + 'part-' + i + '.json'));
  }
  if (jobs.results.length)
    await env.PRIVATE_DB.prepare(
      `DELETE FROM personal_daily_export_expiry WHERE source_id=? AND EXISTS(
      SELECT 1 FROM json_each(?) j WHERE json_extract(j.value,'$.run_id')=personal_daily_export_expiry.run_id AND json_extract(j.value,'$.generation_day')=personal_daily_export_expiry.generation_day)`,
    )
      .bind(source, stable(jobs.results))
      .run();
  return jobs.results.length;
}

export async function dailyExportCapacity(env: DailyEnv, source: string, at: string) {
  const counts = await env.PRIVATE_DB.prepare(
    `SELECT COUNT(*) runs,
     SUM(CASE WHEN r.exported_at IS NULL THEN 1 ELSE 0 END) unexported,
     SUM(CASE WHEN w.projected_generation IS NULL OR w.projected_generation<r.exported_at THEN 1 ELSE 0 END) pending,
     MIN(r.export_expires_at) earliest_expiry,
     MIN(strftime('%Y-%m-%dT%H:%M:%fZ',w.projected_generation,'+'||json_extract(c.contract_json,'$.decision.retention.backup.retention_days')||' days')) earliest_projection_expiry,
     SUM(CASE WHEN w.projected_at>=? THEN 1 ELSE 0 END) projected_7d,
     MIN(CAST(json_extract(c.contract_json,'$.decision.retention.backup.retention_days') AS INTEGER)) generation_days
     FROM personal_daily_runs r JOIN personal_daily_contracts c ON c.contract_hash=r.contract_hash
     LEFT JOIN personal_daily_export_work w ON w.run_id=r.run_id WHERE r.source_id=? AND r.state='complete'`,
  )
    .bind(later(at, -7 * day), source)
    .first<{
      runs: number;
      unexported: number | null;
      pending: number | null;
      earliest_expiry: string | null;
      earliest_projection_expiry: string | null;
      projected_7d: number | null;
      generation_days: number | null;
    }>();
  const statusKey = dailyRoot(source) + 'export-capacity.json';
  const previous = await dailyJSON(env.EVIDENCE, statusKey, 8192);
  const started_at = previous?.started_at ?? at;
  if (started_at > at) throw new Error('daily_capacity_rollback');
  const r = counts!,
    throughput = (r.projected_7d ?? 0) / 7;
  const firstExpiry = [r.earliest_expiry, r.earliest_projection_expiry]
    .filter((s): s is string => s !== null)
    .sort()[0];
  const daysLeft = firstExpiry ? (Date.parse(firstExpiry) - Date.parse(at)) / day : null;
  const scanDays = r.runs ? Math.ceil(r.runs / (DAILY_EXPORT_LIMIT * 16 - 1)) : 0;
  const sufficient = r.generation_days !== null && scanDays + 2 + 7 < r.generation_days;
  const status = !r.runs
    ? 'empty'
    : !sufficient || (daysLeft !== null && daysLeft <= 7)
      ? 'deadline_risk'
      : Date.parse(at) - Date.parse(started_at) >= 7 * day &&
          throughput < r.runs / (r.generation_days! - 9)
        ? 'throughput_warning'
        : r.unexported || r.pending
          ? 'catching_up'
          : 'within_window';
  const value = {
    version: 1,
    source_id: source,
    checked_at: at,
    started_at,
    state: status,
    ...r,
    max_runs_per_invocation: DAILY_EXPORT_LIMIT,
    max_bytes_per_invocation: DAILY_EXPORT_BYTES,
    idle_slots_per_day_upper_bound: 24,
    planning_idle_slots_per_day: 16,
    planning_refresh_days: scanDays,
    nas_inventory_allowance_days: 2,
    outage_allowance_days: 7,
    observed_projected_runs_per_day_7d: throughput,
    planning_window_sufficient: sufficient,
    real_cloud_capacity_verified: false,
    real_nas_capacity_verified: false,
  };
  await env.EVIDENCE.put(statusKey, stable(value));
  return value;
}
