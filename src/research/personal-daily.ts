import { z } from 'zod';
import { PersonalDailySchema, type PersonalDailyContract } from './personal-contract';
import { hash, stable, errorCode } from '../util';
import { FetchFailure } from '../network';
import { parsePublicGpu, PublicGpuPageSchema } from './public-gpu-html';
import { readReviewedPublicGpu, gpuReviewErrors } from './public-gpu-network';
import {
  DailyControl,
  DailySnapshot,
  DailyManifest,
  DailyCatalog,
  DailyPage,
  dailyRoot,
  dailyRunId,
  verifyReceipt,
  validateDailySnapshot,
} from './daily-protocol';
import type { PersonalOptions } from './personal';
import type { CloudPersonalBinding } from './personal-cloud-authority';
import { indexDailySeries } from './daily-series';
import {
  DailyCapture,
  hasDailyCapture,
  loadDailyCapture,
  saveDailyCapture,
  dailyPlan,
} from './daily-checkpoint';

export type DailyEnv = {
  PRIVATE_DB: D1Database;
  EVIDENCE: R2Bucket;
  NAS_HEALTH?: R2Bucket;
  NAS_RECEIPT_SECRET?: string;
  ENVIRONMENT: 'test' | 'production' | 'development';
};
export type DailyRun = {
  ordinal: number;
  run_id: string;
  source_id: string;
  day: string;
  synthetic: number;
  contract_hash: string;
  started_at: string;
  observed_at: string | null;
  state: string;
  record_count: number | null;
  evidence_hash: string | null;
  evidence_expires_at: string;
  reason: string | null;
  lease_token: string | null;
  lease_until: string | null;
  exported_at: string | null;
  export_expires_at: string | null;
};
const clock = (env: DailyEnv, opt: PersonalOptions) => {
  if (env.ENVIRONMENT !== 'test' && (opt.fetcher || opt.now))
    throw new Error('daily_synthetic_boundary');
  return opt.now ?? (() => new Date().toISOString());
};
export async function dailyJSON(bucket: R2Bucket, key: string, max = 131072) {
  const o = await bucket.get(key);
  if (!o) return null;
  if (o.size > max) throw new Error('daily_object_size');
  return JSON.parse(await o.text());
}
export async function inspectDaily(
  env: DailyEnv,
  input: unknown,
  pin: CloudPersonalBinding,
  at: string,
) {
  const c = PersonalDailySchema.parse(input),
    h = await hash(stable(c));
  if (
    'PUBLIC_DB' in env ||
    env.ENVIRONMENT === 'development' ||
    (env.ENVIRONMENT === 'test') !== (c.data_origin === 'synthetic')
  )
    throw new Error('daily_boundary');
  if (
    h !== pin.contract_hash ||
    c.cloud.account_id !== pin.account_id ||
    c.cloud.private_database_id !== pin.private_database_id ||
    c.cloud.bucket !== pin.bucket ||
    (await hash(stable(c.config))) !== c.config_sha256 ||
    at < c.decision.approved_at
  )
    throw new Error('daily_scope');
  return { c, h };
}
export async function dailyAuthority(
  env: DailyEnv,
  c: PersonalDailyContract,
  h: string,
  at: string,
  collect = false,
) {
  const root = dailyRoot(c.config.source.source_id);
  if (
    (await env.EVIDENCE.head(root + 'revoked.json')) ||
    (await env.EVIDENCE.head(
      'personal-research/control/' +
        c.config.source.source_id +
        '/research-control/revocations/' +
        c.config.source.source_id +
        '.json',
    ))
  )
    throw new Error('daily_revoked');
  const control = DailyControl.parse(
    await dailyJSON(env.EVIDENCE, root + 'authority/' + h + '.json'),
  );
  if (
    control.contract_hash !== h ||
    control.reviewed_at > at ||
    control.storage !== 'continuing' ||
    (control.storage_ends_at && control.storage_ends_at <= at)
  )
    throw new Error('daily_storage_blocked');
  if (
    collect &&
    (control.collection_stopped ||
      at >= control.review_after ||
      at >= control.analysis_until ||
      at < c.decision.acquisition_from ||
      at >= c.decision.acquisition_until)
  )
    throw new Error('daily_collection_blocked');
  return control;
}
export async function registerDaily(
  env: DailyEnv,
  input: unknown,
  pin: CloudPersonalBinding,
  at: string,
) {
  const { c, h } = await inspectDaily(env, input, pin, at);
  const existing = await env.PRIVATE_DB.prepare(
    'SELECT contract_json FROM personal_daily_contracts WHERE contract_hash=?',
  )
    .bind(h)
    .first<string>('contract_json');
  if (!existing) {
    await env.EVIDENCE.put(
      dailyRoot(c.config.source.source_id) + 'authority/' + h + '.json',
      stable(
        DailyControl.parse({
          version: 1,
          contract_hash: h,
          sequence: 0,
          reviewed_at: c.decision.approved_at,
          storage: 'continuing',
          storage_ends_at: null,
          collection_stopped: false,
          review_after: c.decision.terms.review_after,
          analysis_until: c.decision.analysis_until,
          approval_ref: c.daily.approval_ref,
        }),
      ),
      { onlyIf: { etagDoesNotMatch: '*' } },
    );
    await env.PRIVATE_DB.prepare('INSERT OR IGNORE INTO personal_daily_contracts VALUES (?,?,?)')
      .bind(h, c.config.source.source_id, stable(c))
      .run();
  } else if (existing !== stable(c)) throw new Error('daily_contract_conflict');
  return { c, h };
}
export async function dailyMonitor(env: DailyEnv, c: PersonalDailyContract, at: string) {
  const source = c.config.source.source_id;
  let state = 'unknown',
    receipt = null;
  try {
    if (!env.NAS_HEALTH || !env.NAS_RECEIPT_SECRET) throw new Error('daily_monitor_unconfigured');
    receipt = await verifyReceipt(
      await dailyJSON(env.NAS_HEALTH, 'daily/receipts/' + source + '.json', 8192),
      env.NAS_RECEIPT_SECRET,
      at,
    );
    if (receipt.source_id !== source) throw new Error('daily_receipt_scope');
    const previous = await env.PRIVATE_DB.prepare(
      'SELECT receipt_at,receipt_hash FROM personal_daily_monitor WHERE source_id=?',
    )
      .bind(source)
      .first<{ receipt_at: string | null; receipt_hash: string | null }>();
    const rh = await hash(stable(receipt));
    if (
      previous?.receipt_at &&
      (receipt.issued_at < previous.receipt_at ||
        (receipt.issued_at === previous.receipt_at && rh !== previous.receipt_hash))
    )
      throw new Error('daily_receipt_replay');
    const fresh = (s: string | null, hours: number) =>
      s !== null && Date.parse(at) - Date.parse(s) <= hours * 3600000;
    const lastObserved = await env.PRIVATE_DB.prepare(
      "SELECT MAX(observed_at) at FROM personal_daily_runs WHERE source_id=? AND state='complete'",
    )
      .bind(source)
      .first<string | null>('at');
    const bootstrap =
      at <
        new Date(
          Date.parse(c.decision.approved_at) + c.daily.bootstrap_hours * 3600000,
        ).toISOString() &&
      !(await env.PRIVATE_DB.prepare(
        "SELECT 1 FROM personal_daily_runs WHERE source_id=? AND state='complete' LIMIT 1",
      )
        .bind(source)
        .first());
    state = !fresh(receipt.issued_at, c.daily.heartbeat_max_hours)
      ? 'stale'
      : receipt.status === 'empty' && bootstrap
        ? 'bootstrap'
        : receipt.status === 'ok' &&
            receipt.pending === 0 &&
            fresh(receipt.last_backup_at, c.daily.backup_max_hours) &&
            fresh(receipt.last_restored_at, c.daily.backup_max_hours) &&
            (!lastObserved ||
              (receipt.latest_observed_at !== null &&
                receipt.latest_observed_at >= lastObserved)) &&
            fresh(receipt.last_inventory_at, c.daily.inventory_max_days * 24)
          ? 'healthy'
          : 'warning';
    await env.PRIVATE_DB.prepare(
      'INSERT INTO personal_daily_monitor VALUES (?,?,?,?,?,?) ON CONFLICT(source_id) DO UPDATE SET receipt_at=excluded.receipt_at,receipt_hash=excluded.receipt_hash,state=excluded.state,checked_at=excluded.checked_at,details_json=excluded.details_json',
    )
      .bind(source, receipt.issued_at, rh, state, at, stable(receipt))
      .run();
  } catch {
    state = 'unknown';
    receipt = null;
    await env.PRIVATE_DB.prepare(
      "INSERT INTO personal_daily_monitor VALUES (?,NULL,NULL,'unknown',?,'{}') ON CONFLICT(source_id) DO UPDATE SET state='unknown',checked_at=excluded.checked_at",
    )
      .bind(source, at)
      .run();
  }
  return { state, receipt, collection_allowed: state === 'healthy' || state === 'bootstrap' };
}
export async function collectDaily(
  env: DailyEnv,
  input: unknown,
  pin: CloudPersonalBinding,
  opt: PersonalOptions = {},
  resumeDay?: string,
) {
  const now = clock(env, opt),
    at = now(),
    { c, h } = await registerDaily(env, input, pin, at),
    source = c.config.source.source_id,
    root = dailyRoot(source);
  if (!(await indexDailySeries(env.PRIVATE_DB, source))) return { state: 'series_index_pending' };
  const catalog = await dailyJSON(env.EVIDENCE, root + 'catalog.json');
  const localMax = await env.PRIVATE_DB.prepare(
    'SELECT MAX(ordinal) n FROM personal_daily_runs WHERE source_id=?',
  )
    .bind(source)
    .first<number | null>('n');
  if (catalog && (localMax ?? 0) < DailyCatalog.parse(catalog).max_ordinal)
    throw new Error('daily_database_rollback');
  await dailyAuthority(env, c, h, at, true);
  if (!opt.allow_network || (env.ENVIRONMENT === 'test' && !opt.fetcher))
    throw new Error('daily_network_opt_in');
  if (!resumeDay && !(await dailyMonitor(env, c, at)).collection_allowed)
    return { state: 'nas_hold' };
  const day = resumeDay ?? at.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day > at.slice(0, 10))
    throw new Error('daily_slot_invalid');
  if (
    !resumeDay &&
    (await env.PRIVATE_DB.prepare(
      "SELECT 1 FROM personal_daily_runs WHERE source_id=? AND synthetic=? AND state='partial' AND day<? AND evidence_expires_at>? LIMIT 1",
    )
      .bind(source, Number(c.data_origin === 'synthetic'), day, at)
      .first())
  )
    return { state: 'prior_partial_hold' };
  if (!resumeDay && Number(at.slice(11, 13)) < c.daily.collection_hour) return { state: 'not_due' };
  const stopped = await dailyJSON(env.EVIDENCE, root + 'stop.json', 8192);
  if (stopped && (stopped.review_required || !stopped.retry_at || stopped.retry_at > at))
    throw new Error('daily_source_stopped');
  const run = await dailyRunId(source, day, c.data_origin),
    slot = root + 'slots/' + day + '.json';
  // Source/day reservation survives DB restoration and contract renewal. Never backfill HTTP.
  if (resumeDay && !(await hasDailyCapture(env.EVIDENCE, root, run)))
    throw new Error('daily_saved_projection_required');
  const claimed = resumeDay
    ? null
    : await env.EVIDENCE.put(slot, stable({ contract_hash: h, run_id: run, started_at: at }), {
        onlyIf: { etagDoesNotMatch: '*' },
      });
  const anchor = z
    .object({ contract_hash: z.string(), run_id: z.string(), started_at: z.string() })
    .strict()
    .parse(await dailyJSON(env.EVIDENCE, slot, 8192));
  if (anchor.contract_hash !== h || anchor.run_id !== run) throw new Error('daily_slot_consumed');
  // A losing invocation cannot acquire a DB lease and poison the winning request.
  if (!claimed && !(await hasDailyCapture(env.EVIDENCE, root, run))) {
    const done = await env.PRIVATE_DB.prepare(
      "SELECT 1 FROM personal_daily_runs WHERE run_id=? AND state='complete'",
    )
      .bind(run)
      .first();
    return { state: done ? 'complete' : 'attempt_consumed_or_in_progress', reused: true };
  }
  const expires = new Date(
    Date.parse(anchor.started_at) + c.decision.retention.evidence_days * 86400000,
  ).toISOString();
  await env.PRIVATE_DB.prepare(
    "INSERT OR IGNORE INTO personal_daily_runs(run_id,source_id,day,synthetic,contract_hash,started_at,state,evidence_expires_at) SELECT ?,?,?,?,?,?,'partial',? WHERE NOT EXISTS(SELECT 1 FROM personal_daily_runs WHERE run_id=?)",
  )
    .bind(
      run,
      source,
      day,
      Number(c.data_origin === 'synthetic'),
      h,
      anchor.started_at,
      expires,
      run,
    )
    .run();
  const row = await env.PRIVATE_DB.prepare('SELECT * FROM personal_daily_runs WHERE run_id=?')
    .bind(run)
    .first<DailyRun>();
  if (row?.state === 'complete') {
    await publishDailyCatalog(env, source, run, at);
    return { state: 'complete', reused: true };
  }
  const token = crypto.randomUUID();
  const lock = await env.PRIVATE_DB.prepare(
    "UPDATE personal_daily_runs SET lease_token=?,lease_until=? WHERE run_id=? AND state='partial' AND (lease_until IS NULL OR lease_until<=?)",
  )
    .bind(token, new Date(Date.parse(at) + 300000).toISOString(), run, at)
    .run();
  if (!lock.meta.changes) return { state: 'leased_or_failed' };
  const guard = async () => {
    await dailyAuthority(env, c, h, now(), true);
    if (
      !(await env.PRIVATE_DB.prepare(
        'SELECT 1 FROM personal_daily_runs WHERE run_id=? AND lease_token=? AND lease_until>?',
      )
        .bind(run, token, now())
        .first())
    )
      throw new Error('daily_lease_lost');
  };
  try {
    let saved = await loadDailyCapture(env.EVIDENCE, root, run);
    if (!saved) {
      if (!claimed) throw new Error('daily_attempt_consumed');
      let requests = 0;
      const response = await readReviewedPublicGpu(c.config, c.decision.terms, {
        now,
        fetcher: async (url, init) => {
          await guard();
          if (++requests > 3) throw new Error('daily_budget');
          return (opt.fetcher ?? fetch)(url, init);
        },
      });
      const page = await parsePublicGpu(
        c.config,
        response.text,
        response.observed_at,
        c.data_origin === 'synthetic',
      );
      saved = {
        version: 'daily-projection-v2',
        contract_hash: h,
        run_id: run,
        observed_at: response.observed_at,
        payload_hash: await hash(response.text),
        page,
      };
    }
    if ((saved as { version?: string }).version !== 'daily-projection-v2') {
      const legacy = z
        .object({
          contract_hash: z.string(),
          run_id: z.string(),
          observed_at: z.iso.datetime(),
          payload_hash: z.string(),
          page: PublicGpuPageSchema.extend({ records: PublicGpuPageSchema.shape.records.max(48) }),
        })
        .strict()
        .parse(saved);
      saved = { ...legacy, version: 'daily-projection-v2' };
    }
    {
      const capture = DailyCapture.parse(saved);
      if (
        capture.contract_hash !== h ||
        capture.run_id !== run ||
        capture.observed_at < anchor.started_at ||
        capture.observed_at > now() ||
        now() >= expires ||
        capture.page.records.length >
          (c.config.limits.capture_record_limit ?? c.config.limits.page_size)
      )
        throw new Error('daily_capture_invalid');
      await saveDailyCapture(env.EVIDENCE, root, run, capture, expires, guard);
      const { plan, plan_hash } = await dailyPlan(
        env.PRIVATE_DB,
        env.EVIDENCE,
        root,
        c,
        h,
        row!,
        capture,
        now(),
        expires,
        guard,
      );
      await guard();
      await env.PRIVATE_DB.prepare('INSERT OR IGNORE INTO personal_daily_coverage VALUES (?,?,?,?)')
        .bind(run, plan.coverage.series_id, plan_hash, stable(plan.coverage))
        .run();
      const stored = await env.PRIVATE_DB.prepare(
        'SELECT plan_hash FROM personal_daily_coverage WHERE run_id=?',
      )
        .bind(run)
        .first<string>('plan_hash');
      if (stored !== plan_hash) throw new Error('daily_plan_conflict');
      await env.PRIVATE_DB.prepare(
        'INSERT OR IGNORE INTO personal_daily_checkpoints VALUES (?,?,0)',
      )
        .bind(run, plan_hash)
        .run();
      const cp = await env.PRIVATE_DB.prepare(
        'SELECT plan_hash,next_index FROM personal_daily_checkpoints WHERE run_id=?',
      )
        .bind(run)
        .first<{ plan_hash: string; next_index: number }>();
      const seen = plan.records.filter((r) => r.change_kind !== 'not_seen');
      if (!cp || cp.plan_hash !== plan_hash || cp.next_index > seen.length)
        throw new Error('daily_checkpoint_invalid');
      const end = Math.min(cp.next_index + 19, seen.length),
        statements = [];
      for (const r of seen.slice(cp.next_index, end))
        statements.push(
          env.PRIVATE_DB.prepare(
            'INSERT OR IGNORE INTO personal_daily_observations SELECT ?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM personal_daily_runs WHERE run_id=? AND lease_token=? AND lease_until>?)',
          ).bind(
            r.observation_id,
            r.run_id,
            r.record_key,
            r.record_hash,
            r.observed_at,
            r.recorded_at,
            r.previous_observation_id,
            r.change_kind,
            r.domain_json,
            run,
            token,
            now(),
          ),
        );
      statements.push(
        env.PRIVATE_DB.prepare(
          'UPDATE personal_daily_checkpoints SET next_index=? WHERE run_id=? AND plan_hash=? AND next_index=? AND EXISTS(SELECT 1 FROM personal_daily_runs WHERE run_id=? AND lease_token=? AND lease_until>?)',
        ).bind(end, run, plan_hash, cp.next_index, run, token, now()),
      );
      await guard();
      await env.PRIVATE_DB.batch(statements);
      if (end < seen.length) {
        await env.PRIVATE_DB.prepare(
          'UPDATE personal_daily_runs SET lease_token=NULL,lease_until=NULL WHERE run_id=? AND lease_token=?',
        )
          .bind(run, token)
          .run();
        await publishDailyCatalog(env, source, run, now());
        return { state: 'partial', checkpoint: end };
      }
      await guard();
      const counts = await env.PRIVATE_DB.prepare(
        "SELECT COUNT(*) total,SUM(CASE WHEN change_kind='not_seen' THEN 1 ELSE 0 END) missing FROM personal_daily_observations WHERE run_id=?",
      )
        .bind(run)
        .first<{ total: number; missing: number | null }>();
      if (counts?.total !== plan.coverage.seen_count || (counts.missing ?? 0) !== 0)
        throw new Error('daily_count_mismatch');
      // At most 128 absence events, atomically with the complete barrier. No
      // not_seen row can survive a failed/partial acquisition or final commit.
      const commitAt = now();
      const committed = await env.PRIVATE_DB.batch([
        env.PRIVATE_DB.prepare(
          "INSERT OR IGNORE INTO personal_daily_observations SELECT json_extract(value,'$.observation_id'),json_extract(value,'$.run_id'),json_extract(value,'$.record_key'),NULL,json_extract(value,'$.observed_at'),json_extract(value,'$.recorded_at'),json_extract(value,'$.previous_observation_id'),'not_seen',NULL FROM json_each(?) WHERE EXISTS(SELECT 1 FROM personal_daily_runs WHERE run_id=? AND lease_token=? AND lease_until>?)",
        ).bind(
          stable(plan.records.filter((r) => r.change_kind === 'not_seen')),
          run,
          token,
          commitAt,
        ),
        env.PRIVATE_DB.prepare(
          "UPDATE personal_daily_runs SET state='complete',observed_at=?,record_count=?,evidence_hash=?,lease_token=NULL,lease_until=NULL WHERE run_id=? AND lease_token=? AND lease_until>?",
        ).bind(
          capture.observed_at,
          plan.coverage.event_count,
          capture.payload_hash,
          run,
          token,
          commitAt,
        ),
      ]);
      if (committed[1].meta.changes !== 1) throw new Error('daily_lease_lost');
      await publishDailyCatalog(env, source, run, now());
      return { state: 'complete', reused: false };
    }
  } catch (e) {
    const reason = e instanceof z.ZodError ? 'public_gpu_schema_invalid' : errorCode(e);
    if (e instanceof FetchFailure || (gpuReviewErrors as readonly string[]).includes(reason))
      await env.EVIDENCE.put(
        root + 'stop.json',
        stable({
          reason,
          review_required: (gpuReviewErrors as readonly string[]).includes(reason),
          retry_at:
            e instanceof FetchFailure
              ? (e.retry_at ?? new Date(Date.parse(now()) + 86400000).toISOString())
              : null,
        }),
      );
    // Saved projection can resume without HTTP; acquisition errors consume today's slot.
    await env.PRIVATE_DB.prepare(
      'UPDATE personal_daily_runs SET state=?,reason=?,lease_token=NULL,lease_until=NULL WHERE run_id=? AND lease_token=?',
    )
      .bind(
        (await hasDailyCapture(env.EVIDENCE, root, run)) ? 'partial' : 'failed',
        reason,
        run,
        token,
      )
      .run();
    await publishDailyCatalog(env, source, run, now());
    throw new Error('daily_capture_failed');
  }
}
export async function publishDailyCatalog(env: DailyEnv, source: string, run: string, at: string) {
  const row = await env.PRIVATE_DB.prepare('SELECT ordinal FROM personal_daily_runs WHERE run_id=?')
    .bind(run)
    .first<{ ordinal: number }>();
  if (!row) return;
  const page = Math.floor((row.ordinal - 1) / 32),
    root = dailyRoot(source);
  const oldPage = await env.EVIDENCE.head(root + 'catalog/' + page + '.json'),
    oldHead = await env.EVIDENCE.get(root + 'catalog.json');
  const priorCatalog = oldHead ? DailyCatalog.parse(await oldHead.json()) : null;
  const currentMax = await env.PRIVATE_DB.prepare(
    'SELECT MAX(ordinal) n FROM personal_daily_runs WHERE source_id=?',
  )
    .bind(source)
    .first<number | null>('n');
  if (priorCatalog && (currentMax ?? 0) < priorCatalog.max_ordinal)
    throw new Error('daily_catalog_rollback');
  const items = await env.PRIVATE_DB.prepare(
    'SELECT ordinal,run_id,state,contract_hash,reason FROM personal_daily_runs WHERE source_id=? AND ordinal>? AND ordinal<=? ORDER BY ordinal',
  )
    .bind(source, page * 32, (page + 1) * 32)
    .all();
  if (
    !(await env.EVIDENCE.put(
      root + 'catalog/' + page + '.json',
      stable(DailyPage.parse(items.results)),
      { onlyIf: oldPage ? { etagMatches: oldPage.etag } : { etagDoesNotMatch: '*' } },
    ))
  )
    throw new Error('daily_catalog_conflict');
  const last = await env.PRIVATE_DB.prepare(
    'SELECT ordinal,run_id FROM personal_daily_runs WHERE source_id=? ORDER BY ordinal DESC LIMIT 1',
  )
    .bind(source)
    .first<{ ordinal: number; run_id: string }>();
  const complete = await env.PRIVATE_DB.prepare(
    "SELECT run_id FROM personal_daily_runs WHERE source_id=? AND state='complete' ORDER BY ordinal DESC LIMIT 1",
  )
    .bind(source)
    .first<string>('run_id');
  if (priorCatalog && last && priorCatalog.max_ordinal > last.ordinal)
    throw new Error('daily_catalog_rollback');
  const pages = await env.PRIVATE_DB.prepare(
    'SELECT DISTINCT CAST((ordinal-1)/32 AS INTEGER) page FROM personal_daily_runs WHERE source_id=? ORDER BY page LIMIT 8193',
  )
    .bind(source)
    .all<{ page: number }>();
  if (last)
    if (
      !(await env.EVIDENCE.put(
        root + 'catalog.json',
        stable(
          DailyCatalog.parse({
            version: 1,
            source_id: source,
            max_ordinal: last.ordinal,
            pages: pages.results.map((p) => p.page),
            latest_run_id: complete,
            checked_at: at,
          }),
        ),
        { onlyIf: oldHead ? { etagMatches: oldHead.etag } : { etagDoesNotMatch: '*' } },
      ))
    )
      throw new Error('daily_catalog_conflict');
}
export async function exportDailyHistory(env: DailyEnv, source: string, at: string) {
  const started = Date.now();
  const row = await env.PRIVATE_DB.prepare(
    "SELECT * FROM personal_daily_runs WHERE source_id=? AND state='complete' AND (exported_at IS NULL OR exported_at<?) ORDER BY exported_at,ordinal LIMIT 1",
  )
    .bind(source, at.slice(0, 10) + 'T00:00:00.000Z')
    .first<DailyRun>();
  if (!row) return { state: 'current' };
  const c = PersonalDailySchema.parse(
    JSON.parse(
      (await env.PRIVATE_DB.prepare(
        'SELECT contract_json FROM personal_daily_contracts WHERE contract_hash=?',
      )
        .bind(row.contract_hash)
        .first<string>('contract_json'))!,
    ),
  );
  const authority = await dailyAuthority(env, c, row.contract_hash, at);
  const root = dailyRoot(source),
    key = root + 'exports/' + row.run_id + '/' + at.slice(0, 10) + '/',
    leaseKey = key + 'lease.json';
  const prior = await env.EVIDENCE.get(leaseKey);
  if (prior && (await prior.json<{ until: string }>()).until > at) return { state: 'leased' };
  const lease = await env.EVIDENCE.put(
    leaseKey,
    stable({ until: new Date(Date.parse(at) + 300000).toISOString() }),
    {
      onlyIf: prior ? { etagMatches: prior.etag } : { etagDoesNotMatch: '*' },
      customMetadata: { expires_at: new Date(Date.parse(at) + 86400000).toISOString() },
    },
  );
  if (!lease) return { state: 'leased' };
  try {
    let snapshot = await dailyJSON(env.EVIDENCE, key + 'snapshot.json', 524288);
    if (!snapshot) {
      const coverage = await env.PRIVATE_DB.prepare(
        'SELECT coverage_json,plan_hash FROM personal_daily_coverage WHERE run_id=?',
      )
        .bind(row.run_id)
        .first<{ coverage_json: string; plan_hash: string }>();
      const records = await env.PRIVATE_DB.prepare(
        'SELECT * FROM personal_daily_observations WHERE run_id=? ORDER BY record_key LIMIT 257',
      )
        .bind(row.run_id)
        .all();
      if (records.results.length !== row.record_count) throw new Error('daily_export_count');
      snapshot = DailySnapshot.parse({
        version: coverage ? 'daily-history-v2' : 'daily-history-v1',
        ...(coverage
          ? { coverage: JSON.parse(coverage.coverage_json), plan_hash: coverage.plan_hash }
          : {}),
        contract: c,
        contract_hash: row.contract_hash,
        run_id: row.run_id,
        ordinal: row.ordinal,
        day: row.day,
        started_at: row.started_at,
        observed_at: row.observed_at,
        created_at: at,
        expires_at: new Date(
          Date.parse(at) + c.decision.retention.backup.retention_days * 86400000,
        ).toISOString(),
        evidence_hash: row.evidence_hash,
        records: records.results,
      });
      if (new TextEncoder().encode(stable(snapshot)).length > 524288)
        throw new Error('daily_export_size_or_expiry');
      const saved = await env.EVIDENCE.put(key + 'snapshot.json', stable(snapshot), {
        onlyIf: { etagDoesNotMatch: '*' },
        customMetadata: { expires_at: snapshot.expires_at },
      });
      if (!saved) throw new Error('daily_export_conflict');
    }
    const s = await validateDailySnapshot(snapshot),
      bytes = new TextEncoder().encode(stable(s));
    if (bytes.length > 524288 || s.expires_at <= at) throw new Error('daily_export_size_or_expiry');
    const chunks = [];
    for (let i = 0; i < bytes.length; i += 131072) {
      const body = bytes.slice(i, i + 131072),
        part = key + 'part-' + i / 131072 + '.json',
        sha256 = await hashBytes(body);
      const old = await env.EVIDENCE.get(part);
      if (old && (await hashBytes(new Uint8Array(await old.arrayBuffer()))) !== sha256)
        throw new Error('daily_export_conflict');
      if (
        !old &&
        !(await env.EVIDENCE.put(part, body, {
          onlyIf: { etagDoesNotMatch: '*' },
          customMetadata: { expires_at: s.expires_at },
        }))
      )
        throw new Error('daily_export_conflict');
      chunks.push({ key: part, sha256, bytes: body.length });
    }
    const latest = await dailyAuthority(env, c, row.contract_hash, at);
    if (
      stable(latest) !== stable(authority) ||
      Date.now() - started >= 300000 ||
      (await env.EVIDENCE.head(leaseKey))?.etag !== lease.etag
    )
      throw new Error('daily_export_lease_lost');
    const manifest = DailyManifest.parse({
      version: 1,
      source_id: source,
      contract_hash: row.contract_hash,
      run_id: row.run_id,
      ordinal: row.ordinal,
      snapshot_hash: await hash(stable(s)),
      created_at: s.created_at,
      expires_at: s.expires_at,
      chunks,
    });
    const manifestKey = key + 'manifest.json';
    const savedManifest = await env.EVIDENCE.put(manifestKey, stable(manifest), {
      onlyIf: { etagDoesNotMatch: '*' },
      customMetadata: { expires_at: s.expires_at },
    });
    if (!savedManifest && stable(await dailyJSON(env.EVIDENCE, manifestKey)) !== stable(manifest))
      throw new Error('daily_export_conflict');
    const pointerKey = root + 'runs/' + row.run_id + '.json';
    const oldPointer = await env.EVIDENCE.get(pointerKey);
    if (oldPointer && DailyManifest.parse(await oldPointer.json()).created_at > s.created_at)
      throw new Error('daily_export_rollback');
    if (
      !(await env.EVIDENCE.put(pointerKey, stable(manifest), {
        onlyIf: oldPointer ? { etagMatches: oldPointer.etag } : { etagDoesNotMatch: '*' },
      }))
    )
      throw new Error('daily_export_conflict');
    await env.PRIVATE_DB.prepare(
      'UPDATE personal_daily_runs SET exported_at=?,export_expires_at=? WHERE run_id=?',
    )
      .bind(s.created_at, s.expires_at, row.run_id)
      .run();
    await publishDailyCatalog(env, source, row.run_id, at);
    return { state: 'exported', run_id: row.run_id };
  } finally {
    await env.EVIDENCE.put(leaseKey, stable({ until: at }), {
      onlyIf: { etagMatches: lease.etag },
      customMetadata: { expires_at: new Date(Date.parse(at) + 86400000).toISOString() },
    });
  }
}
export async function hashBytes(body: Uint8Array) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(body))))
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('');
}
// Evidence/backup-generation cleanup is bounded; normalized rows have no age TTL.
export async function maintainDaily(env: DailyEnv, source: string, at: string) {
  const root = dailyRoot(source),
    cursorKey = root + 'cleanup.json',
    prior = await dailyJSON(env.EVIDENCE, cursorKey, 8192);
  const page = await env.EVIDENCE.list({
    prefix: root,
    limit: 20,
    cursor: prior?.cursor,
    include: ['customMetadata'],
  });
  const revoked =
    !!(await env.EVIDENCE.head(root + 'revoked.json')) ||
    !!(await env.EVIDENCE.head(
      'personal-research/control/' + source + '/research-control/revocations/' + source + '.json',
    ));
  for (const o of page.objects) {
    // A crash between the immutable reservation and D1 insertion must remain a
    // visible failed attempt, never a fresh HTTP allowance or a permanent partial.
    if (o.key.startsWith(root + 'slots/')) {
      const slot = await dailyJSON(env.EVIDENCE, o.key, 8192);
      if (slot && Date.parse(slot.started_at) + 300000 <= Date.parse(at)) {
        const raw = await env.PRIVATE_DB.prepare(
          'SELECT contract_json FROM personal_daily_contracts WHERE contract_hash=? AND source_id=?',
        )
          .bind(slot.contract_hash, source)
          .first<string>('contract_json');
        if (raw) {
          const c = PersonalDailySchema.parse(JSON.parse(raw));
          const day = o.key.slice((root + 'slots/').length, -5);
          if (slot.run_id !== (await dailyRunId(source, day, c.data_origin)))
            throw new Error('daily_slot_invalid');
          const inserted = await env.PRIVATE_DB.prepare(
            "INSERT OR IGNORE INTO personal_daily_runs(run_id,source_id,day,synthetic,contract_hash,started_at,state,evidence_expires_at,reason) SELECT ?,?,?,?,?,?,'failed',?,'interrupted_before_checkpoint' WHERE NOT EXISTS(SELECT 1 FROM personal_daily_runs WHERE run_id=?)",
          )
            .bind(
              slot.run_id,
              source,
              day,
              Number(c.data_origin === 'synthetic'),
              slot.contract_hash,
              slot.started_at,
              new Date(
                Date.parse(slot.started_at) + c.decision.retention.evidence_days * 86400000,
              ).toISOString(),
              slot.run_id,
            )
            .run();
          if (inserted.meta.changes) await publishDailyCatalog(env, source, slot.run_id, at);
        }
      }
    }
    const run = o.key
      .slice(root.length)
      .match(/^(?:exports|evidence|runs)\/([a-f0-9]{64})(?:\/|\.)/)?.[1];
    const deleted = run && (await env.EVIDENCE.head(root + 'deleted/' + run + '.json'));
    if (
      (o.customMetadata?.expires_at && o.customMetadata.expires_at <= at) ||
      ((revoked || deleted) && /\/(exports|evidence|runs)\//.test(o.key))
    )
      await env.EVIDENCE.delete(o.key);
  }
  await env.EVIDENCE.put(cursorKey, stable(page.truncated ? { cursor: page.cursor } : {}));
  const scanKey = root + 'retention-scan.json',
    scan = await dailyJSON(env.EVIDENCE, scanKey, 8192);
  const runs = await env.PRIVATE_DB.prepare(
    "SELECT r.*,c.contract_json FROM personal_daily_runs r JOIN personal_daily_contracts c ON c.contract_hash=r.contract_hash WHERE r.source_id=? AND r.state!='purged' AND r.ordinal>? ORDER BY r.ordinal LIMIT 20",
  )
    .bind(source, scan?.ordinal ?? 0)
    .all<DailyRun & { contract_json: string }>();
  for (const r of runs.results) {
    if (
      r.state === 'partial' &&
      r.evidence_expires_at <= at &&
      (!r.lease_until || r.lease_until <= at)
    ) {
      await env.PRIVATE_DB.prepare(
        "UPDATE personal_daily_runs SET state='failed',reason='saved_projection_expired',lease_token=NULL,lease_until=NULL WHERE run_id=? AND state='partial'",
      )
        .bind(r.run_id)
        .run();
      await publishDailyCatalog(env, source, r.run_id, at);
    }
    const control = await dailyJSON(
      env.EVIDENCE,
      root + 'authority/' + r.contract_hash + '.json',
      8192,
    );
    if (
      revoked ||
      control?.storage === 'denied' ||
      (control?.storage_ends_at && control.storage_ends_at <= at)
    ) {
      await env.EVIDENCE.put(
        root + 'deleted/' + r.run_id + '.json',
        stable({ at, contract_hash: r.contract_hash }),
        { onlyIf: { etagDoesNotMatch: '*' } },
      );
      await env.PRIVATE_DB.prepare("UPDATE personal_daily_runs SET state='purging' WHERE run_id=?")
        .bind(r.run_id)
        .run();
      await env.PRIVATE_DB.prepare('DELETE FROM personal_daily_observations WHERE run_id=?')
        .bind(r.run_id)
        .run();
      for (const table of ['personal_daily_coverage', 'personal_daily_checkpoints'])
        await env.PRIVATE_DB.prepare('DELETE FROM ' + table + ' WHERE run_id=?')
          .bind(r.run_id)
          .run();
      await env.PRIVATE_DB.prepare(
        "UPDATE personal_daily_runs SET state='purged',reason='explicit_storage_end' WHERE run_id=?",
      )
        .bind(r.run_id)
        .run();
      await publishDailyCatalog(env, source, r.run_id, at);
    }
  }
  await env.EVIDENCE.put(
    scanKey,
    stable({ ordinal: runs.results.length === 20 ? runs.results.at(-1)!.ordinal : 0 }),
  );
  return { state: revoked ? 'revoked' : 'maintained' };
}
