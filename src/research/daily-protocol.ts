import { z } from 'zod';
import { PersonalDailySchema } from './personal-contract';
import {
  PublicGpuRecordSchema,
  PublicGpuPageSchema,
  gpuRecordFingerprint,
} from './public-gpu-html';
import { dailySeriesDefinition } from './daily-series';
import { hash, stable } from '../util';

export const dailySource = z.enum(['highreso_public', 'rebro_public']);
export const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const time = z.iso.datetime().refine((v) => new Date(v).toISOString() === v);
export const DailyControl = z
  .object({
    version: z.literal(1),
    contract_hash: digest,
    sequence: z.number().int().min(0),
    reviewed_at: time,
    storage: z.enum(['continuing', 'unknown', 'denied']),
    storage_ends_at: time.nullable(),
    collection_stopped: z.boolean(),
    review_after: time,
    analysis_until: time,
    approval_ref: z.string().min(1).max(500),
  })
  .strict();
const LegacyDailyRow = z
  .object({
    observation_id: digest,
    run_id: digest,
    record_key: z.string().min(1).max(120),
    record_hash: digest,
    observed_at: time,
    recorded_at: time,
    previous_observation_id: digest.nullable(),
    change_kind: z.enum(['first_seen', 'reobserved', 'revised']),
    domain_json: z.string().max(16384),
  })
  .strict();
export const DailyRow = z.discriminatedUnion('change_kind', [
  LegacyDailyRow.extend({
    change_kind: z.enum(['first_seen', 'reobserved', 'revised', 'reappeared']),
  }),
  LegacyDailyRow.extend({
    change_kind: z.literal('not_seen'),
    record_hash: z.null(),
    domain_json: z.null(),
    previous_observation_id: digest,
  }),
]);
export const DailyCoverage = z
  .object({
    recorded_at: time,
    series_id: digest,
    previous_complete_run_id: digest.nullable(),
    seen_count: z.number().int().min(0).max(128),
    not_seen_count: z.number().int().min(0).max(128),
    event_count: z.number().int().min(0).max(256),
    selection: PublicGpuPageSchema.shape.selection.unwrap().nullable(),
  })
  .strict();
const SnapshotBase = z
  .object({
    contract: PersonalDailySchema,
    contract_hash: digest,
    run_id: digest,
    ordinal: z.number().int().positive(),
    day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    started_at: time,
    observed_at: time,
    created_at: time,
    expires_at: time,
    evidence_hash: digest,
  })
  .strict();
export const DailySnapshot = z.discriminatedUnion('version', [
  SnapshotBase.extend({
    version: z.literal('daily-history-v1'),
    records: z.array(LegacyDailyRow).max(48),
  }),
  SnapshotBase.extend({
    version: z.literal('daily-history-v2'),
    plan_hash: digest,
    coverage: DailyCoverage,
    records: z.array(DailyRow).max(256),
  }),
]);
export const DailyManifest = z
  .object({
    version: z.literal(1),
    source_id: dailySource,
    contract_hash: digest,
    run_id: digest,
    ordinal: z.number().int().positive(),
    snapshot_hash: digest,
    created_at: time,
    expires_at: time,
    chunks: z
      .array(
        z
          .object({
            key: z.string().max(300),
            sha256: digest,
            bytes: z.number().int().min(1).max(131072),
          })
          .strict(),
      )
      .min(1)
      .max(4),
  })
  .strict();
export const DailyCatalog = z
  .object({
    version: z.literal(1),
    source_id: dailySource,
    max_ordinal: z.number().int().min(0),
    pages: z.array(z.number().int().min(0)).max(8192),
    latest_run_id: digest.nullable(),
    checked_at: time,
  })
  .strict()
  .refine(
    (c) =>
      c.pages.every((p, i) => i === 0 || p > c.pages[i - 1]) &&
      (c.max_ordinal === 0
        ? c.pages.length === 0 && c.latest_run_id === null
        : c.pages.at(-1) === Math.floor((c.max_ordinal - 1) / 32)),
    'daily_catalog_scope',
  );
export const DailyPage = z
  .array(
    z
      .object({
        ordinal: z.number().int().positive(),
        run_id: digest,
        state: z.enum(['partial', 'complete', 'failed', 'purging', 'purged']),
        contract_hash: digest,
        reason: z.string().nullable(),
      })
      .strict(),
  )
  .min(1)
  .max(32)
  .refine(
    (items) =>
      items.every((r, i) => i === 0 || r.ordinal > items[i - 1].ordinal) &&
      new Set(items.map((r) => r.run_id)).size === items.length,
    'daily_page_order',
  );
export function dailyCatalogPage(input: unknown, page: number) {
  const records = DailyPage.parse(input);
  if (records.some((r) => Math.floor((r.ordinal - 1) / 32) !== page))
    throw new Error('daily_page_scope');
  return records;
}
export const NasReceipt = z
  .object({
    version: z.literal(1),
    source_id: dailySource,
    issued_at: time,
    status: z.enum(['empty', 'ok', 'partial', 'failed']),
    last_backup_at: time.nullable(),
    last_restored_at: time.nullable(),
    last_inventory_at: time.nullable(),
    latest_observed_at: time.nullable(),
    pending: z.number().int().min(0),
    code: z.enum(['none', 'backup_failed', 'authority_blocked', 'inventory_partial']),
  })
  .strict();
export type NasReceiptValue = z.infer<typeof NasReceipt>;
export const dailyRoot = (s: string) => 'personal-daily/' + dailySource.parse(s) + '/';
export const dailyRunId = (s: string, day: string, origin: string) =>
  hash(stable(['daily-v1', s, day, origin]));
export async function validateDailySnapshot(input: unknown) {
  const s = DailySnapshot.parse(input),
    c = s.contract;
  if (
    (await hash(stable(c))) !== s.contract_hash ||
    (await dailyRunId(c.config.source.source_id, s.day, c.data_origin)) !== s.run_id ||
    s.day !== s.started_at.slice(0, 10) ||
    s.started_at < c.decision.acquisition_from ||
    s.started_at >= c.decision.acquisition_until ||
    s.observed_at < s.started_at ||
    s.observed_at > s.created_at ||
    s.created_at >= s.expires_at ||
    Date.parse(s.expires_at) - Date.parse(s.created_at) >
      c.decision.retention.backup.retention_days * 86400000
  )
    throw new Error('daily_snapshot_scope');
  const ids = new Set<string>();
  if (
    s.version === 'daily-history-v2' &&
    s.plan_hash !==
      (await hash(
        stable({
          version: 'daily-plan-v2',
          contract_hash: s.contract_hash,
          run_id: s.run_id,
          payload_hash: s.evidence_hash,
          recorded_at: s.coverage.recorded_at,
          coverage: s.coverage,
          records: s.records,
        }),
      ))
  )
    throw new Error('daily_snapshot_plan_hash');
  if (
    s.version === 'daily-history-v2' &&
    (s.coverage.series_id !== (await hash(stable(dailySeriesDefinition(c)))) ||
      s.coverage.event_count !== s.records.length ||
      s.coverage.seen_count !== s.records.filter((r) => r.change_kind !== 'not_seen').length ||
      s.coverage.not_seen_count !== s.records.filter((r) => r.change_kind === 'not_seen').length ||
      s.coverage.seen_count + s.coverage.not_seen_count !== s.coverage.event_count ||
      (s.coverage.selection &&
        s.coverage.selection.cohort_rows * s.coverage.selection.price_slots_per_row !==
          s.coverage.seen_count))
  )
    throw new Error('daily_snapshot_coverage');
  for (const r of s.records) {
    if (r.change_kind === 'not_seen') {
      if (
        s.version !== 'daily-history-v2' ||
        !s.coverage.previous_complete_run_id ||
        r.run_id !== s.run_id ||
        r.observed_at !== s.observed_at ||
        r.recorded_at < s.observed_at ||
        r.recorded_at > s.created_at ||
        ids.has(r.record_key) ||
        r.observation_id !==
          (await hash(stable([s.run_id, r.record_key, 'not_seen', r.previous_observation_id])))
      )
        throw new Error('daily_snapshot_absence');
      ids.add(r.record_key);
      continue;
    }
    const record = PublicGpuRecordSchema.parse(JSON.parse(r.domain_json));
    if (
      r.run_id !== s.run_id ||
      r.record_key !== record.record_key ||
      r.record_hash !== (await gpuRecordFingerprint(record)) ||
      r.observation_id !== (await hash(stable([s.run_id, r.record_key, r.record_hash]))) ||
      r.observed_at !== s.observed_at ||
      r.recorded_at < s.observed_at ||
      r.recorded_at > s.created_at ||
      record.offer.synthetic !== (c.data_origin === 'synthetic') ||
      record.offer.source_id !==
        (c.config.source.source_id === 'highreso_public' ? 'highreso' : 'rebro') ||
      record.offer.policy_version !== c.config.source.policy.version ||
      record.offer.terms_version !== c.config.terms.version ||
      record.offer.observed_at !== s.observed_at ||
      (c.config.adapter === 'highreso_public'
        ? !['node_hour', 'month'].includes(record.offer.unit) ||
          record.offer.sale_unit !== 'instance'
        : record.offer.unit !== 'gpu' || record.offer.sale_unit !== 'single_gpu') ||
      ('models' in c.config.scope &&
        !c.config.scope.models.includes(record.identity.accelerator_model as 'A100' | 'H100')) ||
      (c.config.scope.kind === 'highreso_public' &&
        c.config.scope.gpu_counts &&
        !c.config.scope.gpu_counts.includes(record.offer.gpu_count ?? -1)) ||
      (r.change_kind === 'first_seen') !== (r.previous_observation_id === null) ||
      ids.has(r.record_key)
    )
      throw new Error('daily_snapshot_record');
    ids.add(r.record_key);
  }
  return s;
}
export async function receiptSignature(receipt: NasReceiptValue, secret: string) {
  if (new TextEncoder().encode(secret).length < 32) throw new Error('daily_monitor_key_required');
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return Array.from(
    new Uint8Array(
      await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(stable(receipt))),
    ),
  )
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('');
}
export async function verifyReceipt(input: unknown, secret: string, at: string) {
  const e = z.object({ receipt: NasReceipt, signature: digest }).strict().parse(input);
  const expected = await receiptSignature(e.receipt, secret);
  let mismatch = 0;
  for (let i = 0; i < 64; i++) mismatch |= expected.charCodeAt(i) ^ e.signature.charCodeAt(i);
  if (
    mismatch ||
    e.receipt.issued_at > at ||
    [
      e.receipt.last_backup_at,
      e.receipt.last_restored_at,
      e.receipt.last_inventory_at,
      e.receipt.latest_observed_at,
    ].some((v) => v !== null && v > e.receipt.issued_at)
  )
    throw new Error('daily_receipt_invalid');
  return e.receipt;
}
