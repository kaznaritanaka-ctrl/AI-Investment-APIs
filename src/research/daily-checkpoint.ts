import { z } from 'zod';
import { hash, stable } from '../util';
import { PublicGpuPageSchema, gpuRecordFingerprint } from './public-gpu-html';
import { DailyRow, DailyCoverage, digest, time, validateDailySnapshot } from './daily-protocol';
import { dailySeriesDefinition } from './daily-series';
import type { PersonalDailyContract } from './personal-contract';

export const DailyCapture = z
  .object({
    version: z.literal('daily-projection-v2'),
    contract_hash: digest,
    run_id: digest,
    observed_at: time,
    payload_hash: digest,
    page: PublicGpuPageSchema,
  })
  .strict()
  .superRefine((v, c) => {
    const p = v.page,
      s = p.selection;
    if (
      p.reported_total !== p.records.length ||
      (s &&
        (s.input_rows !== s.cohort_rows + s.excluded_rows ||
          s.cohort_rows * s.price_slots_per_row !== p.records.length ||
          (s.excluded_by_reason &&
            s.excluded_rows !== s.excluded_by_reason.model + s.excluded_by_reason.gpu_count)))
    )
      c.addIssue({ code: 'custom', message: 'daily_capture_coverage_invalid' });
  });
const CaptureManifest = z
  .object({
    version: z.literal('daily-capture-parts-v2'),
    sha256: digest,
    bytes: z.number().int().min(1).max(524288),
    parts: z
      .array(
        z
          .object({ key: z.string(), sha256: digest, bytes: z.number().int().min(1).max(131072) })
          .strict(),
      )
      .min(1)
      .max(4),
  })
  .strict();
const bytesHash = async (bytes: Uint8Array) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))))
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');
export async function boundedDailyJSON(bucket: R2Bucket, key: string, max = 524288) {
  const o = await bucket.get(key);
  if (!o) return null;
  if (o.size > max) throw new Error('daily_object_size');
  return o.json();
}
export const captureStageKey = (root: string, run: string) =>
  root + 'evidence/' + run + '/projection.json';
export async function hasDailyCapture(bucket: R2Bucket, root: string, run: string) {
  return !!(
    (await bucket.head(root + 'evidence/' + run + '.json')) ||
    (await bucket.head(captureStageKey(root, run)))
  );
}
export async function loadDailyCapture(bucket: R2Bucket, root: string, run: string) {
  const raw = await boundedDailyJSON(bucket, root + 'evidence/' + run + '.json');
  if (!raw) return boundedDailyJSON(bucket, captureStageKey(root, run));
  if ((raw as { version?: string }).version !== 'daily-capture-parts-v2') return raw; // immutable legacy evidence
  const m = CaptureManifest.parse(raw),
    parts: Uint8Array[] = [];
  let bytes = 0;
  for (const [i, p] of m.parts.entries()) {
    if (p.key !== root + 'evidence/' + run + '/part-' + i + '.json')
      throw new Error('daily_capture_scope');
    const o = await bucket.get(p.key);
    if (!o || o.size !== p.bytes) throw new Error('daily_capture_part_missing');
    const b = new Uint8Array(await o.arrayBuffer());
    if ((await bytesHash(b)) !== p.sha256) throw new Error('daily_capture_part_hash');
    bytes += b.length;
    parts.push(b);
  }
  const all = new Uint8Array(bytes);
  let offset = 0;
  for (const b of parts) {
    all.set(b, offset);
    offset += b.length;
  }
  if (bytes !== m.bytes || (await bytesHash(all)) !== m.sha256)
    throw new Error('daily_capture_hash');
  return JSON.parse(new TextDecoder().decode(all));
}
export async function saveDailyCapture(
  bucket: R2Bucket,
  root: string,
  run: string,
  input: unknown,
  expires: string,
  guard: () => Promise<void>,
) {
  const capture = DailyCapture.parse(input),
    text = stable(capture),
    bytes = new TextEncoder().encode(text);
  if (bytes.length > 524288) throw new Error('daily_evidence_size');
  await persistDailyStage(bucket, captureStageKey(root, run), text, expires, guard);
  const pointer = await boundedDailyJSON(bucket, root + 'evidence/' + run + '.json');
  const legacy = pointer && (pointer as { version?: string }).version !== 'daily-capture-parts-v2';
  if (legacy) {
    const { version: _version, ...projection } = capture;
    if (stable(pointer) !== stable(projection)) throw new Error('daily_capture_conflict');
  }
  // Durable full projection is the recovery checkpoint; never retry source HTTP.
  const parts = [];
  for (let offset = 0, i = 0; offset < bytes.length; offset += 131072, i++) {
    const part = bytes.slice(offset, offset + 131072),
      key = root + 'evidence/' + run + '/part-' + i + '.json',
      sha256 = await bytesHash(part);
    await guard();
    const prior = await bucket.get(key);
    if (
      prior &&
      (prior.size !== part.length ||
        (await bytesHash(new Uint8Array(await prior.arrayBuffer()))) !== sha256)
    )
      throw new Error('daily_capture_conflict');
    if (
      !prior &&
      !(await bucket.put(key, part, {
        onlyIf: { etagDoesNotMatch: '*' },
        customMetadata: { expires_at: expires },
      }))
    )
      throw new Error('daily_capture_conflict');
    parts.push({ key, sha256, bytes: part.length });
  }
  await guard();
  // Keep immutable pre-v2 evidence at its original key/hash. Only pending runs
  // gain an additive v2 manifest/plan; completed v1 snapshots stay unchanged.
  const key = legacy
      ? root + 'evidence/' + run + '/capture.json'
      : root + 'evidence/' + run + '.json',
    manifest = CaptureManifest.parse({
      version: 'daily-capture-parts-v2',
      sha256: await bytesHash(bytes),
      bytes: bytes.length,
      parts,
    });
  if (
    !(await bucket.put(key, stable(manifest), {
      onlyIf: { etagDoesNotMatch: '*' },
      customMetadata: { expires_at: expires },
    })) &&
    stable(await boundedDailyJSON(bucket, key)) !== stable(manifest)
  )
    throw new Error('daily_capture_conflict');
}

async function persistDailyStage(
  bucket: R2Bucket,
  key: string,
  text: string,
  expires: string,
  guard: () => Promise<void>,
) {
  // Retry only storage using the in-memory response, never source HTTP. Reads
  // resolve ambiguous acknowledgements without overwriting the first value.
  for (let attempt = 0; attempt < 3; attempt++) {
    await guard();
    try {
      if (
        await bucket.put(key, text, {
          onlyIf: { etagDoesNotMatch: '*' },
          customMetadata: { expires_at: expires },
        })
      )
        return;
    } catch {
      /* bounded retry; authority and lease are rechecked above */
    }
    let previous: unknown;
    try {
      previous = await boundedDailyJSON(bucket, key);
    } catch {
      continue;
    }
    if (previous) {
      if (stable(previous) !== text) throw new Error('daily_capture_conflict');
      return;
    }
  }
  throw new Error('daily_evidence_write_exhausted');
}
export const DailyPlan = z
  .object({
    version: z.literal('daily-plan-v2'),
    contract_hash: digest,
    run_id: digest,
    payload_hash: digest,
    recorded_at: time,
    coverage: DailyCoverage,
    records: z.array(DailyRow).max(256),
  })
  .strict();
export async function dailyPlan(
  db: D1Database,
  bucket: R2Bucket,
  root: string,
  c: PersonalDailyContract,
  h: string,
  run: { run_id: string; started_at: string; ordinal: number; day: string },
  capture: z.infer<typeof DailyCapture>,
  at: string,
  expires: string,
  guard: () => Promise<void>,
) {
  const key = root + 'evidence/' + run.run_id + '/plan.json';
  let plan = await boundedDailyJSON(bucket, key);
  const series = await hash(stable(dailySeriesDefinition(c)));
  if (!plan) {
    const existing = await db
      .prepare(
        'SELECT * FROM personal_daily_observations WHERE run_id=? ORDER BY record_key LIMIT 129',
      )
      .bind(run.run_id)
      .all<z.infer<typeof DailyRow>>();
    if (
      existing.results.length > capture.page.records.length ||
      existing.results.some((r) => !capture.page.records.some((p) => p.record_key === r.record_key))
    )
      throw new Error('daily_legacy_observation_conflict');
    const previous = await db
      .prepare(
        "SELECT r.run_id FROM personal_daily_runs r JOIN personal_daily_series_contracts s ON s.contract_hash=r.contract_hash WHERE r.source_id=? AND r.synthetic=? AND r.state='complete' AND r.started_at<? AND s.series_id=? ORDER BY r.started_at DESC LIMIT 1",
      )
      .bind(
        c.config.source.source_id,
        Number(c.data_origin === 'synthetic'),
        run.started_at,
        series,
      )
      .first<string>('run_id');
    const records: z.infer<typeof DailyRow>[] = [],
      keys = new Set(capture.page.records.map((r) => r.record_key));
    for (const record of capture.page.records) {
      const prev = await db
        .prepare(
          "SELECT o.observation_id,o.record_hash,o.change_kind FROM personal_daily_observations o JOIN personal_daily_runs r ON r.run_id=o.run_id JOIN personal_daily_series_contracts s ON s.contract_hash=r.contract_hash WHERE r.source_id=? AND r.synthetic=? AND s.series_id=? AND r.state='complete' AND r.started_at<? AND o.record_key=? ORDER BY r.started_at DESC LIMIT 1",
        )
        .bind(
          c.config.source.source_id,
          Number(c.data_origin === 'synthetic'),
          series,
          run.started_at,
          record.record_key,
        )
        .first<{ observation_id: string; record_hash: string | null; change_kind: string }>();
      const fingerprint = await gpuRecordFingerprint(record);
      const prior = existing.results.find((r) => r.record_key === record.record_key);
      const observation = DailyRow.parse({
        observation_id: await hash(stable([run.run_id, record.record_key, fingerprint])),
        run_id: run.run_id,
        record_key: record.record_key,
        record_hash: fingerprint,
        observed_at: capture.observed_at,
        recorded_at: prior?.recorded_at ?? at,
        previous_observation_id: prev?.observation_id ?? null,
        change_kind: !prev
          ? 'first_seen'
          : prev.change_kind === 'not_seen'
            ? 'reappeared'
            : prev.record_hash === fingerprint
              ? 'reobserved'
              : 'revised',
        domain_json: stable(record),
      });
      if (prior && stable(prior) !== stable(observation))
        throw new Error('daily_legacy_observation_conflict');
      records.push(observation);
    }
    const candidates = previous
      ? await db
          .prepare(
            "SELECT observation_id,record_key FROM personal_daily_observations WHERE run_id=? AND change_kind!='not_seen' ORDER BY record_key LIMIT 129",
          )
          .bind(previous)
          .all<{ observation_id: string; record_key: string }>()
      : { results: [] };
    if (candidates.results.length > 128) throw new Error('daily_previous_cohort_limit');
    for (const prev of candidates.results)
      if (!keys.has(prev.record_key))
        records.push(
          DailyRow.parse({
            observation_id: await hash(
              stable([run.run_id, prev.record_key, 'not_seen', prev.observation_id]),
            ),
            run_id: run.run_id,
            record_key: prev.record_key,
            record_hash: null,
            domain_json: null,
            change_kind: 'not_seen',
            observed_at: capture.observed_at,
            recorded_at: at,
            previous_observation_id: prev.observation_id,
          }),
        );
    plan = DailyPlan.parse({
      version: 'daily-plan-v2',
      contract_hash: h,
      run_id: run.run_id,
      payload_hash: capture.payload_hash,
      recorded_at: at,
      records,
      coverage: {
        recorded_at: at,
        series_id: series,
        previous_complete_run_id: previous ?? null,
        seen_count: capture.page.records.length,
        not_seen_count: records.length - capture.page.records.length,
        event_count: records.length,
        selection: capture.page.selection ?? null,
      },
    });
  }
  const p = DailyPlan.parse(plan);
  p.records.sort((a, b) =>
    a.record_key < b.record_key ? -1 : a.record_key > b.record_key ? 1 : 0,
  );
  if (
    p.contract_hash !== h ||
    p.run_id !== run.run_id ||
    p.payload_hash !== capture.payload_hash ||
    p.coverage.series_id !== series
  )
    throw new Error('daily_plan_scope');
  if (
    stable(
      p.records
        .filter((r) => r.change_kind !== 'not_seen')
        .map((r) => r.domain_json)
        .sort(),
    ) !== stable(capture.page.records.map((r) => stable(r)).sort())
  )
    throw new Error('daily_plan_projection_mismatch');
  const snapshot = await validateDailySnapshot({
    version: 'daily-history-v2',
    plan_hash: await hash(stable(p)),
    contract: c,
    contract_hash: h,
    run_id: run.run_id,
    ordinal: run.ordinal,
    day: run.day,
    started_at: run.started_at,
    observed_at: capture.observed_at,
    created_at: p.recorded_at,
    expires_at: new Date(
      Date.parse(p.recorded_at) + c.decision.retention.backup.retention_days * 86400000,
    ).toISOString(),
    evidence_hash: capture.payload_hash,
    records: p.records,
    coverage: p.coverage,
  });
  if (new TextEncoder().encode(stable(snapshot)).length > 524288)
    throw new Error('daily_export_size_or_expiry');
  const text = stable(p);
  if (new TextEncoder().encode(text).length > 524288) throw new Error('daily_plan_size');
  await guard();
  if (
    !(await bucket.put(key, text, {
      onlyIf: { etagDoesNotMatch: '*' },
      customMetadata: { expires_at: expires },
    })) &&
    stable(await boundedDailyJSON(bucket, key)) !== text
  )
    throw new Error('daily_plan_conflict');
  return { plan: p, plan_hash: await hash(text) };
}
