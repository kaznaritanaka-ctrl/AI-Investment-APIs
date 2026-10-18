import { inspectPersonalAuthority } from './personal-cloud-authority';
import { z } from 'zod';
import { hash, stable } from '../util';
import { type PersonalContract } from './personal-contract';
import { assertNotRevoked } from './retention';
import type { PersonalEnv, PersonalOptions } from './personal';

const ref = z.string().trim().min(1).max(500);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const time = z.iso.datetime().refine((v) => new Date(v).toISOString() === v);
export const PersonalReviewSchema = z
  .object({
    version: z.literal('personal-review-v1'),
    contract_hash: digest,
    previous_hash: digest,
    sequence: z.number().int().min(1),
    approved_at: time,
    owner_approval_ref: ref,
    historical_use_review_ref: ref,
    terms_version: ref,
    terms_evidence_ref: ref,
    review_after: time,
    analysis_until: time,
    storage_state: z.enum(['continuing', 'unknown']),
    storage_basis_ref: ref,
    storage_ends_at: time.nullable(),
    scope: z.literal('existing_run_only'),
    new_collection: z.literal(false),
  })
  .strict()
  .refine(
    (v) => v.approved_at < v.review_after && v.approved_at < v.analysis_until,
    'personal_review_dates_invalid',
  );
export type PersonalReview = z.infer<typeof PersonalReviewSchema>;
export const HeadSchema = z
  .object({
    contract_hash: digest,
    sequence: z.number().int().min(0),
    review_hash: digest,
    approved_at: time,
    review_after: time,
    analysis_until: time,
    storage_state: z.enum(['continuing', 'unknown']),
    storage_ends_at: time.nullable(),
  })
  .strict();
export const personalHeadKey = (c: PersonalContract) =>
  'research-control/personal-heads/' +
  c.config.source.source_id +
  '/' +
  c.decision.exception_id +
  '.json';
const reviewKey = (c: PersonalContract, d: string) =>
  'research-control/personal-reviews/' +
  c.config.source.source_id +
  '/' +
  c.decision.exception_id +
  '/' +
  d +
  '.json';
export const personalRunId = (c: PersonalContract) =>
  hash(
    stable([
      'personal-gpu-v1',
      c.config.source.source_id + '/' + c.decision.exception_id,
      c.data_origin,
    ]),
  );

export async function personalReviewHead(env: PersonalEnv, c: PersonalContract, required = false) {
  if (c.version === 'personal-gpu-v1') return null;
  const obj = await env.EVIDENCE.get(personalHeadKey(c));
  if (!obj) {
    if (required) throw new Error('personal_current_review_missing');
    return null;
  }
  if (obj.size > 8192) throw new Error('personal_review_corrupt');
  const head = HeadSchema.parse(await obj.json());
  const audited = await env.PRIVATE_DB.prepare(
    'SELECT sequence,review_hash FROM research_personal_reviews WHERE contract_hash=? ORDER BY sequence DESC LIMIT 1',
  )
    .bind(head.contract_hash)
    .first<{ sequence: number; review_hash: string }>();
  if (
    audited &&
    (audited.sequence > head.sequence ||
      (audited.sequence === head.sequence && audited.review_hash !== head.review_hash))
  )
    throw new Error('personal_current_review_rollback');
  const original = await hash(stable(c));
  if (head.contract_hash !== original) throw new Error('personal_current_contract_changed');
  if (head.sequence === 0) {
    if (
      head.review_hash !== original ||
      head.approved_at !== c.decision.approved_at ||
      head.review_after !== c.decision.terms.review_after ||
      head.analysis_until !== c.decision.analysis_until ||
      head.storage_state !== 'continuing' ||
      head.storage_ends_at !== null
    )
      throw new Error('personal_review_corrupt');
  } else {
    const record = await env.EVIDENCE.get(reviewKey(c, head.review_hash));
    if (!record || record.size > 8192) throw new Error('personal_review_corrupt');
    const review = PersonalReviewSchema.parse(await record.json());
    if (
      (await hash(stable(review))) !== head.review_hash ||
      review.contract_hash !== original ||
      review.sequence !== head.sequence ||
      review.approved_at !== head.approved_at ||
      review.review_after !== head.review_after ||
      review.analysis_until !== head.analysis_until ||
      review.storage_state !== head.storage_state
    )
      throw new Error('personal_review_corrupt');
    // The cumulative deadline cannot be later than the current explicit limit.
    if (review.storage_ends_at !== head.storage_ends_at) throw new Error('personal_review_corrupt');
  }
  return { head, etag: obj.etag };
}

export async function initializePersonalReview(env: PersonalEnv, c: PersonalContract) {
  if (c.version === 'personal-gpu-v1') return;
  const digest = await hash(stable(c));
  await env.EVIDENCE.put(
    personalHeadKey(c),
    stable({
      contract_hash: digest,
      sequence: 0,
      review_hash: digest,
      approved_at: c.decision.approved_at,
      review_after: c.decision.terms.review_after,
      analysis_until: c.decision.analysis_until,
      storage_state: 'continuing',
      storage_ends_at: null,
    }),
    { onlyIf: { etagDoesNotMatch: '*' } },
  );
  await personalReviewHead(env, c, true);
}

export async function renewPersonalReview(
  env: PersonalEnv,
  input: unknown,
  update: unknown,
  opt: PersonalOptions = {},
) {
  if ('PUBLIC_DB' in env) throw new Error('personal_public_binding_forbidden');
  if (env.ENVIRONMENT !== 'test' && (opt.now || opt.fetcher))
    throw new Error('personal_synthetic_boundary');
  const at = (opt.now ?? (() => new Date().toISOString()))();
  const { contract: c, contract_hash: digest } = await inspectPersonalAuthority(
    env,
    input,
    at,
    'maintain',
  );
  if (c.version === 'personal-gpu-v1' || c.decision.retention.store_id !== env.PERSONAL_STORE_ID)
    throw new Error('personal_review_scope_invalid');
  const r = PersonalReviewSchema.parse(update);
  const prior = (await personalReviewHead(env, c, true))!;
  if (
    r.contract_hash !== digest ||
    r.previous_hash !== prior.head.review_hash ||
    r.sequence !== prior.head.sequence + 1 ||
    r.approved_at > at ||
    r.approved_at < prior.head.approved_at ||
    r.review_after <= at ||
    r.analysis_until <= at
  )
    throw new Error('personal_review_conflict');
  if (
    prior.head.storage_ends_at &&
    (!r.storage_ends_at || r.storage_ends_at > prior.head.storage_ends_at)
  )
    throw new Error('personal_storage_extension_forbidden');
  if (prior.head.storage_ends_at && at >= prior.head.storage_ends_at)
    throw new Error('personal_storage_expired');
  const runId = await personalRunId(c);
  await assertNotRevoked(env, c.config.source.source_id, runId);
  const run = await env.PRIVATE_DB.prepare(
    'SELECT state,config_hash FROM research_runs WHERE run_id=?',
  )
    .bind(runId)
    .first<{ state: string; config_hash: string }>();
  if (!run || run.config_hash !== digest || ['purged', 'purging'].includes(run.state))
    throw new Error('personal_history_unavailable');
  const nextHash = await hash(stable(r));
  await env.EVIDENCE.put(reviewKey(c, nextHash), stable(r), { onlyIf: { etagDoesNotMatch: '*' } });
  const result = await env.EVIDENCE.put(
    personalHeadKey(c),
    stable({
      contract_hash: digest,
      sequence: r.sequence,
      review_hash: nextHash,
      approved_at: r.approved_at,
      review_after: r.review_after,
      analysis_until: r.analysis_until,
      storage_state: r.storage_state,
      storage_ends_at: r.storage_ends_at,
    }),
    { onlyIf: { etagMatches: prior.etag } },
  );
  if (!result) throw new Error('personal_review_conflict');
  await syncPersonalReviewAudit(env, c);
  return {
    state: 'review_adopted',
    sequence: r.sequence,
    review_hash: nextHash,
    new_collection: false,
  };
}

export async function syncPersonalReviewAudit(env: PersonalEnv, c: PersonalContract) {
  const current = await personalReviewHead(env, c, true);
  if (!current || !current.head.sequence) return;
  const body = await (await env.EVIDENCE.get(reviewKey(c, current.head.review_hash)))!.text();
  // R2 head is authoritative across DB restoration; audit replay is idempotent.
  await env.PRIVATE_DB.prepare(
    'INSERT OR IGNORE INTO research_personal_reviews(review_hash,contract_hash,sequence,reviewed_at,review_json) VALUES (?,?,?,?,?)',
  )
    .bind(
      current.head.review_hash,
      current.head.contract_hash,
      current.head.sequence,
      current.head.approved_at,
      body,
    )
    .run();
}
