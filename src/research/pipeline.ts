import { z } from 'zod';
import { fetchBounded, FetchFailure, type NetworkOptions } from '../network';
import { errorCode, hash, isoTime, stable } from '../util';
import { parseElectricity, researchRequest } from './electricity';
import {
  assertResearchAllowed,
  ResearchPageSchema,
  validateQuery,
  type ResearchConfig,
  type ResearchQuery,
} from './schema';

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
    version: z.literal('electricity-projection-v1'),
    config_hash: z.string(),
    query_hash: z.string(),
    source_id: z.string(),
    source_policy_version: z.string(),
    terms_version: z.string(),
    method_version: z.string(),
    observed_at: z.iso.datetime(),
    synthetic: z.boolean(),
    payload_hash: z.string(),
    page: ResearchPageSchema,
  })
  .strict();
const plusDays = (now: string, days: number) =>
  new Date(Date.parse(now) + days * 86400000).toISOString();
function localOnly(env: ResearchEnv) {
  // Deliberately not a deployed entrypoint. Production integration is a separate review.
  if (env.ENVIRONMENT === 'production') throw new Error('research_production_not_integrated');
}
async function checkCurrent(
  env: ResearchEnv,
  config: ResearchConfig,
  digest: string,
  opt: Options,
) {
  assertResearchAllowed(
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
  // Local explicit registration; a changed config cannot silently replace the accepted version.
  await env.PRIVATE_DB.prepare(
    'INSERT OR IGNORE INTO research_sources(source_id,policy_version,config_hash) VALUES (?,?,?)',
  )
    .bind(source.source_id, source.policy.version, configHash)
    .run();
  await checkCurrent(env, config, configHash, opt);
  await env.PRIVATE_DB.prepare(
    "INSERT OR IGNORE INTO research_runs(run_id,source_id,config_hash,query_hash,policy_version,terms_version,scheduled_for,recorded_at,synthetic,state,next_page,evidence_expires_at,normalized_expires_at) VALUES (?,?,?,?,?,?,?,?,?,'collecting',0,?,?)",
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
      plusDays(at, config.retention.normalized_days),
    )
    .run();
  const run = await env.PRIVATE_DB.prepare(
    'SELECT state,next_page,retry_at,config_hash FROM research_runs WHERE run_id=?',
  )
    .bind(runId)
    .first<{
      state: string;
      next_page: number | null;
      retry_at: string | null;
      config_hash: string;
    }>();
  if (!run) throw new Error('research_scope_changed_or_daily_limit');
  if (run.config_hash !== configHash) throw new Error('research_policy_changed');
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
        const plan = researchRequest(config, query, pageNumber);
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
        const r = await fetchBounded(
          source,
          plan,
          { ...opt, fetcher: boundedFetcher, onBody: undefined, validators: undefined },
          config.adapter === 'jepx_spot' ? 'csv' : 'json',
        );
        if (r.status !== 200) throw new Error('research_unexpected_status');
        text = r.text;
        observed = r.observed_at;
      }
      const page = parseElectricity(config, query, text, pageNumber);
      if (page.records.length > config.limits.page_size) throw new Error('research_page_limit');
      encoded = stable(
        envelopeSchema.parse({
          version: 'electricity-projection-v1',
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
      'SELECT record_key FROM research_observations WHERE run_id=? AND page_number<>?',
    )
      .bind(runId, pageNumber)
      .all<{ record_key: string }>();
    const seen = new Set(previousKeys.results.map((r) => r.record_key));
    for (const r of page.records) {
      if (seen.has(r.record_key)) throw new Error('research_duplicate_record');
      seen.add(r.record_key);
    }
    const statements: D1PreparedStatement[] = [];
    const priorRecords = page.records.length
      ? await env.PRIVATE_DB.prepare(
          "SELECT observation_id,record_hash,record_key FROM (SELECT o.observation_id,o.record_hash,o.record_key,ROW_NUMBER() OVER(PARTITION BY o.record_key ORDER BY o.observed_at DESC,o.observation_id DESC) position FROM research_observations o JOIN research_runs r USING(run_id) JOIN research_sources s ON s.source_id=r.source_id WHERE r.source_id=? AND r.state='complete' AND r.synthetic=? AND s.suspended=0 AND r.normalized_expires_at>? AND o.observed_at<? AND o.record_key IN (" +
            page.records.map(() => '?').join(',') +
            ')) WHERE position=1',
        )
          .bind(
            source.source_id,
            Number(synthetic),
            now(),
            e.observed_at,
            ...page.records.map((r) => r.record_key),
          )
          .all<{ observation_id: string; record_hash: string; record_key: string }>()
      : { results: [] };
    for (const record of page.records) {
      const fingerprint = await hash(stable(record));
      const prior = priorRecords.results.find((r) => r.record_key === record.record_key);
      statements.push(
        env.PRIVATE_DB.prepare(
          'INSERT OR IGNORE INTO research_observations(observation_id,run_id,page_number,record_key,source_url,method_version,observed_at,recorded_at,record_hash,previous_observation_id,change_kind,domain_json) SELECT ?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM research_runs WHERE run_id=? AND lease_token=? AND lease_until>?)',
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
    // Bounded, resumable record batches. An interrupted page remains hidden until completed.
    for (let i = 0; i < statements.length; i += 20) {
      await checkCurrent(env, config, configHash, opt);
      await env.PRIVATE_DB.batch(statements.slice(i, i + 20));
    }
    const count = await env.PRIVATE_DB.prepare(
      'SELECT COUNT(*) n FROM research_observations WHERE run_id=? AND page_number=?',
    )
      .bind(runId, pageNumber)
      .first<{ n: number }>();
    if (count?.n !== page.records.length) throw new Error('research_checkpoint_mismatch');
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
        'UPDATE research_runs SET state=?,next_page=?,http_page_attempts=0,observation_count=(SELECT COUNT(*) FROM research_observations WHERE run_id=?),last_error=?,retry_at=NULL,lease_token=NULL,lease_until=NULL WHERE run_id=? AND lease_token=? AND lease_until>?',
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
    await env.PRIVATE_DB.prepare(
      "UPDATE research_runs SET state='partial',last_error=?,retry_at=?,lease_token=NULL,lease_until=NULL WHERE run_id=? AND lease_token=?",
    )
      .bind(errorCode(e), e instanceof FetchFailure ? e.retry_at : null, runId, lease)
      .run();
    throw new Error(errorCode(e));
  }
}

export async function readResearchRun(
  env: ResearchEnv,
  config: ResearchConfig,
  runId: string,
  opt: Options,
) {
  localOnly(env);
  await checkCurrent(env, config, await hash(stable(config)), opt);
  // Current rights and expiry are rechecked after restore, not inferred from historical grants.
  const now = (opt.now ?? (() => new Date().toISOString()))();
  return env.PRIVATE_DB.prepare(
    "SELECT o.* FROM research_observations o JOIN research_runs r USING(run_id) WHERE r.run_id=? AND r.source_id=? AND r.config_hash=? AND r.state='complete' AND r.normalized_expires_at>? ORDER BY o.record_key LIMIT 192",
  )
    .bind(runId, config.source.source_id, await hash(stable(config)), now)
    .all();
}

export async function purgeResearchRun(
  env: ResearchEnv,
  runId: string,
  now: string,
  revoke = false,
) {
  localOnly(env);
  if (!isoTime(now)) throw new Error('invalid_retention_time');
  const r = await env.PRIVATE_DB.prepare(
    'SELECT source_id,normalized_expires_at,state,lease_until FROM research_runs WHERE run_id=?',
  )
    .bind(runId)
    .first<{
      source_id: string;
      normalized_expires_at: string;
      state: string;
      lease_until: string | null;
    }>();
  if (!r || r.state === 'purged') return;
  if (r.lease_until && r.lease_until > now) throw new Error('research_retention_leased');
  if (!revoke && r.normalized_expires_at > now) throw new Error('research_retention_not_due');
  // Revocation suspends all reads/new collection for this source before deleting this run.
  if (revoke)
    await env.PRIVATE_DB.prepare('UPDATE research_sources SET suspended=1 WHERE source_id=?')
      .bind(r.source_id)
      .run();
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
    'DELETE FROM research_observations WHERE observation_id IN (SELECT observation_id FROM research_observations WHERE run_id=? LIMIT 20)',
  )
    .bind(runId)
    .run();
  const remaining = await env.PRIVATE_DB.prepare(
    'SELECT COUNT(*) n FROM research_observations WHERE run_id=?',
  )
    .bind(runId)
    .first<{ n: number }>();
  if (!remaining?.n)
    await env.PRIVATE_DB.batch([
      env.PRIVATE_DB.prepare('DELETE FROM research_pages WHERE run_id=?').bind(runId),
      env.PRIVATE_DB.prepare(
        "UPDATE research_runs SET state='purged',last_error='retention_purged' WHERE run_id=?",
      ).bind(runId),
    ]);
}

export async function purgeResearchEvidence(env: ResearchEnv, now: string) {
  localOnly(env);
  if (!isoTime(now)) throw new Error('invalid_retention_time');
  const runs = await env.PRIVATE_DB.prepare(
    'SELECT source_id,run_id FROM research_runs WHERE evidence_expires_at<=? AND evidence_purged_at IS NULL AND (lease_until IS NULL OR lease_until<=?) ORDER BY evidence_expires_at LIMIT 5',
  )
    .bind(now, now)
    .all<{ source_id: string; run_id: string }>();
  for (const r of runs.results) {
    // Also covers an R2 capture whose SQL checkpoint failed.
    for (let page = 0; page < 4; page++)
      await env.EVIDENCE.delete('research/' + r.source_id + '/' + r.run_id + '/' + page + '.json');
    await env.PRIVATE_DB.batch([
      env.PRIVATE_DB.prepare('UPDATE research_pages SET evidence_deleted_at=? WHERE run_id=?').bind(
        now,
        r.run_id,
      ),
      env.PRIVATE_DB.prepare('UPDATE research_runs SET evidence_purged_at=? WHERE run_id=?').bind(
        now,
        r.run_id,
      ),
    ]);
  }
}
