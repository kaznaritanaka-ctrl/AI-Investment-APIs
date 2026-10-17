import { z } from 'zod';
import { fetchBounded, FetchFailure, type NetworkOptions } from '../network';
import { errorCode, hash, isoTime, stable } from '../util';
import { parseElectricity, researchRequest } from './electricity';
import { isPublicGpu, researchTable } from './public-gpu-contract';
import { PublicGpuPageSchema, parsePublicGpu, gpuRecordFingerprint } from './public-gpu-html';
import { fetchPublicGpuPage, gpuReviewErrors } from './public-gpu-network';
import {
  assertResearchAllowed,
  assertResearchHistoryAllowed,
  ResearchPageSchema,
  validateQuery,
  type ResearchConfig,
  type ResearchQuery,
} from './schema';
import {
  assertNotRevoked,
  assessResearchRetention,
  auditRetentionDecision,
  capturedRetention,
  deletionObligation,
  historyExpiry,
  plusDays,
  recordDeletion,
  retentionSnapshot,
  revokeResearchSource,
  runDeletionKey,
  saveResearchConfigVersion,
  sourceRevocation,
  type RetainedRun,
} from './retention';

export type ResearchEnv = {
  PRIVATE_DB: D1Database;
  EVIDENCE: R2Bucket;
  ENVIRONMENT: 'test' | 'development' | 'production';
};
type Options = Omit<NetworkOptions, 'onBody' | 'validators'> & {
  current_terms_version: string;
  allow_network?: boolean;
  // Test data cannot reach a development or production store.
  synthetic_text?: string;
};
const envelopeSchema = z
  .object({
    version: z.enum(['electricity-projection-v1', 'domestic-gpu-projection-v1']),
    config_hash: z.string(),
    query_hash: z.string(),
    source_id: z.string(),
    source_policy_version: z.string(),
    terms_version: z.string(),
    method_version: z.string(),
    observed_at: z.iso.datetime(),
    synthetic: z.boolean(),
    payload_hash: z.string(),
    page: z.union([ResearchPageSchema, PublicGpuPageSchema]),
  })
  .strict();
function localOnly(env: ResearchEnv) {
  // Deliberately not a deployed entrypoint. Production integration is a separate review.
  if (env.ENVIRONMENT === 'production') throw new Error('research_production_not_integrated');
}
function standardAuthorityOnly(run: RetainedRun) {
  if (
    run.retention_snapshot_json &&
    JSON.parse(run.retention_snapshot_json).version === 'personal-retention-v1'
  )
    throw new Error('personal_entrypoint_required');
}
async function checkCurrent(
  env: ResearchEnv,
  config: ResearchConfig,
  digest: string,
  opt: Options,
  acquisition = true,
) {
  (acquisition ? assertResearchAllowed : assertResearchHistoryAllowed)(
    config,
    (opt.now ?? (() => new Date().toISOString()))(),
    opt.current_terms_version,
  );
  const row = await env.PRIVATE_DB.prepare(
    'SELECT config_hash,suspended FROM research_sources WHERE source_id=?',
  )
    .bind(config.source.source_id)
    .first<{ config_hash: string; suspended: number }>();
  if (!row || row.config_hash !== digest || row.suspended)
    throw new Error('research_policy_changed');
  await assertNotRevoked(env, config.source.source_id);
  if (acquisition && isPublicGpu(config.adapter)) {
    const blocked = await env.PRIVATE_DB.prepare(
      'SELECT last_error FROM research_runs WHERE source_id=? AND config_hash=? AND last_error IN (' +
        gpuReviewErrors.map(() => '?').join(',') +
        ') LIMIT 1',
    )
      .bind(config.source.source_id, digest, ...gpuReviewErrors)
      .first();
    if (blocked) throw new Error('public_gpu_source_review_required');
  }
}
export async function collectResearchPage(
  env: ResearchEnv,
  config: ResearchConfig,
  input: ResearchQuery,
  scheduled: string,
  opt: Options,
) {
  localOnly(env);
  const now = opt.now ?? (() => new Date().toISOString()),
    at = now();
  assertResearchAllowed(config, at, opt.current_terms_version);
  const table = researchTable(config.adapter),
    gpu = isPublicGpu(config.adapter);
  if (
    !isoTime(scheduled) ||
    !isoTime(at) ||
    scheduled > at ||
    Date.parse(at) - Date.parse(scheduled) > 21600000
  )
    throw new Error('research_capture_window_expired');
  const fixtureBody = opt.synthetic_text !== undefined;
  const synthetic = fixtureBody || opt.fetcher !== undefined;
  if ((synthetic || opt.fetcher) && env.ENVIRONMENT !== 'test')
    throw new Error('research_synthetic_boundary');
  const query = validateQuery(config, input),
    configHash = await hash(stable(config)),
    queryHash = await hash(stable(query)),
    source = config.source;
  const runId = await hash(
    stable([source.source_id, source.policy.version, scheduled, queryHash, synthetic]),
  );
  await assertNotRevoked(env, source.source_id, runId);
  // Local explicit registration; a changed config cannot silently replace the accepted version.
  await env.PRIVATE_DB.prepare(
    'INSERT OR IGNORE INTO research_sources(source_id,policy_version,config_hash) VALUES (?,?,?)',
  )
    .bind(source.source_id, source.policy.version, configHash)
    .run();
  await checkCurrent(env, config, configHash, opt);
  if (gpu) {
    const cooldown = await env.PRIVATE_DB.prepare(
      'SELECT MAX(retry_at) retry_at FROM research_runs WHERE source_id=?',
    )
      .bind(source.source_id)
      .first<{ retry_at: string | null }>();
    if (cooldown?.retry_at && cooldown.retry_at > at) return { run_id: runId, state: 'deferred' };
  }
  await saveResearchConfigVersion(env, config, configHash, at);
  const retention = retentionSnapshot(config);
  await env.PRIVATE_DB.prepare(
    "INSERT OR IGNORE INTO research_runs(run_id,source_id,config_hash,query_hash,policy_version,terms_version,scheduled_for,recorded_at,synthetic,state,next_page,evidence_expires_at,normalized_expires_at,retention_snapshot_json,all_copies_expires_at,normalized_mode) VALUES (?,?,?,?,?,?,?,?,?,'collecting',0,?,?,?,?,?)",
  )
    .bind(
      runId,
      source.source_id,
      configHash,
      queryHash,
      source.policy.version,
      config.terms.version,
      scheduled,
      at,
      Number(synthetic),
      plusDays(at, config.retention.evidence_days),
      retention.normalized_days === null ? null : plusDays(at, retention.normalized_days),
      stable(retention),
      retention.normalized_days === null
        ? null
        : plusDays(at, retention.normalized_days + retention.backup_days),
      retention.normalized_mode,
    )
    .run();
  const run = await env.PRIVATE_DB.prepare(
    'SELECT state,next_page,retry_at,config_hash,retention_snapshot_json FROM research_runs WHERE run_id=?',
  )
    .bind(runId)
    .first<{
      state: string;
      next_page: number | null;
      retry_at: string | null;
      config_hash: string;
      retention_snapshot_json: string | null;
    }>();
  if (!run) throw new Error('research_scope_changed_or_daily_limit');
  if (run.config_hash !== configHash) throw new Error('research_policy_changed');
  if (!run.retention_snapshot_json) throw new Error('historical_retention_unreviewed');
  if (run.state === 'complete' || run.next_page === null)
    return { run_id: runId, state: run.state };
  if (run.retry_at && at < run.retry_at) return { run_id: runId, state: 'deferred' };
  const lease = crypto.randomUUID(),
    pageNumber = run.next_page;
  const lock = await env.PRIVATE_DB.prepare(
    "UPDATE research_runs SET lease_token=?,lease_until=? WHERE run_id=? AND state IN ('collecting','partial') AND (lease_until IS NULL OR lease_until<=?)",
  )
    .bind(lease, new Date(Date.parse(at) + 300000).toISOString(), runId, at)
    .run();
  if (!lock.meta.changes) return { run_id: runId, state: 'leased' };
  const key = 'research/' + source.source_id + '/' + runId + '/' + pageNumber + '.json';
  try {
    let stored = await env.EVIDENCE.get(key),
      encoded: string;
    if (stored) {
      if (stored.size > 131072) throw new Error('research_evidence_too_large');
      encoded = await stored.text();
    } else {
      let text: string, observed: string;
      if (fixtureBody) {
        text = opt.synthetic_text!;
        observed = now();
      } else {
        if (!opt.allow_network) throw new Error('research_network_opt_in_required');
        const plan = gpu ? null : researchRequest(config, query, pageNumber);
        const boundedFetcher: typeof fetch = async (url, init) => {
          await checkCurrent(env, config, configHash, opt);
          const budget = await env.PRIVATE_DB.prepare(
            'UPDATE research_runs SET http_page_attempts=http_page_attempts+1 WHERE run_id=? AND next_page=? AND lease_token=? AND lease_until>? AND http_page_attempts<3',
          )
            .bind(runId, pageNumber, lease, now())
            .run();
          if (!budget.meta.changes) throw new FetchFailure('research_request_budget_exhausted');
          return (opt.fetcher ?? fetch)(url, init);
        };
        const network = {
          ...opt,
          fetcher: boundedFetcher,
          onBody: undefined,
          validators: undefined,
        };
        const r = gpu
          ? await fetchPublicGpuPage(config, network)
          : await fetchBounded(
              source,
              plan!,
              network,
              config.adapter === 'jepx_spot' ? 'csv' : 'json',
            );
        if (r.status !== 200) throw new Error('research_unexpected_status');
        text = r.text;
        observed = r.observed_at;
      }
      const page = gpu
        ? await parsePublicGpu(config, text, observed, synthetic)
        : parseElectricity(config, query, text, pageNumber);
      if (page.records.length > config.limits.page_size) throw new Error('research_page_limit');
      encoded = stable(
        envelopeSchema.parse({
          version: gpu ? 'domestic-gpu-projection-v1' : 'electricity-projection-v1',
          config_hash: configHash,
          query_hash: queryHash,
          source_id: source.source_id,
          source_policy_version: source.policy.version,
          terms_version: config.terms.version,
          method_version: config.method_version,
          observed_at: observed,
          synthetic,
          payload_hash: await hash(text),
          page,
        }),
      );
      if (new TextEncoder().encode(encoded).length > 131072)
        throw new Error('research_evidence_too_large');
      await checkCurrent(env, config, configHash, opt);
      const written = await env.EVIDENCE.put(key, encoded, {
        onlyIf: { etagDoesNotMatch: '*' },
        httpMetadata: { contentType: 'application/json' },
      });
      if (!written) {
        stored = await env.EVIDENCE.get(key);
        if (!stored || stored.size > 131072) throw new Error('research_evidence_missing');
        encoded = await stored.text();
      }
    }
    const e = envelopeSchema.parse(JSON.parse(encoded)),
      page = e.page;
    if (
      e.config_hash !== configHash ||
      e.version !== (gpu ? 'domestic-gpu-projection-v1' : 'electricity-projection-v1') ||
      e.query_hash !== queryHash ||
      page.page !== pageNumber ||
      e.source_id !== source.source_id ||
      e.source_policy_version !== source.policy.version ||
      e.terms_version !== config.terms.version ||
      e.method_version !== config.method_version ||
      e.synthetic !== synthetic ||
      e.observed_at < scheduled ||
      e.observed_at > now()
    )
      throw new Error('research_evidence_mismatch');
    (gpu ? PublicGpuPageSchema : ResearchPageSchema).parse(page);
    if (plusDays(e.observed_at, config.retention.evidence_days) <= now())
      throw new Error('research_evidence_expired');
    const previousPages = await env.PRIVATE_DB.prepare(
      'SELECT reported_total FROM research_pages WHERE run_id=? AND page_number<?',
    )
      .bind(runId, pageNumber)
      .all<{ reported_total: number | null }>();
    if (
      previousPages.results.length !== pageNumber ||
      previousPages.results.some((p) => p.reported_total !== page.reported_total)
    )
      throw new Error('research_coverage_changed');
    const previousKeys = await env.PRIVATE_DB.prepare(
      `SELECT record_key FROM ${table} WHERE run_id=? AND page_number<>?`,
    )
      .bind(runId, pageNumber)
      .all<{ record_key: string }>();
    const seen = new Set(previousKeys.results.map((r) => r.record_key));
    for (const r of page.records) {
      if (seen.has(r.record_key)) throw new Error('research_duplicate_record');
      seen.add(r.record_key);
    }
    const statements: D1PreparedStatement[] = [];
    const priorCutoff =
      retention.normalized_days === null
        ? null
        : plusDays(
            now(),
            -Math.min(
              retention.normalized_days,
              source.policy.retention_limit_days === null
                ? retention.normalized_days
                : source.policy.retention_limit_days - retention.backup_days,
            ),
          );
    const priorRecords = page.records.length
      ? await env.PRIVATE_DB.prepare(
          `SELECT * FROM (SELECT o.observation_id,o.record_hash,o.record_key,r.*,ROW_NUMBER() OVER(PARTITION BY o.record_key ORDER BY o.observed_at DESC,o.observation_id DESC) position FROM ${table} o JOIN research_runs r USING(run_id) JOIN research_sources s ON s.source_id=r.source_id WHERE r.source_id=? AND r.state='complete' AND r.synthetic=? AND s.suspended=0 AND (r.normalized_expires_at IS NULL OR r.normalized_expires_at>?) AND (? IS NULL OR r.recorded_at>?) AND r.retention_snapshot_json IS NOT NULL AND json_extract(r.retention_snapshot_json,'$.backup_days')>=? AND (r.all_copies_expires_at IS NULL OR r.all_copies_expires_at>?) AND r.config_hash IN (SELECT value FROM json_each(?)) AND o.observed_at<? AND o.record_key IN (` +
            page.records.map(() => '?').join(',') +
            ')) WHERE position=1',
        )
          .bind(
            source.source_id,
            Number(synthetic),
            now(),
            priorCutoff,
            priorCutoff,
            retention.time_travel_days,
            plusDays(now(), retention.time_travel_days),
            JSON.stringify([configHash, ...config.history_access.map((h) => h.config_hash)]),
            e.observed_at,
            ...page.records.map((r) => r.record_key),
          )
          .all<
            RetainedRun & {
              observation_id: string;
              record_hash: string;
              record_key: string;
              run_id: string;
            }
          >()
      : { results: [] };
    // Restored D1 rows cannot be used as lineage if an external deletion marker survives.
    const deletedPrior = new Set<string>();
    for (const priorRun of new Set(priorRecords.results.map((r) => r.run_id))) {
      if (await env.EVIDENCE.head(runDeletionKey(source.source_id, priorRun)))
        deletedPrior.add(priorRun);
    }
    for (const prior of priorRecords.results) {
      try {
        const expiry = historyExpiry(config, prior);
        if (expiry !== null && expiry <= now()) deletedPrior.add(prior.run_id);
      } catch {
        deletedPrior.add(prior.run_id);
      }
    }
    for (const record of page.records) {
      const fingerprint =
        'offer' in record ? await gpuRecordFingerprint(record) : await hash(stable(record));
      const prior = priorRecords.results.find(
        (r) => r.record_key === record.record_key && !deletedPrior.has(r.run_id),
      );
      statements.push(
        env.PRIVATE_DB.prepare(
          `INSERT OR IGNORE INTO ${table}(observation_id,run_id,page_number,record_key,source_url,method_version,observed_at,recorded_at,record_hash,previous_observation_id,change_kind,domain_json) SELECT ?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM research_runs WHERE run_id=? AND lease_token=? AND lease_until>?)`,
        ).bind(
          await hash(stable([runId, record.record_key, fingerprint])),
          runId,
          pageNumber,
          record.record_key,
          source.source_url,
          config.method_version,
          e.observed_at,
          now(),
          fingerprint,
          prior?.observation_id ?? null,
          !prior ? 'first_seen' : prior.record_hash === fingerprint ? 'reobserved' : 'revised',
          stable(record),
          runId,
          lease,
          now(),
        ),
      );
    }
    if (gpu && page.coverage === 'complete') {
      // Absence is relative to the last complete, same-scope snapshot, never a sale or stock zero.
      const previous = await env.PRIVATE_DB.prepare(
        "SELECT run_id FROM research_runs WHERE source_id=? AND query_hash=? AND synthetic=? AND state='complete' AND recorded_at<? AND config_hash=? ORDER BY recorded_at DESC LIMIT 1",
      )
        .bind(source.source_id, queryHash, Number(synthetic), e.observed_at, configHash)
        .first<{ run_id: string }>();
      if (previous) {
        const rows = (await readResearchRun(env, config, previous.run_id, opt)).results;
        const currentKeys = new Set(page.records.map((r) => r.record_key));
        for (const old of rows) {
          if (old.change_kind === 'not_seen' || currentKeys.has(String(old.record_key))) continue;
          const tombstone = stable({
            record_key: old.record_key,
            listing_state: 'not_seen',
            absence_basis: 'same_scope_complete_page',
            previous_observation_id: old.observation_id,
          });
          statements.push(
            env.PRIVATE_DB.prepare(
              `INSERT OR IGNORE INTO ${table}(observation_id,run_id,page_number,record_key,source_url,method_version,observed_at,recorded_at,record_hash,previous_observation_id,change_kind,domain_json) SELECT ?,?,?,?,?,?,?,?,?,?,'not_seen',? WHERE EXISTS(SELECT 1 FROM research_runs WHERE run_id=? AND lease_token=? AND lease_until>?)`,
            ).bind(
              await hash(stable([runId, old.record_key, 'not_seen'])),
              runId,
              0,
              old.record_key,
              source.source_url,
              config.method_version,
              e.observed_at,
              now(),
              await hash(tombstone),
              old.observation_id,
              tombstone,
              runId,
              lease,
              now(),
            ),
          );
        }
      }
    }
    // Bounded, resumable record batches. An interrupted page remains hidden until completed.
    for (let i = 0; i < statements.length; i += 20) {
      await checkCurrent(env, config, configHash, opt);
      await env.PRIVATE_DB.batch(statements.slice(i, i + 20));
    }
    const count = await env.PRIVATE_DB.prepare(
      `SELECT COUNT(*) n FROM ${table} WHERE run_id=? AND page_number=?`,
    )
      .bind(runId, pageNumber)
      .first<{ n: number }>();
    if (count?.n !== statements.length) throw new Error('research_checkpoint_mismatch');
    await checkCurrent(env, config, configHash, opt);
    const state = page.coverage === 'complete' && page.next_page === null ? 'complete' : 'partial';
    await env.PRIVATE_DB.batch([
      env.PRIVATE_DB.prepare(
        'INSERT OR IGNORE INTO research_pages(run_id,page_number,evidence_key,evidence_hash,observed_at,evidence_expires_at,reported_total,received_count,coverage) SELECT ?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM research_runs WHERE run_id=? AND lease_token=? AND lease_until>?)',
      ).bind(
        runId,
        pageNumber,
        key,
        await hash(encoded),
        e.observed_at,
        plusDays(e.observed_at, config.retention.evidence_days),
        page.reported_total,
        page.records.length,
        page.coverage,
        runId,
        lease,
        now(),
      ),
      env.PRIVATE_DB.prepare(
        `UPDATE research_runs SET state=?,next_page=?,http_page_attempts=${gpu ? 'http_page_attempts' : '0'},observation_count=(SELECT COUNT(*) FROM ${table} WHERE run_id=?),last_error=?,retry_at=NULL,lease_token=NULL,lease_until=NULL WHERE run_id=? AND lease_token=? AND lease_until>?`,
      ).bind(state, page.next_page, runId, page.reasons.join(',') || null, runId, lease, now()),
    ]);
    const result = await env.PRIVATE_DB.prepare(
      'SELECT state,next_page FROM research_runs WHERE run_id=?',
    )
      .bind(runId)
      .first<{ state: string; next_page: number | null }>();
    if (!result || result.next_page !== page.next_page || result.state !== state)
      throw new Error('research_lease_lost');
    return { run_id: runId, state };
  } catch (e) {
    const code = gpu && e instanceof z.ZodError ? 'public_gpu_schema_invalid' : errorCode(e);
    const retryAt =
      gpu && (e instanceof FetchFailure || (gpuReviewErrors as readonly string[]).includes(code))
        ? [plusDays(at, 1), e instanceof FetchFailure ? e.retry_at : null]
            .filter((v): v is string => v !== null)
            .sort()
            .at(-1)!
        : e instanceof FetchFailure
          ? e.retry_at
          : null;
    await env.PRIVATE_DB.prepare(
      "UPDATE research_runs SET state='partial',last_error=?,retry_at=?,lease_token=NULL,lease_until=NULL WHERE run_id=? AND lease_token=?",
    )
      .bind(code, retryAt, runId, lease)
      .run();
    throw new Error(code);
  }
}

export async function readResearchRun(
  env: ResearchEnv,
  config: ResearchConfig,
  runId: string,
  opt: Options,
) {
  localOnly(env);
  const configHash = await hash(stable(config));
  await checkCurrent(env, config, configHash, opt, false);
  // Current rights and expiry are rechecked after restore, not inferred from historical grants.
  const now = (opt.now ?? (() => new Date().toISOString()))();
  const run = await env.PRIVATE_DB.prepare(
    'SELECT * FROM research_runs WHERE run_id=? AND source_id=?',
  )
    .bind(runId, config.source.source_id)
    .first<RetainedRun>();
  if (!run || run.state !== 'complete') return { results: [] };
  standardAuthorityOnly(run);
  await assertNotRevoked(env, config.source.source_id, runId);
  if (
    run.config_hash !== configHash &&
    !config.history_access.some((h) => h.config_hash === run.config_hash)
  )
    throw new Error('research_history_scope_unreviewed');
  const expiry = historyExpiry(config, run);
  if (expiry !== null && expiry <= now) return { results: [] };
  return env.PRIVATE_DB.prepare(
    `SELECT * FROM ${researchTable(config.adapter)} WHERE run_id=? ORDER BY record_key LIMIT 192`,
  )
    .bind(runId)
    .all();
}

export async function purgeResearchRun(
  env: ResearchEnv,
  runId: string,
  now: string,
  cleanup: { time_travel_days: 7 | 30; revoke?: boolean; all_copies_deadline?: string | null },
) {
  localOnly(env);
  if (!isoTime(now)) throw new Error('invalid_retention_time');
  if (
    ![7, 30].includes(cleanup.time_travel_days) ||
    (cleanup.all_copies_deadline && !isoTime(cleanup.all_copies_deadline))
  )
    throw new Error('historical_backup_review_required');
  const r = await env.PRIVATE_DB.prepare('SELECT * FROM research_runs WHERE run_id=?')
    .bind(runId)
    .first<RetainedRun>();
  if (!r || r.state === 'purged') return;
  standardAuthorityOnly(r);
  const version = await env.PRIVATE_DB.prepare(
    'SELECT config_json FROM research_config_versions WHERE config_hash=?',
  )
    .bind(r.config_hash)
    .first<{ config_json: string }>();
  const table = researchTable(version ? JSON.parse(version.config_json).adapter : r.source_id);
  if (cleanup.revoke) await revokeResearchSource(env, r.source_id, now);
  if (r.lease_until && r.lease_until > now) throw new Error('research_retention_leased');
  const revoked = await sourceRevocation(env, r.source_id);
  let marked = await deletionObligation(env, r);
  if (!revoked && !marked && (r.normalized_expires_at === null || r.normalized_expires_at > now))
    throw new Error('research_retention_not_due');
  const capturedBackup = r.retention_snapshot_json ? capturedRetention(r).backup_days : null;
  const deadlines = [r.all_copies_expires_at, cleanup.all_copies_deadline ?? null];
  if (revoked && capturedBackup !== null)
    deadlines.push(plusDays(revoked.revoked_at, capturedBackup));
  if (marked)
    deadlines.push(
      marked.all_copies_delete_by ??
        (capturedBackup === null ? null : plusDays(marked.deleted_from, capturedBackup)),
    );
  const deadline = deadlines.filter((d): d is string => d !== null).sort()[0] ?? null;
  if (!marked) {
    await recordDeletion(env, r.source_id, runId, now, revoked ? 'revoked' : 'expired', {
      basis_refs: [revoked ? 'source_revocation' : 'captured_retention_deadline'],
      all_copies_delete_by: deadline,
    });
    marked = await deletionObligation(env, r);
    if (!marked) throw new Error('research_deletion_marker_missing');
  }
  const lock = await env.PRIVATE_DB.prepare(
    "UPDATE research_runs SET state='purging',next_page=NULL,lease_token=NULL,lease_until=NULL WHERE run_id=? AND (lease_until IS NULL OR lease_until<=?)",
  )
    .bind(runId, now)
    .run();
  if (!lock.meta.changes) throw new Error('research_retention_leased');
  // Include a captured page that never reached its D1 checkpoint.
  for (let page = 0; page < 4; page++)
    await env.EVIDENCE.delete('research/' + r.source_id + '/' + runId + '/' + page + '.json');
  await env.PRIVATE_DB.prepare(
    `DELETE FROM ${table} WHERE observation_id IN (SELECT observation_id FROM ${table} WHERE run_id=? LIMIT 20)`,
  )
    .bind(runId)
    .run();
  const remaining = await env.PRIVATE_DB.prepare(`SELECT COUNT(*) n FROM ${table} WHERE run_id=?`)
    .bind(runId)
    .first<{ n: number }>();
  if (!remaining?.n)
    await env.PRIVATE_DB.batch([
      env.PRIVATE_DB.prepare('DELETE FROM research_pages WHERE run_id=?').bind(runId),
      env.PRIVATE_DB.prepare(
        "UPDATE research_runs SET state='purged',last_error='retention_purged',deleted_at=?,backup_residual_until=? WHERE run_id=?",
      ).bind(now, plusDays(now, cleanup.time_travel_days), runId),
    ]);
  return {
    remaining: remaining?.n ?? 0,
    backup_residual_until: remaining?.n ? null : plusDays(now, cleanup.time_travel_days),
    backup_deadline_missed:
      !r.retention_snapshot_json || !deadline || plusDays(now, cleanup.time_travel_days) > deadline,
  };
}

// One run / at most 20 records. A restore or future continuation must iterate this before reopening.
// No historical permissions or database restore are performed by this local function.
export async function reconcileResearchRun(
  env: ResearchEnv,
  config: ResearchConfig,
  runId: string,
  now: string,
  currentTerms: string,
) {
  localOnly(env);
  if (!isoTime(now)) throw new Error('invalid_retention_time');
  const registration = await env.PRIVATE_DB.prepare(
    'SELECT config_hash,suspended FROM research_sources WHERE source_id=?',
  )
    .bind(config.source.source_id)
    .first<{ config_hash: string; suspended: number }>();
  const currentHash = await hash(stable(config));
  if (registration?.config_hash !== currentHash) throw new Error('research_policy_changed');
  const run = await env.PRIVATE_DB.prepare(
    'SELECT * FROM research_runs WHERE source_id=? AND run_id=?',
  )
    .bind(config.source.source_id, runId)
    .first<RetainedRun>();
  if (!run || run.state === 'purged') return;
  standardAuthorityOnly(run);
  if (config.retention.time_travel_days === null)
    throw new Error('historical_backup_review_required');
  const historyApproved =
    run.config_hash === currentHash ||
    config.history_access.some((h) => h.config_hash === run.config_hash);
  const decision = assessResearchRetention(config, run, now, currentTerms, historyApproved);
  const revoked = await sourceRevocation(env, run.source_id);
  const marked = await deletionObligation(env, run);
  if (revoked || marked) {
    decision.state = 'delete_required';
    decision.storage = 'prohibited';
    decision.next_action = 'delete';
    decision.collection_allowed = false;
    decision.read_allowed = false;
    decision.reasons.push(revoked ? 'source_revoked' : 'explicit_deletion_marker');
    const backup = run.retention_snapshot_json ? capturedRetention(run).backup_days : null;
    const markerDeadline =
      marked?.all_copies_delete_by ??
      (marked && backup !== null ? plusDays(marked.deleted_from, backup) : null);
    const revocationDeadline =
      revoked && backup !== null ? plusDays(revoked.revoked_at, backup) : null;
    decision.all_copies_deadline =
      [decision.all_copies_deadline, markerDeadline, revocationDeadline]
        .filter((d): d is string => d !== null)
        .sort()[0] ?? null;
    decision.basis_refs.push(
      ...(marked?.basis_refs ?? []),
      ...(revoked ? ['source_revocation'] : []),
    );
  } else if (registration.suspended && decision.next_action !== 'delete') {
    decision.state = 'rights_unknown';
    decision.next_action = 'review_rights';
    decision.collection_allowed = false;
    decision.read_allowed = false;
    decision.reasons.push('source_suspended_pending_review');
  }
  await auditRetentionDecision(env, config, run, now, currentTerms, decision);
  if (decision.next_action === 'delete') {
    if (!revoked && !marked)
      await recordDeletion(
        env,
        run.source_id,
        runId,
        now,
        decision.state === 'retention_expired'
          ? 'expired'
          : decision.reasons.includes('approved_storage_review_hold_ended')
            ? 'storage_review_hold_ended'
            : 'storage_right_ended',
        { basis_refs: decision.basis_refs, all_copies_delete_by: decision.all_copies_deadline },
      );
    const result = await purgeResearchRun(env, runId, now, {
      time_travel_days: config.retention.time_travel_days,
      all_copies_deadline: decision.all_copies_deadline,
    });
    return { ...result, decision };
  }
  // A shorter evidence permission must apply independently of the longer normalized history.
  if (
    run.evidence_expires_at <= now ||
    plusDays(run.recorded_at, config.retention.evidence_days) <= now
  ) {
    if (run.lease_until && run.lease_until > now) throw new Error('research_retention_leased');
    await eraseRunEvidence(env, run.source_id, run.run_id, now);
  }
  return { remaining: null, backup_residual_until: null, backup_deadline_missed: false, decision };
}

async function eraseRunEvidence(env: ResearchEnv, sourceId: string, runId: string, now: string) {
  // Idempotent even when an R2 restore reintroduced a page after its D1 deletion checkpoint.
  for (let page = 0; page < 4; page++)
    await env.EVIDENCE.delete('research/' + sourceId + '/' + runId + '/' + page + '.json');
  await env.PRIVATE_DB.batch([
    env.PRIVATE_DB.prepare('UPDATE research_pages SET evidence_deleted_at=? WHERE run_id=?').bind(
      now,
      runId,
    ),
    env.PRIVATE_DB.prepare('UPDATE research_runs SET evidence_purged_at=? WHERE run_id=?').bind(
      now,
      runId,
    ),
  ]);
}

export async function purgeResearchEvidence(env: ResearchEnv, now: string) {
  localOnly(env);
  if (!isoTime(now)) throw new Error('invalid_retention_time');
  const runs = await env.PRIVATE_DB.prepare(
    "SELECT source_id,run_id FROM research_runs WHERE json_extract(retention_snapshot_json,'$.version') IS NOT 'personal-retention-v1' AND evidence_expires_at<=? AND evidence_purged_at IS NULL AND (lease_until IS NULL OR lease_until<=?) ORDER BY evidence_expires_at LIMIT 5",
  )
    .bind(now, now)
    .all<{ source_id: string; run_id: string }>();
  for (const r of runs.results) await eraseRunEvidence(env, r.source_id, r.run_id, now);
}
