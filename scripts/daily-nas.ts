import { mkdir, readFile, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  DailyCatalog,
  dailyCatalogPage,
  DailyManifest,
  DailyControl,
  DailySnapshot,
  NasReceipt,
  dailyRoot,
  receiptSignature,
  validateDailySnapshot,
  type NasReceiptValue,
} from '../src/research/daily-protocol';
import { hash, stable } from '../src/util';
import { hashBytes } from '../src/research/personal-daily';
import { checkedLocalPath, separatePaths } from './personal-vault';
import { smallFile, durable, atomic, sourceLock } from './personal-nas';
import { openNas, sealNas } from './personal-nas-crypto';
import { personalLocalEnv } from './personal-local-env';
import { NasReadError, type NasReader } from './personal-nas-transport';

export type DailyNasOptions = {
  root: string;
  ageBinary: string;
  recipient: string;
  identityFile: string;
  account_id: string;
  bucket: string;
  store_id: string;
  data_origin: 'synthetic' | 'live';
  now: () => string;
  receiptSecret: string;
  sendReceipt: (envelope: unknown) => Promise<void>;
};
const Entry = z
  .object({
    run_id: z.string().regex(/^[a-f0-9]{64}$/),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    cipher_hash: z.string().regex(/^[a-f0-9]{64}$/),
    contract_hash: z.string().regex(/^[a-f0-9]{64}$/),
    expires_at: z.iso.datetime(),
    observed_at: z.iso.datetime(),
    ordinal: z.number().int().positive(),
  })
  .strict();
const State = z
  .object({
    cursor: z.number().int().min(0),
    ceiling: z.number().int().min(0),
    scan_failed: z.boolean(),
    last_backup_at: z.iso.datetime().nullable(),
    last_restored_at: z.iso.datetime().nullable(),
    last_inventory_at: z.iso.datetime().nullable(),
    latest_observed_at: z.iso.datetime().nullable(),
    retry_at: z.iso.datetime().nullable(),
  })
  .strict();
const initial = () =>
  State.parse({
    cursor: 0,
    ceiling: 0,
    scan_failed: false,
    last_backup_at: null,
    last_restored_at: null,
    last_inventory_at: null,
    latest_observed_at: null,
    retry_at: null,
  });
const json = async (reader: NasReader, key: string) => {
  const b = await reader.get(key);
  return b ? JSON.parse(Buffer.from(b).toString()) : null;
};
async function authority(reader: NasReader, source: string, h: string, at: string, dir: string) {
  const root = dailyRoot(source),
    path = join(dir, 'authority-' + h + '.json'),
    old = await smallFile(path, 8192),
    prior = old ? DailyControl.parse(JSON.parse(old.toString())) : null;
  const revoked =
    !!(await smallFile(join(dir, 'source-denied.json'), 8192)) ||
    !!(await reader.get(root + 'revoked.json')) ||
    !!(await reader.get(
      'personal-research/control/' + source + '/research-control/revocations/' + source + '.json',
    ));
  const input = await json(reader, root + 'authority/' + h + '.json');
  if (revoked) await atomic(join(dir, 'source-denied.json'), stable({ at }));
  if (!input) throw new Error('nas_authority_missing');
  const c = DailyControl.parse(input);
  if (revoked) {
    c.storage = 'denied';
    await atomic(join(dir, 'source-denied.json'), stable({ at }));
  }
  if (
    c.contract_hash !== h ||
    c.reviewed_at > at ||
    (prior &&
      (c.sequence < prior.sequence ||
        (prior.storage === 'denied' && c.storage !== 'denied') ||
        (prior.storage_ends_at &&
          (!c.storage_ends_at || c.storage_ends_at > prior.storage_ends_at))))
  )
    throw new Error('nas_authority_rollback');
  await atomic(path, stable(c));
  if (c.storage !== 'continuing' || (c.storage_ends_at && c.storage_ends_at <= at))
    throw new Error('nas_authority_blocked');
  return c;
}
function scope(s: z.infer<typeof DailySnapshot>, source: string, o: DailyNasOptions) {
  const c = s.contract;
  if (
    c.config.source.source_id !== source ||
    c.cloud.account_id !== o.account_id ||
    c.cloud.bucket !== o.bucket ||
    c.decision.retention.store_id !== o.store_id ||
    c.data_origin !== o.data_origin
  )
    throw new Error('nas_snapshot_scope');
}
async function runAllowed(reader: NasReader, source: string, run: string, dir: string, at: string) {
  const marker = join(dir, 'denied-' + run + '.json');
  if (await reader.get(dailyRoot(source) + 'deleted/' + run + '.json'))
    await atomic(marker, stable({ at }));
  if (await smallFile(marker, 8192)) throw new Error('nas_authority_blocked');
}
async function importRun(db: D1Database, s: z.infer<typeof DailySnapshot>) {
  await validateDailySnapshot(s);
  const previous = await db
    .prepare('SELECT state FROM personal_daily_runs WHERE run_id=?')
    .bind(s.run_id)
    .first<string>('state');
  if (previous === 'complete') return;
  await db
    .prepare('INSERT OR IGNORE INTO personal_daily_contracts VALUES (?,?,?)')
    .bind(s.contract_hash, s.contract.config.source.source_id, stable(s.contract))
    .run();
  await db
    .prepare(
      "INSERT OR IGNORE INTO personal_daily_runs(ordinal,run_id,source_id,day,synthetic,contract_hash,started_at,observed_at,state,record_count,evidence_hash,evidence_expires_at) VALUES (?,?,?,?,?,?,?,?,'partial',?,?,?)",
    )
    .bind(
      s.ordinal,
      s.run_id,
      s.contract.config.source.source_id,
      s.day,
      Number(s.contract.data_origin === 'synthetic'),
      s.contract_hash,
      s.started_at,
      s.observed_at,
      s.records.length,
      s.evidence_hash,
      new Date(
        Date.parse(s.started_at) + s.contract.decision.retention.evidence_days * 86400000,
      ).toISOString(),
    )
    .run();
  for (let i = 0; i < s.records.length; i += 20)
    await db.batch(
      s.records
        .slice(i, i + 20)
        .map((r) =>
          db
            .prepare('INSERT OR IGNORE INTO personal_daily_observations VALUES (?,?,?,?,?,?,?,?,?)')
            .bind(
              r.observation_id,
              r.run_id,
              r.record_key,
              r.record_hash,
              r.observed_at,
              r.recorded_at,
              r.previous_observation_id,
              r.change_kind,
              r.domain_json,
            ),
        ),
    );
  const count = await db
    .prepare('SELECT COUNT(*) n FROM personal_daily_observations WHERE run_id=?')
    .bind(s.run_id)
    .first<number>('n');
  if (count !== s.records.length) throw new Error('nas_restore_count');
  await db
    .prepare("UPDATE personal_daily_runs SET state='complete' WHERE run_id=?")
    .bind(s.run_id)
    .run();
}
async function verifyRun(s: z.infer<typeof DailySnapshot>) {
  const local = await personalLocalEnv(s.contract.decision.retention.store_id);
  try {
    await importRun(local.env.PRIVATE_DB, s);
    if (
      JSON.stringify((await local.env.PRIVATE_DB.prepare('PRAGMA quick_check').all()).results) !==
      '[{"quick_check":"ok"}]'
    )
      throw new Error('nas_restore_integrity');
    if ((await local.env.PRIVATE_DB.prepare('PRAGMA foreign_key_check').all()).results.length)
      throw new Error('nas_restore_fk');
    if (s.records.length) {
      let blocked = false;
      try {
        await local.env.PRIVATE_DB.prepare(
          "UPDATE personal_daily_observations SET domain_json='{}'",
        ).run();
      } catch {
        blocked = true;
      }
      if (!blocked) throw new Error('nas_restore_immutable');
    }
  } finally {
    await local.mf.dispose();
  }
}
async function readCopy(dir: string, e: z.infer<typeof Entry>, o: DailyNasOptions, source: string) {
  const cipher = await smallFile(join(dir, e.run_id + '-' + e.hash + '.age'));
  if (!cipher || (await hashBytes(cipher)) !== e.cipher_hash)
    throw new Error('nas_cipher_integrity');
  const plain = await openNas(o.ageBinary, o.identityFile, cipher);
  if ((await hashBytes(plain)) !== e.hash) throw new Error('nas_snapshot_integrity');
  const s = await validateDailySnapshot(JSON.parse(plain.toString()));
  scope(s, source, o);
  if (s.expires_at <= o.now() || s.run_id !== e.run_id) throw new Error('nas_snapshot_expired');
  return s;
}
async function admit(
  reader: NasReader,
  source: string,
  run: string,
  dir: string,
  o: DailyNasOptions,
  restore: boolean,
) {
  const root = dailyRoot(source),
    m = DailyManifest.parse(await json(reader, root + 'runs/' + run + '.json'));
  if (
    m.source_id !== source ||
    m.run_id !== run ||
    m.created_at > o.now() ||
    m.expires_at <= o.now()
  )
    throw new Error('nas_manifest_scope');
  await authority(reader, source, m.contract_hash, o.now(), dir);
  await runAllowed(reader, source, run, dir, o.now());
  const receiptPath = join(dir, run + '.json'),
    priorBytes = await smallFile(receiptPath, 8192),
    prior = priorBytes ? Entry.parse(JSON.parse(priorBytes.toString())) : null;
  if (prior?.hash === m.snapshot_hash) {
    const retained = await smallFile(join(dir, run + '-' + prior.hash + '.age'));
    if (!retained || (await hashBytes(retained)) !== prior.cipher_hash)
      throw new Error('nas_cipher_integrity');
    if (restore) await verifyRun(await readCopy(dir, prior, o, source));
    return prior;
  }
  const parts = [];
  for (const [i, p] of m.chunks.entries()) {
    if (
      p.key !==
      root + 'exports/' + run + '/' + m.created_at.slice(0, 10) + '/part-' + i + '.json'
    )
      throw new Error('nas_part_scope');
    const bytes = await reader.get(p.key);
    if (!bytes || bytes.length !== p.bytes || (await hashBytes(bytes)) !== p.sha256)
      throw new Error('nas_part_integrity');
    parts.push(bytes);
  }
  const bytes = Buffer.concat(parts);
  if (bytes.length > 524288 || (await hashBytes(bytes)) !== m.snapshot_hash)
    throw new Error('nas_snapshot_integrity');
  const s = await validateDailySnapshot(JSON.parse(bytes.toString()));
  scope(s, source, o);
  if (
    s.expires_at !== m.expires_at ||
    s.created_at !== m.created_at ||
    s.contract_hash !== m.contract_hash
  )
    throw new Error('nas_manifest_scope');
  const cipher = await sealNas(o.ageBinary, o.recipient, bytes),
    path = join(dir, run + '-' + m.snapshot_hash + '.age');
  // Intent gives interrupted ciphertext an expiry; completion remains a separate per-run receipt.
  await atomic(
    path + '.intent',
    stable({ expires_at: s.expires_at, contract_hash: s.contract_hash }),
  );
  if (!(await smallFile(path))) await durable(path, cipher);
  const e = Entry.parse({
    run_id: run,
    hash: m.snapshot_hash,
    cipher_hash: await hashBytes((await smallFile(path)) as Buffer),
    contract_hash: m.contract_hash,
    expires_at: m.expires_at,
    observed_at: s.observed_at,
    ordinal: s.ordinal,
  });
  const decoded = await readCopy(dir, e, o, source);
  if (restore) await verifyRun(decoded);
  await authority(reader, source, m.contract_hash, o.now(), dir);
  await runAllowed(reader, source, run, dir, o.now());
  await atomic(receiptPath, stable(e));
  if (prior && prior.hash !== e.hash) {
    const old = join(dir, run + '-' + prior.hash + '.age');
    if (await smallFile(old)) await unlink(old);
    if (await smallFile(old + '.intent')) await unlink(old + '.intent');
  }
  return e;
}
export async function dailyNasCycle(reader: NasReader, source: string, o: DailyNasOptions) {
  const at = o.now(),
    root = await checkedLocalPath(o.root),
    dir = join(root, source);
  dailyRoot(source);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await checkedLocalPath(dir);
  const unlock = await sourceLock(dir),
    statePath = join(dir, 'daily-state.json');
  let state = initial(),
    status: NasReceiptValue['status'] = 'failed',
    code: NasReceiptValue['code'] = 'backup_failed',
    pending = 0;
  let latestFailed = false;
  try {
    const saved = await smallFile(statePath, 8192);
    if (saved) state = State.parse(JSON.parse(saved.toString()));
    // Always enforce known local deadlines, even if R2 is unavailable.
    let cleaned = 0;
    for (const file of await readdir(dir)) {
      if (cleaned >= 20) break;
      if (!file.endsWith('.age.intent')) continue;
      const intent = JSON.parse((await smallFile(join(dir, file), 8192))!.toString()),
        known = await smallFile(join(dir, 'authority-' + intent.contract_hash + '.json'), 8192),
        control = known ? DailyControl.parse(JSON.parse(known.toString())) : null;
      if (
        intent.expires_at <= at ||
        !!(await smallFile(join(dir, 'denied-' + file.slice(0, 64) + '.json'), 8192)) ||
        !!(await smallFile(join(dir, 'source-denied.json'), 8192)) ||
        control?.storage === 'denied' ||
        (control?.storage_ends_at && control.storage_ends_at <= at)
      ) {
        const path = join(dir, file.slice(0, -7));
        if (await smallFile(path)) await unlink(path);
        await unlink(join(dir, file));
        cleaned++;
      }
    }
    if (state.retry_at && state.retry_at > at) {
      code = 'backup_failed';
      pending = 1;
    } else {
      const raw = await json(reader, dailyRoot(source) + 'catalog.json');
      if (!raw) {
        status = 'empty';
        code = 'none';
      } else {
        const head = DailyCatalog.parse(raw);
        if (head.source_id !== source || head.checked_at > at) throw new Error('nas_catalog_scope');
        if (!state.ceiling) state.ceiling = head.max_ordinal;
        const verify =
          !state.last_restored_at ||
          Date.parse(at) - Date.parse(state.last_restored_at) >= 86400000;
        if (head.latest_run_id) {
          try {
            const latest = await admit(reader, source, head.latest_run_id, dir, o, verify);
            state.last_backup_at = at;
            state.latest_observed_at = latest.observed_at;
            if (verify) state.last_restored_at = at;
          } catch {
            state.scan_failed = true;
            pending++;
            latestFailed = true;
          }
        }
        const page =
          head.pages.find((p) => p >= Math.floor(state.cursor / 32)) ??
          Math.floor(state.ceiling / 32);
        const items = dailyCatalogPage(
          await json(reader, dailyRoot(source) + 'catalog/' + page + '.json'),
          page,
        );
        for (const item of items
          .filter((i) => i.ordinal > state.cursor && i.ordinal <= state.ceiling)
          .slice(0, 19)) {
          if (item.state === 'complete') {
            try {
              const entry = await admit(reader, source, item.run_id, dir, o, false);
              state.last_backup_at = at;
              if (!state.latest_observed_at || entry.observed_at > state.latest_observed_at)
                state.latest_observed_at = entry.observed_at;
            } catch {
              state.scan_failed = true;
              pending++;
            }
          } else if (item.state === 'partial' || item.state === 'purging') {
            state.scan_failed = true;
            pending++;
          } else if (item.state === 'purged') {
            await atomic(join(dir, 'denied-' + item.run_id + '.json'), stable({ at }));
            const old = await smallFile(join(dir, item.run_id + '.json'), 8192);
            if (old) {
              const e = Entry.parse(JSON.parse(old.toString()));
              const p = join(dir, e.run_id + '-' + e.hash + '.age');
              if (await smallFile(p)) await unlink(p);
              await unlink(join(dir, item.run_id + '.json'));
            }
          }
          state.cursor = item.ordinal;
        }
        if (!items.some((i) => i.ordinal > state.cursor && i.ordinal <= state.ceiling))
          state.cursor = (page + 1) * 32;
        if (state.cursor >= state.ceiling) {
          if (state.scan_failed && !pending) pending++;
          if (!state.scan_failed) state.last_inventory_at = at;
          state.cursor = 0;
          state.ceiling = 0;
          state.scan_failed = false;
        }
        if (state.scan_failed && !pending) pending++;
        status = latestFailed ? 'failed' : pending ? 'partial' : 'ok';
        code = pending ? 'inventory_partial' : 'none';
        state.retry_at = null;
      }
    }
  } catch (e) {
    status = 'failed';
    code = 'backup_failed';
    state.retry_at = new Date(
      Date.parse(at) +
        (e instanceof NasReadError && e.retryAfterSeconds ? e.retryAfterSeconds : 300) * 1000,
    ).toISOString();
  } finally {
    try {
      await atomic(statePath, stable(state));
    } finally {
      await unlock();
    }
  }
  const receipt = NasReceipt.parse({
    version: 1,
    source_id: source,
    issued_at: o.now(),
    status,
    code,
    pending,
    last_backup_at: state.last_backup_at,
    last_restored_at: state.last_restored_at,
    last_inventory_at: state.last_inventory_at,
    latest_observed_at: state.latest_observed_at,
  });
  try {
    await o.sendReceipt({ receipt, signature: await receiptSignature(receipt, o.receiptSecret) });
  } catch {
    return { state: 'receipt_failed', receipt };
  }
  return { state: status, receipt };
}

// Resumable full-history restore: discover fixed catalog pages, import <=20 runs,
// then verify <=20 runs per call. No destination is served or promoted automatically.
const RestoreState = z
  .object({
    source: z.string(),
    ceiling: z.number().int().min(0),
    pages: z.array(z.number().int().min(0)).max(8192),
    page: z.number().int().min(0),
    phase: z.enum(['index', 'import', 'verify', 'complete']),
    approval_ref: z.string().min(1),
    count: z.number().int().min(0),
  })
  .strict();
export async function restoreDailyNas(
  reader: NasReader,
  source: string,
  o: DailyNasOptions,
  destination: string,
  approvalRef: string,
) {
  if (!approvalRef.trim()) throw new Error('nas_restore_approval_required');
  const target = await checkedLocalPath(destination),
    root = await checkedLocalPath(o.root);
  separatePaths(target, root);
  const dir = await checkedLocalPath(join(root, source)),
    checkpoint = join(target, 'restore-state.json');
  const existing = await smallFile(checkpoint, 131072);
  let state: z.infer<typeof RestoreState>;
  if (existing) {
    state = RestoreState.parse(JSON.parse(existing.toString()));
    if (state.source !== source || state.approval_ref !== approvalRef)
      throw new Error('nas_restore_scope');
    if (state.phase === 'complete') throw new Error('nas_restore_already_complete');
  } else {
    const head = DailyCatalog.parse(await json(reader, dailyRoot(source) + 'catalog.json'));
    if (head.source_id !== source || head.max_ordinal === 0 || head.checked_at > o.now())
      throw new Error('nas_restore_catalog_required');
    await mkdir(target, { recursive: false, mode: 0o700 });
    state = {
      source,
      ceiling: head.max_ordinal,
      pages: head.pages,
      page: 0,
      phase: 'index',
      approval_ref: approvalRef,
      count: 0,
    };
    await atomic(checkpoint, stable(state));
  }
  const unlock = await sourceLock(target);
  let local: Awaited<ReturnType<typeof personalLocalEnv>> | undefined;
  try {
    local = await personalLocalEnv(o.store_id, 'test', target);
    const db = local.env.PRIVATE_DB;
    await db.exec(
      'CREATE TABLE IF NOT EXISTS nas_restore_queue (run_id TEXT PRIMARY KEY, ordinal INTEGER UNIQUE, snapshot_hash TEXT NOT NULL, imported INTEGER NOT NULL DEFAULT 0, verified INTEGER NOT NULL DEFAULT 0)',
    );
    if (state.phase === 'index') {
      const page = state.pages[state.page];
      if (page !== undefined) {
        const items = dailyCatalogPage(
          await json(reader, dailyRoot(source) + 'catalog/' + page + '.json'),
          page,
        );
        for (const item of items.filter((i) => i.ordinal <= state.ceiling)) {
          if (item.state === 'partial' || item.state === 'purging')
            throw new Error('nas_restore_incomplete_scope');
          if (item.state !== 'complete') continue;
          const raw = await smallFile(join(dir, item.run_id + '.json'), 8192);
          if (!raw) throw new Error('nas_restore_copy_missing');
          const e = Entry.parse(JSON.parse(raw.toString()));
          if (
            e.run_id !== item.run_id ||
            e.ordinal !== item.ordinal ||
            e.contract_hash !== item.contract_hash ||
            e.expires_at <= o.now()
          )
            throw new Error('nas_restore_copy_invalid');
          await db
            .prepare(
              'INSERT OR IGNORE INTO nas_restore_queue(run_id,ordinal,snapshot_hash) VALUES (?,?,?)',
            )
            .bind(e.run_id, e.ordinal, e.hash)
            .run();
        }
        state.page++;
      }
      if (state.page >= state.pages.length) state.phase = 'import';
    } else {
      const column = state.phase === 'import' ? 'imported' : 'verified';
      const batch = await db
        .prepare(
          `SELECT run_id,ordinal,snapshot_hash FROM nas_restore_queue WHERE ${column}=0 ORDER BY ordinal LIMIT 20`,
        )
        .all<{ run_id: string; ordinal: number; snapshot_hash: string }>();
      for (const row of batch.results) {
        const raw = await smallFile(join(dir, row.run_id + '.json'), 8192);
        if (!raw) throw new Error('nas_restore_copy_missing');
        const e = Entry.parse(JSON.parse(raw.toString()));
        if (e.hash !== row.snapshot_hash) throw new Error('nas_restore_copy_changed');
        await authority(reader, source, e.contract_hash, o.now(), dir);
        await runAllowed(reader, source, e.run_id, dir, o.now());
        const s = await readCopy(dir, e, o, source);
        if (state.phase === 'import') await importRun(db, s);
        await authority(reader, source, e.contract_hash, o.now(), dir);
        await runAllowed(reader, source, e.run_id, dir, o.now());
        await db
          .prepare(`UPDATE nas_restore_queue SET ${column}=1 WHERE run_id=?`)
          .bind(e.run_id)
          .run();
      }
      const remaining = await db
        .prepare(`SELECT 1 FROM nas_restore_queue WHERE ${column}=0 LIMIT 1`)
        .first();
      if (!remaining) state.phase = state.phase === 'import' ? 'verify' : 'complete';
    }
    state.count =
      (await db
        .prepare('SELECT COUNT(*) n FROM nas_restore_queue WHERE imported=1')
        .first<number>('n')) ?? 0;
    if (state.phase === 'complete') {
      if (
        !state.count ||
        (await db.prepare('PRAGMA foreign_key_check').all()).results.length ||
        JSON.stringify((await db.prepare('PRAGMA quick_check').all()).results) !==
          '[{"quick_check":"ok"}]'
      )
        throw new Error('nas_restore_integrity');
      if (
        (await reader.get(dailyRoot(source) + 'revoked.json')) ||
        (await smallFile(join(dir, 'source-denied.json'), 8192))
      )
        throw new Error('nas_authority_blocked');
      await atomic(
        join(target, 'restore-complete.json'),
        stable({ ...state, completed_at: o.now(), remote_writes: false }),
      );
    }
    await atomic(checkpoint, stable(state));
    return {
      state: state.phase === 'complete' ? 'complete' : 'partial',
      phase: state.phase,
      runs: state.count,
    };
  } finally {
    try {
      await local?.mf.dispose();
    } finally {
      await unlock();
    }
  }
}
