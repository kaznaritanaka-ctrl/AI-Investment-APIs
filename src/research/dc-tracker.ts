import { z } from 'zod';
import { hash, isoTime, stable } from '../util';
import { readResearchRun, type ResearchEnv } from './pipeline';
import { DCTrackerRecordSchema } from './dc-tracker-schema';
import { assertResearchConfigExecution } from './execution';
import { assertResearchHistoryAllowed, type ResearchConfig } from './schema';

type ReadOptions = { now: () => string; current_terms_version: string };
const digest = z.string().regex(/^[a-f0-9]{64}$/);
function tracker(config: ResearchConfig) {
  if (config.adapter !== 'dc_tracker') throw new Error('dc_tracker_scope_invalid');
}
export function dcReviewWeek(at: string) {
  if (!isoTime(at)) throw new Error('invalid_dc_review_time');
  const d = new Date(at);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}
export function dcWeeklyReviewDue(at: string, previous: string | null) {
  if (previous && (!isoTime(previous) || previous > at)) throw new Error('invalid_dc_review_time');
  const week = dcReviewWeek(at);
  return previous === null || dcReviewWeek(previous) < week;
}
export async function readDCTracker(
  env: ResearchEnv,
  config: ResearchConfig,
  runId: string,
  opt: ReadOptions,
) {
  tracker(config);
  const result = await readResearchRun(env, config, digest.parse(runId), opt);
  const ids = result.results.map((r) => String(r.observation_id));
  if (!ids.length) return [];
  const reviews = await env.PRIVATE_DB.prepare(
    'SELECT * FROM (SELECT obs_id,decision,reviewed_at,batch_id,ROW_NUMBER() OVER(PARTITION BY obs_id ORDER BY reviewed_at DESC,review_order DESC) position FROM dc_observation_reviews WHERE obs_id IN (SELECT value FROM json_each(?))) WHERE position=1',
  )
    .bind(JSON.stringify(ids))
    .all<{
      obs_id: string;
      decision: 'approved' | 'rejected' | 'hold';
      reviewed_at: string;
      batch_id: string;
    }>();
  return result.results.map((row) => {
    const record = DCTrackerRecordSchema.parse(JSON.parse(String(row.domain_json)));
    const review = reviews.results.find((r) => r.obs_id === row.observation_id);
    return {
      obs_id: String(row.observation_id),
      run_id: runId,
      record,
      status:
        review?.decision === 'hold' ? ('draft' as const) : (review?.decision ?? ('draft' as const)),
      reviewed_at: review?.reviewed_at ?? null,
      review_batch_id: review?.batch_id ?? null,
      held: review?.decision === 'hold',
    };
  });
}
export async function dcMorningBrief(
  env: ResearchEnv,
  config: ResearchConfig,
  runIds: string[],
  opt: ReadOptions,
) {
  if (runIds.length > 3 || new Set(runIds).size !== runIds.length)
    throw new Error('dc_review_run_limit');
  const rows = (await Promise.all(runIds.map((id) => readDCTracker(env, config, id, opt)))).flat();
  const pending = rows.filter((r) => r.status === 'draft');
  return {
    unapproved_count: pending.length,
    approved_count: rows.filter((r) => r.status === 'approved').length,
    lines: pending.map(
      (r, i) =>
        `${i + 1}. ${r.record.project.name.replace(/[\r\n]/g, ' ')}：${r.record.field}／未承認${r.held ? '（保留）' : ''}`,
    ),
  };
}

// Hard boundary: AI receives only URL, title and date, regardless of any future grant.
export async function dcAICandidates(
  env: ResearchEnv,
  config: ResearchConfig,
  runId: string,
  opt: ReadOptions,
) {
  const rows = await readDCTracker(env, config, runId, opt);
  return rows.map(({ record }) => ({
    source_url: record.evidence.source_url,
    title: record.project.name,
    published_at: record.evidence.published_at,
  }));
}
const needsIndividual = (r: z.infer<typeof DCTrackerRecordSchema>) =>
  r.change?.kind === 'cancel' || r.change?.kind === 'downsize' || r.phase?.status === 'cancelled';

// Local review library only. No Admin write method, Worker route or automatic approval.
export async function createDCReviewBatch(
  env: ResearchEnv,
  config: ResearchConfig,
  runIds: string[],
  opt: ReadOptions & { observation_ids?: string[] },
) {
  tracker(config);
  assertResearchConfigExecution(env, config);
  if (runIds.length > 3 || new Set(runIds).size !== runIds.length)
    throw new Error('dc_review_run_limit');
  const rows = (await Promise.all(runIds.map((id) => readDCTracker(env, config, id, opt))))
    .flat()
    .filter((r) => r.status === 'draft')
    .sort((a, b) => a.obs_id.localeCompare(b.obs_id));
  if (opt.observation_ids) {
    if (
      !opt.observation_ids.length ||
      opt.observation_ids.length > 20 ||
      new Set(opt.observation_ids).size !== opt.observation_ids.length ||
      opt.observation_ids.some(
        (id) => !digest.safeParse(id).success || !rows.some((r) => r.obs_id === id),
      )
    )
      throw new Error('dc_review_selection_invalid');
  }
  const selected = (
    opt.observation_ids ? rows.filter((r) => opt.observation_ids!.includes(r.obs_id)) : rows
  ).slice(0, 20);
  if (!selected.length) throw new Error('dc_review_batch_limit');
  const at = opt.now();
  if (!isoTime(at)) throw new Error('invalid_dc_review_time');
  const batchId = await hash(stable([at, selected.map((r) => r.obs_id)]));
  const statements = [
    env.PRIVATE_DB.prepare(
      'INSERT OR IGNORE INTO dc_review_batches(batch_id,created_at,item_count,decision_summary) VALUES (?,?,?,?)',
    ).bind(batchId, at, selected.length, 'pending'),
    ...selected.map((r, i) =>
      env.PRIVATE_DB.prepare(
        'INSERT OR IGNORE INTO dc_review_batch_items(batch_id,item_number,obs_id,run_id) VALUES (?,?,?,?)',
      ).bind(batchId, i + 1, r.obs_id, r.run_id),
    ),
  ];
  await env.PRIVATE_DB.batch(statements);
  return {
    batch_id: batchId,
    remaining_count: rows.length - selected.length,
    items: selected.map((r, i) => ({
      item_number: i + 1,
      obs_id: r.obs_id,
      individual_required: needsIndividual(r.record),
      line: `${i + 1}. ${r.record.project.name.replace(/[\r\n]/g, ' ')}：未承認（承認／却下／保留）`,
    })),
  };
}
const replySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('all_ok') }).strict(),
  z
    .object({
      kind: z.literal('items'),
      decisions: z
        .array(
          z
            .object({
              item_number: z.number().int().min(1).max(20),
              decision: z.enum(['approved', 'rejected', 'hold']),
            })
            .strict(),
        )
        .min(1)
        .max(20),
    })
    .strict(),
]);
export async function recordDCReview(
  env: ResearchEnv,
  config: ResearchConfig,
  batchId: string,
  reply: unknown,
  opt: ReadOptions,
) {
  tracker(config);
  assertResearchConfigExecution(env, config);
  assertResearchHistoryAllowed(config, opt.now(), opt.current_terms_version);
  const input = replySchema.parse(reply);
  const batch = await env.PRIVATE_DB.prepare(
    'SELECT item_count,created_at FROM dc_review_batches WHERE batch_id=?',
  )
    .bind(digest.parse(batchId))
    .first<{ item_count: number; created_at: string }>();
  if (!batch || batch.created_at > opt.now()) throw new Error('dc_review_batch_missing');
  const items = await env.PRIVATE_DB.prepare(
    'SELECT item_number,obs_id,run_id FROM dc_review_batch_items WHERE batch_id=? ORDER BY item_number',
  )
    .bind(batchId)
    .all<{ item_number: number; obs_id: string; run_id: string }>();
  // A purged/partially restored manifest cannot be interpreted as the original "all".
  if (items.results.length !== batch.item_count) throw new Error('dc_review_batch_incomplete');
  if (
    items.results.some((item, i) => item.item_number !== i + 1) ||
    (await hash(stable([batch.created_at, items.results.map((item) => item.obs_id)]))) !== batchId
  )
    throw new Error('dc_review_batch_mismatch');
  const runs = [...new Set(items.results.map((r) => r.run_id))];
  if (runs.length > 3) throw new Error('dc_review_run_limit');
  const rows = (await Promise.all(runs.map((id) => readDCTracker(env, config, id, opt)))).flat();
  if (items.results.some((i) => !rows.some((r) => r.obs_id === i.obs_id)))
    throw new Error('dc_review_items_unavailable');
  const decisions =
    input.kind === 'all_ok'
      ? items.results
          .filter((i) => !needsIndividual(rows.find((r) => r.obs_id === i.obs_id)!.record))
          .map((i) => ({ item_number: i.item_number, decision: 'approved' as const }))
      : input.decisions;
  if (new Set(decisions.map((d) => d.item_number)).size !== decisions.length)
    throw new Error('dc_review_duplicate_item');
  const priorDecisions = await env.PRIVATE_DB.prepare(
    'SELECT item_number,decision FROM dc_observation_reviews WHERE batch_id=?',
  )
    .bind(batchId)
    .all<{ item_number: number; decision: string }>();
  const statements: D1PreparedStatement[] = [];
  for (const d of decisions) {
    const item = items.results.find((i) => i.item_number === d.item_number);
    if (!item) throw new Error('dc_review_item_missing');
    const existing = priorDecisions.results.find((r) => r.item_number === d.item_number);
    if (existing) {
      if (existing.decision !== d.decision) throw new Error('dc_review_already_decided');
      continue;
    }
    statements.push(
      env.PRIVATE_DB.prepare(
        "INSERT INTO dc_observation_reviews(review_id,batch_id,item_number,obs_id,run_id,decision,reviewed_at,reviewed_by) VALUES (?,?,?,?,?,?,?,'kaz')",
      ).bind(
        await hash(stable([batchId, d.item_number])),
        batchId,
        d.item_number,
        item.obs_id,
        item.run_id,
        d.decision,
        opt.now(),
      ),
    );
  }
  if (statements.length) await env.PRIVATE_DB.batch(statements);
  return {
    batch_id: batchId,
    recorded: statements.length,
    individual_pending: items.results.filter(
      (i) =>
        needsIndividual(rows.find((r) => r.obs_id === i.obs_id)!.record) &&
        !priorDecisions.results.some(
          (r) => r.item_number === i.item_number && r.decision !== 'hold',
        ) &&
        !decisions.some((d) => d.item_number === i.item_number && d.decision !== 'hold'),
    ).length,
  };
}
