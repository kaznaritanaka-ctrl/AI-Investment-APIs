import { afterEach, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { exportMemory, seedExportHistory, exportedSnapshot, scaleAt } from './daily-export-fixture';
import {
  refreshDailyExports,
  projectDailyExports,
  expireDailyExports,
  dailyExportCapacity,
  repairDailyExportCatalog,
  DAILY_EXPORT_BYTES,
} from '../src/research/daily-export';
import { dailyRoot, DailyCatalog, DailyManifest } from '../src/research/daily-protocol';
import { dailyInventoryPage, dailyInventorySlice } from '../src/research/daily-inventory';
import { exportGateKey, checkExportGate } from '../src/research/nas-export-protocol';
import { importDailySnapshot } from '../scripts/daily-nas';
import { syncNasExport } from '../src/research/nas-export';
import { stable } from '../src/util';

let fixtures: ReturnType<typeof exportMemory>[] = [];
const local = (n = 16) => {
  const m = exportMemory(n);
  fixtures.push(m);
  return m;
};
afterEach(() => {
  for (const m of fixtures) m.close();
  fixtures = [];
  vi.unstubAllGlobals();
});

it('keeps the new ten-file review non-executable and prior packets immutable, without enabling any production resource', () => {
  const dir = 'docs/personal-execution-20261018/',
    review = JSON.parse(readFileSync(dir + 'pr19-daily-export-review-20261021.json', 'utf8'));
  const digest = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
  expect(review.executable).toBe(false);
  expect(review.production_ready).toBe(false);
  expect(review.migration_approval_ref).toBeNull();
  expect(review.deploy_approval_ref).toBeNull();
  expect(review.daily_enablement.approval_ref).toBeNull();
  expect(review.production_mutations).toBe(false);
  expect(review.migrations).toHaveLength(10);
  for (const item of [...review.migrations, review.prior_review, review.historical_packet])
    expect(digest(item.file)).toBe(item.sha256);
  const c = JSON.parse(readFileSync('wrangler.collector.jsonc', 'utf8'));
  for (const flag of [
    'PERSONAL_MAINTENANCE_ENABLED',
    'PERSONAL_INITIAL_COLLECTION_ENABLED',
    'PERSONAL_DAILY_MAINTENANCE_ENABLED',
    'PERSONAL_DAILY_COLLECTION_ENABLED',
  ])
    expect(c.vars[flag]).toBeUndefined();
  expect(c.r2_buckets.some((b: any) => b.binding === 'NAS_EXPORT')).toBe(false);
});

it('forward 0016 preserves populated 0015 history, hashes, finite deadlines and immutable protections', async () => {
  const m = local(15);
  await seedExportHistory(m, 'rebro_public', 3);
  const tables = [
    'personal_daily_runs',
    'personal_daily_observations',
    'personal_daily_contracts',
    'personal_daily_coverage',
  ];
  const read = () =>
    tables.map((t) => m.sqlite.prepare('SELECT * FROM ' + t + ' ORDER BY rowid').all());
  const before = read();
  m.sqlite.exec(readFileSync('migrations/private/0016_daily_export_work.sql', 'utf8'));
  expect(read()).toEqual(before);
  expect(m.sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  expect(() => m.sqlite.exec("UPDATE personal_daily_observations SET domain_json='{}'")).toThrow(
    'immutable',
  );
  expect(() => m.sqlite.exec('DELETE FROM personal_daily_coverage')).toThrow('retention');
});

it('bounds generation and delivery, retries partial writes without HTTP, and isolates one corrupt run', async () => {
  const m = local(),
    f = await seedExportHistory(m, 'rebro_public', 9),
    at = scaleAt(10);
  const network = vi.fn(() => {
    throw new Error('live forbidden');
  });
  vi.stubGlobal('fetch', network);
  const before = m.sqlite.prepare('SELECT * FROM personal_daily_observations').all();
  const first = await refreshDailyExports(m.env, 'rebro_public', at);
  expect(first).toMatchObject({ runs: 4, failed: 0 });
  expect(first.bytes).toBeLessThanOrEqual(DAILY_EXPORT_BYTES);
  let broke = false;
  m.out.fault = (op, key) => {
    if (!broke && op === 'put' && key.includes('/part-')) {
      broke = true;
      throw new Error('SYNTHETIC partial PUT');
    }
  };
  const partial = await projectDailyExports(m.env, m.base, m.pin, 'rebro_public', at);
  expect(partial.projected).toHaveLength(3);
  expect(
    m.sqlite
      .prepare(
        'SELECT COUNT(*) n FROM personal_daily_export_work WHERE projected_generation IS NOT NULL',
      )
      .get()!.n,
  ).toBe(3);
  m.out.fault = undefined;
  // A durable backoff and checkpoint survive a fresh caller/process. Already
  // projected generations are not sent again merely to finish a control sweep.
  for (let i = 0; i < 8; i++) {
    const next = new Date(Date.parse(at) + (i + 1) * 900000).toISOString();
    await refreshDailyExports(m.env, 'rebro_public', next);
    await projectDailyExports(m.env, m.base, m.pin, 'rebro_public', next);
  }
  expect(
    m.sqlite
      .prepare(
        'SELECT COUNT(*) n FROM personal_daily_export_work WHERE projected_generation IS NOT NULL',
      )
      .get()!.n,
  ).toBe(9);
  for (const id of f.ids)
    expect((await exportedSnapshot(m.out, 'rebro_public', id)).snapshot.records).toHaveLength(1);
  expect(m.sqlite.prepare('SELECT * FROM personal_daily_observations').all()).toEqual(before);
  expect(network).not.toHaveBeenCalled();
  // A missing old catalog page is repaired even when no generation is due.
  await m.origin.delete(dailyRoot('rebro_public') + 'catalog/0.json');
  await repairDailyExportCatalog(m.env, 'rebro_public');
  expect(await m.origin.json(dailyRoot('rebro_public') + 'catalog/0.json')).toHaveLength(9);
  const cap = await dailyExportCapacity(m.env, 'rebro_public', at);
  expect(cap.real_cloud_capacity_verified).toBe(false);
});

it('current revocation, finite storage and expiry fail closed; expiry DELETE failure remains queued', async () => {
  const m = local(),
    f = await seedExportHistory(m, 'rebro_public', 4),
    source = 'rebro_public',
    at = scaleAt(5);
  await refreshDailyExports(m.env, source, at);
  await projectDailyExports(m.env, m.base, m.pin, source, at);
  const controlKey = dailyRoot(source) + 'authority/' + f.h + '.json',
    control = await m.origin.json(controlKey);
  await m.origin.put(controlKey, stable({ ...control, sequence: 1, storage_ends_at: at }));
  const failed = await projectDailyExports(m.env, m.base, m.pin, source, scaleAt(6));
  // Already copied is not a NAS receipt; a fresh gate must project current controls.
  expect(failed.state).not.toBe('projection_failed');
  const blocked = await refreshDailyExports(m.env, source, scaleAt(40));
  expect(blocked).toMatchObject({ runs: 0, failed: 4 });
  expect((await dailyExportCapacity(m.env, source, scaleAt(94))).state).toBe('deadline_risk');
  m.out.fault = (op) => {
    if (op === 'delete') throw new Error('SYNTHETIC DELETE failed');
  };
  await expect(expireDailyExports(m.env, m.base.NAS_EXPORT, source, scaleAt(96))).rejects.toThrow(
    'DELETE',
  );
  expect(
    m.sqlite.prepare('SELECT COUNT(*) n FROM personal_daily_export_expiry').get()!.n,
  ).toBeGreaterThan(0);
  m.out.fault = undefined;
  while (await expireDailyExports(m.env, m.base.NAS_EXPORT, source, scaleAt(140))) {}
  expect(m.sqlite.prepare('SELECT COUNT(*) n FROM personal_daily_observations').get()!.n).toBe(4);
  expect(await m.origin.json(controlKey)).toEqual({ ...control, sequence: 1, storage_ends_at: at });
  expect(m.origin.maxDelete).toBeLessThanOrEqual(7);
  expect(m.out.maxDelete).toBeLessThanOrEqual(4);
});

it('retains short legacy generation deadlines and refreshes them early; sustained under-capacity is a warning', async () => {
  const m = local(),
    f = await seedExportHistory(m, 'rebro_public', 1, 0, 7),
    source = 'rebro_public';
  await refreshDailyExports(m.env, source, scaleAt(2));
  const old = await exportedSnapshot(m.origin, source, f.ids[0]);
  expect(old.manifest.expires_at).toBe(scaleAt(9));
  await refreshDailyExports(m.env, source, scaleAt(5));
  const next = await exportedSnapshot(m.origin, source, f.ids[0]);
  expect(next.manifest.expires_at).toBe(scaleAt(12));
  expect(
    await m.origin.json(
      dailyRoot(source) + 'exports/' + f.ids[0] + '/' + scaleAt(2).slice(0, 10) + '/snapshot.json',
    ),
  ).toEqual(old.snapshot);
  const other = local();
  await seedExportHistory(other, source, 5);
  expect((await dailyExportCapacity(other.env, source, scaleAt(6))).state).toBe('catching_up');
  expect((await dailyExportCapacity(other.env, source, scaleAt(14))).state).toBe(
    'throughput_warning',
  );
});

it('a corrupt part holds only that run; source cancellation still propagates and oversized batches are rejected', async () => {
  const m = local(),
    source = 'rebro_public',
    f = await seedExportHistory(m, source, 4),
    at = scaleAt(5);
  await refreshDailyExports(m.env, source, at);
  const manifest = DailyManifest.parse(
    await m.origin.json(dailyRoot(source) + 'runs/' + f.ids[0] + '.json'),
  );
  const key = manifest.chunks[0].key,
    saved = m.origin.objects.get(key)!;
  await m.origin.put(key, 'corrupt synthetic bytes');
  const result = await projectDailyExports(m.env, m.base, m.pin, source, at);
  expect(result.projected).toHaveLength(3);
  expect(result.failed).toEqual([f.ids[0]]);
  await m.origin.put(key, saved.body, { customMetadata: saved.customMetadata });
  for (let i = 1; i <= 5; i++)
    await projectDailyExports(
      m.env,
      m.base,
      m.pin,
      source,
      new Date(Date.parse(at) + i * 900000).toISOString(),
    );
  expect((await exportedSnapshot(m.out, source, f.ids[0])).manifest.snapshot_hash).toBe(
    manifest.snapshot_hash,
  );
  await expect(
    syncNasExport(m.base, m.pin, source, 'daily', at, [...f.ids, f.ids[0]]),
  ).rejects.toThrow('batch_scope');
  await m.origin.put(dailyRoot(source) + 'revoked.json', stable({ denied: true }));
  const later = scaleAt(6);
  await projectDailyExports(m.env, m.base, m.pin, source, later);
  expect(await m.out.json(dailyRoot(source) + 'revoked.json')).toEqual({ denied: true });
  const sql = vi.spyOn(m.env.PRIVATE_DB, 'prepare');
  expect((await refreshDailyExports(m.env, source, scaleAt(40))).runs).toBe(0);
  expect(sql.mock.calls.some(([q]) => q.includes('FROM personal_daily_observations'))).toBe(false);
});

it('refreshes and projects two 3,660-run histories inside 90 days with lost slots, outage, new arrivals and restart; shared NAS inventory and full import', async () => {
  const m = local(),
    sources = ['highreso_public', 'rebro_public'] as const;
  const all = new Map<string, string[]>();
  for (const source of sources) all.set(source, (await seedExportHistory(m, source, 3660)).ids);
  // Fresh Worker invocations use only durable DB/R2 checkpoints. No source GET,
  // real key, real NAS or Cloudflare API occurs in this scale simulation.
  const network = vi.fn(() => {
    throw new Error('live forbidden');
  });
  vi.stubGlobal('fetch', network);
  const initialHash = stable(
    m.sqlite.prepare('SELECT * FROM personal_daily_observations ORDER BY observation_id').all(),
  );
  const copies = new Map<string, Awaited<ReturnType<typeof exportedSnapshot>>>();
  const inv = new Map(
    sources.map((s) => [s, { cursor: 0, ceiling: 0, failed: false, fullAt: -1 }]),
  );
  let firstFull = -1,
    maxGap = 0,
    totalExports = 0,
    totalProjected = 0,
    maxQueries = 0,
    maxR2Calls = 0,
    totalBytes = 0;
  const last = new Map<string, number>();
  for (let d = 0; d < 120; d++) {
    // Four-day complete outage plus 8 of the 24 daily maintenance slots lost
    // every other day to higher-priority production source work.
    if (d >= 25 && d < 29) continue;
    if (d > 0)
      for (const source of sources) {
        const f = await seedExportHistory(m, source, 1, 3659 + d);
        all.get(source)!.push(...f.ids);
      }
    for (let slot = 0; slot < 16; slot++) {
      const at = new Date(Date.parse(scaleAt(3660 + d)) + slot * 900000).toISOString();
      for (const source of sources) {
        const q = m.metrics.queries,
          io = m.origin.calls + m.out.calls;
        const r = await refreshDailyExports(m.env, source, at);
        totalExports += r.runs;
        totalBytes += r.bytes;
        expect(r.runs).toBeLessThanOrEqual(4);
        expect(r.bytes).toBeLessThanOrEqual(DAILY_EXPORT_BYTES);
        expect(r.failed).toBe(0);
        const p = await projectDailyExports(m.env, m.base, m.pin, source, at);
        totalProjected += p.projected?.length ?? 0;
        expect(p.projected?.length ?? 0).toBeLessThanOrEqual(4);
        expect(p.failed ?? []).toEqual([]);
        for (const item of p.projected ?? []) {
          const prior = last.get(item.run_id);
          if (prior !== undefined) maxGap = Math.max(maxGap, (Date.parse(at) - prior) / 86400000);
          last.set(item.run_id, Date.parse(at));
        }
        await expireDailyExports(m.env, m.base.NAS_EXPORT, source, at);
        maxQueries = Math.max(maxQueries, m.metrics.queries - q);
        maxR2Calls = Math.max(maxR2Calls, m.origin.calls + m.out.calls - io);
      }
    }
    // Five-minute NAS cadence over the remaining day. This exercises the exact
    // production inventory cursor, snapshot bytes/hashes/schema and import path.
    // Encryption/process custody is separately tested with real age on small runs.
    for (let poll = 0; poll < 288; poll++)
      for (const source of sources) {
        const at = new Date(Date.parse(scaleAt(3660 + d)) + poll * 300000).toISOString();
        const gate = await m.out.json(exportGateKey(source, 'daily'));
        if (
          !gate ||
          !gate.ready ||
          gate.checked_at > at ||
          Date.parse(at) - Date.parse(gate.checked_at) >= 48 * 3600000
        )
          continue;
        const head = DailyCatalog.parse(await m.out.json(dailyRoot(source) + 'catalog.json')),
          state = inv.get(source)!;
        // Match the production NAS: new/latest is admitted before historical
        // inventory, whose frozen ceiling intentionally excludes new appends.
        if (head.latest_run_id) {
          const latest = await m.out.json(
            dailyRoot(source) + 'runs/' + head.latest_run_id + '.json',
          );
          if (!latest || latest.expires_at <= at) state.failed = true;
          else if (copies.get(head.latest_run_id)?.manifest.snapshot_hash !== latest.snapshot_hash)
            copies.set(
              head.latest_run_id,
              await exportedSnapshot(m.out, source, head.latest_run_id),
            );
        }
        if (!state.ceiling) state.ceiling = head.max_ordinal;
        const page = dailyInventoryPage(head, state.cursor, state.ceiling),
          raw = await m.out.json(dailyRoot(source) + 'catalog/' + page + '.json');
        if (!raw) {
          state.failed = true;
          continue;
        }
        const slice = dailyInventorySlice(raw, page, state.cursor, state.ceiling);
        for (const item of slice.items) {
          const rawManifest = await m.out.json(dailyRoot(source) + 'runs/' + item.run_id + '.json');
          if (!rawManifest) {
            state.failed = true;
            continue;
          }
          const manifest = DailyManifest.parse(rawManifest);
          if (manifest.expires_at <= at) {
            state.failed = true;
            continue;
          }
          if (copies.get(item.run_id)?.manifest.snapshot_hash !== manifest.snapshot_hash)
            copies.set(item.run_id, await exportedSnapshot(m.out, source, item.run_id));
        }
        state.cursor = slice.cursor;
        if (state.cursor >= state.ceiling) {
          if (!state.failed) state.fullAt = d;
          state.cursor = 0;
          state.ceiling = 0;
          state.failed = false;
        }
      }
    if (
      firstFull < 0 &&
      sources.every((s) => inv.get(s)!.fullAt >= 0) &&
      [...all.values()].flat().every((id) => copies.has(id))
    )
      firstFull = d;
    if (firstFull >= 0)
      for (const c of copies.values()) expect(c.manifest.expires_at > scaleAt(3660 + d)).toBe(true);
  }
  expect(firstFull).toBeGreaterThan(0);
  expect(firstFull).toBeLessThan(75);
  expect(maxGap).toBeLessThan(80);
  expect(totalExports).toBeGreaterThan(14640);
  expect(totalProjected).toBeGreaterThan(14640);
  expect(copies.size).toBe([...all.values()].flat().length);
  // Initial data never rewritten. New synthetic arrivals are excluded here.
  const initialIds = [...all.values()]
    .flat()
    .filter(
      (id) =>
        String(
          m.sqlite.prepare('SELECT day FROM personal_daily_runs WHERE run_id=?').get(id)!.day,
        ) < scaleAt(3660).slice(0, 10),
    );
  expect(
    stable(
      m.sqlite
        .prepare(
          'SELECT * FROM personal_daily_observations WHERE observed_at<? ORDER BY observation_id',
        )
        .all(scaleAt(3660)),
    ),
  ).toBe(initialHash);
  expect(initialIds).toHaveLength(7320);
  const restored = local();
  for (const value of [...copies.values()].sort((a, b) => a.snapshot.ordinal - b.snapshot.ordinal))
    await importDailySnapshot(restored.env.PRIVATE_DB, value.snapshot);
  expect(restored.sqlite.prepare('SELECT COUNT(*) n FROM personal_daily_runs').get()!.n).toBe(
    copies.size,
  );
  expect(restored.sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  expect(restored.sqlite.prepare('PRAGMA quick_check').get()!.quick_check).toBe('ok');
  expect(
    stable(
      restored.sqlite
        .prepare('SELECT * FROM personal_daily_observations ORDER BY observation_id')
        .all(),
    ),
  ).toBe(
    stable(
      m.sqlite.prepare('SELECT * FROM personal_daily_observations ORDER BY observation_id').all(),
    ),
  );
  for (const source of sources) {
    const cap = await dailyExportCapacity(m.env, source, scaleAt(3780));
    expect(cap.planning_window_sufficient).toBe(true);
    await checkExportGate(
      await m.out.json(exportGateKey(source, 'daily')),
      m.pin,
      source,
      'daily',
      scaleAt(3780),
    );
  }
  expect(network).not.toHaveBeenCalled();
  expect(m.origin.maxPut).toBeLessThanOrEqual(524288);
  expect(m.out.maxPut).toBeLessThanOrEqual(131072);
  console.log(
    'SYNTHETIC daily export capacity:',
    JSON.stringify({
      initial_runs: 7320,
      final_runs: copies.size,
      days: 120,
      idle_daily_slots: 16,
      complete_outage_days: 4,
      first_full_backup_day: firstFull,
      max_generation_gap_days: maxGap,
      exports: totalExports,
      projected: totalProjected,
      max_sql_queries_per_source_slot: maxQueries,
      max_r2_calls_per_source_slot: maxR2Calls,
      snapshot_bytes_generated: totalBytes,
      full_import_runs: copies.size,
      real_cloud_cpu: false,
      real_nas_crypto_scale: false,
    }),
  );
}, 360000);
