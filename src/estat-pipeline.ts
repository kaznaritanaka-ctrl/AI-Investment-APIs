import type { CollectorEnv, Source } from './schema';
import type { CollectOptions, RunResult } from './pipeline';
import {
  estatConfigurationHash,
  estatDue,
  estatRequest,
  parseEstatList,
  newestEstatTables,
  parseEstatData,
  type EstatPage,
  type EstatTable,
} from './estat';
import { storeEstatRow, expireEstat } from './estat-store';
import { assertPersistenceAllowed, canCollect, canPublish } from './policy';
import { syncSource } from './publication';
import { collectionIdentity } from './run-identity';
import { hash, stable, isoTime } from './util';
import { safeAttemptCode, type SourceObserver, observe, emitLog } from './telemetry';

type Intake = {
  configuration_hash: string;
  phase: string;
  list_start: number;
  list_pages: number;
  tables_json: string;
  table_index: number;
  data_start: number;
  data_pages: number;
  row_index: number;
  page_ref: string | null;
  page_hash: string | null;
  page_next: number | null;
  schema_signature: string | null;
  request_reserved: number;
  publication_batch: string;
};
type PageEnvelope = {
  version: 1;
  run_id: string;
  configuration_hash: string;
  page: EstatPage;
  response_sha256: string;
  fetched_at: string;
  request_url: string;
  expires_at: string;
  synthetic: boolean;
};
const logFailure = (
  code: 'estat_resume_failed' | 'estat_schema_unavailable' | 'estat_cleanup_failed',
) =>
  emitLog({
    phase: 'estat_failure',
    state: 'failed',
    error_code: code,
  });
const plusDays = (at: string, days: number) =>
  new Date(Date.parse(at) + days * 86400000).toISOString();
const failures = new Set([
  'estat_request_failed',
  'estat_pagination_incomplete',
  'estat_pagination_invalid',
  'estat_selected_table_missing',
  'estat_table_ambiguous',
  'estat_page_limit',
  'estat_request_interrupted',
  'estat_evidence_invalid',
  'estat_schema_changed',
  'estat_schema_invalid',
  'estat_table_mismatch',
  'estat_dimensions_unknown',
  'estat_classification_unknown',
  'estat_measure_unknown',
  'estat_period_invalid',
  'estat_decimal_invalid',
  'estat_base_year_unknown',
  'estat_duplicate_value',
  'estat_scope_changed',
  'policy_blocked',
  'source_suspended_or_policy_changed',
  'estat_page_too_large',
  'estat_survey_year_missing',
]);
export async function collectEstat(
  env: CollectorEnv,
  s: Source,
  scheduled: string,
  opt: CollectOptions = {},
): Promise<RunResult> {
  const clock = opt.now ?? (() => new Date().toISOString());
  const now = clock();
  let run = await hash(s.source_id + '|' + scheduled);
  const base = () => ({
    source_id: s.source_id,
    run_id: run,
    logical_slot: scheduled,
    run_kind: 'collection' as const,
  });
  if (!isoTime(scheduled) || scheduled > now)
    return { ...base(), state: 'failed', reason: 'invalid_schedule' };
  if (env.ESTAT_ENABLED !== 'true')
    return { ...base(), state: 'policy_skipped', reason: 'estat_disabled' };
  if (!env.ESTAT_APP_ID?.trim())
    return { ...base(), state: 'policy_skipped', reason: 'estat_app_id_missing' };
  if (!canCollect(s, now)) return { ...base(), state: 'policy_skipped', reason: 'policy_blocked' };
  if (!estatDue(s, scheduled))
    return { ...base(), state: 'policy_skipped', reason: 'estat_not_due' };
  if (opt.synthetic && env.ENVIRONMENT !== 'test')
    return { ...base(), state: 'failed', reason: 'synthetic_data_blocked' };
  let lease: string | undefined;
  try {
    // The daily logical slot is shared with the existing Collector. A UTC-day lookup additionally
    // prevents duplicate intake when an invocation is retried with different seconds/minutes.
    const day = scheduled.slice(0, 10),
      end = plusDays(day + 'T00:00:00.000Z', 1);
    const daily = await env.PRIVATE_DB.prepare(
      'SELECT scheduled_for FROM collection_runs WHERE source_id=? AND scheduled_for>=? AND scheduled_for<? ORDER BY scheduled_for LIMIT 1',
    )
      .bind(s.source_id, day + 'T00:00:00.000Z', end)
      .first<{ scheduled_for: string }>();
    const identity = await collectionIdentity(
      env.PRIVATE_DB,
      s.source_id,
      daily?.scheduled_for ?? scheduled,
    );
    run = identity.run_id;
    scheduled = identity.storedSlot;
    await syncSource(env, s, now);
    await assertPersistenceAllowed(env, s, now);
    const config = await estatConfigurationHash(s),
      batch = await hash(run + '|estat-v1|' + config);
    await env.PRIVATE_DB.prepare(
      "INSERT OR IGNORE INTO collection_runs(run_id,source_id,scheduled_for,state) VALUES (?,?,?,'pending')",
    )
      .bind(run, s.source_id, scheduled)
      .run();
    const state = await env.PRIVATE_DB.prepare(
      'SELECT state,observation_count,accepted_count FROM collection_runs WHERE run_id=?',
    )
      .bind(run)
      .first<{ state: string; observation_count: number; accepted_count: number }>();
    if (state && ['complete', 'quarantined', 'failed'].includes(state.state))
      return { ...base(), state: state.state, reason: 'already_processed' };
    lease = crypto.randomUUID();
    const claimed = await env.PRIVATE_DB.prepare(
      'UPDATE collection_runs SET lease_token=?,lease_until=?,started_at=COALESCE(started_at,?) WHERE run_id=? AND (lease_until IS NULL OR lease_until<?)',
    )
      .bind(lease, new Date(Date.parse(now) + 120000).toISOString(), now, run, now)
      .run();
    if (!claimed.meta.changes) return { ...base(), state: 'in_progress' };
    await env.PRIVATE_DB.prepare(
      "INSERT OR IGNORE INTO sc_intakes(run_id,configuration_hash,phase,publication_batch) VALUES (?,?,'list',?)",
    )
      .bind(run, config, batch)
      .run();
    const intake = (await env.PRIVATE_DB.prepare('SELECT * FROM sc_intakes WHERE run_id=?')
      .bind(run)
      .first<Intake>())!;
    if (intake.configuration_hash !== config) throw new Error('estat_scope_changed');
    if (intake.request_reserved) throw new Error('estat_request_interrupted');
    await env.PUBLIC_DB.prepare(
      "INSERT OR IGNORE INTO publication_batches VALUES (?,?,?,'staging',?,NULL)",
    )
      .bind(batch, s.source_id, s.policy.version, now)
      .run();
    const request = async (
      method: 'getStatsList' | 'getStatsData',
      params: Record<string, string>,
    ) => {
      if (opt.savedOnly) throw new Error('estat_request_interrupted');
      await assertPersistenceAllowed(env, s, clock());
      await env.PRIVATE_DB.prepare('UPDATE sc_intakes SET request_reserved=1 WHERE run_id=?')
        .bind(run)
        .run();
      return estatRequest(s, env, method, params, {
        ...opt.network,
        now: clock,
        onAttempt: async (a) => {
          await env.PRIVATE_DB.prepare(
            'INSERT INTO fetch_attempts(run_id,attempt,started_at,status,code,duration_ms) VALUES (?,?,?,?,?,?)',
          )
            .bind(
              run,
              a.attempt,
              a.started_at,
              a.status,
              safeAttemptCode(a.code, a.status),
              a.duration_ms,
            )
            .run();
          await opt.network?.onAttempt?.(a);
        },
      });
    };
    if (intake.phase === 'list') {
      if (intake.list_pages >= s.estat!.max_list_pages) throw new Error('estat_page_limit');
      const response = await request('getStatsList', {
        statsCode: s.estat!.stats_code,
        searchWord: s.estat!.release_kind === 'annual' ? '年報 時系列表' : '品目別 季節調整済',
        limit: String(Math.min(s.estat!.page_size, 100)),
        startPosition: String(intake.list_start),
      });
      const result = parseEstatList(s, response.body, intake.list_start);
      const tables: EstatTable[] = [...JSON.parse(intake.tables_json), ...result.tables];
      if (new Set(tables.map((t) => t.table_id)).size !== tables.length)
        throw new Error('estat_table_ambiguous');
      await assertPersistenceAllowed(env, s, clock());
      await env.PRIVATE_DB.prepare(
        'UPDATE sc_intakes SET tables_json=?,list_start=?,list_pages=list_pages+1,phase=?,request_reserved=0 WHERE run_id=?',
      )
        .bind(
          stable(result.next ? tables : newestEstatTables(s, tables)),
          result.next ?? 1,
          result.next ? 'list' : 'data',
          run,
        )
        .run();
    } else if (intake.phase === 'data') {
      if (intake.data_pages >= s.estat!.max_data_pages) throw new Error('estat_page_limit');
      const table: EstatTable = JSON.parse(intake.tables_json)[intake.table_index];
      const response = await request('getStatsData', {
        statsDataId: table.table_id,
        limit: String(s.estat!.page_size),
        startPosition: String(intake.data_start),
        metaGetFlg: 'Y',
      });
      const page = await parseEstatData(s, table, response.body, intake.data_start);
      const previous = await env.PRIVATE_DB.prepare(
        'SELECT schema_signature FROM sc_schema_history WHERE source_id=? AND table_group=?',
      )
        .bind(s.source_id, table.group)
        .first<{ schema_signature: string }>();
      const reviewed = s.estat!.reviewed_schema_signatures.includes(page.schema_signature);
      if (
        (intake.schema_signature && intake.schema_signature !== page.schema_signature) ||
        (!reviewed &&
          ((s.estat!.release_kind === 'annual' && table.year >= 2026) ||
            (previous && previous.schema_signature !== page.schema_signature)))
      )
        throw new Error('estat_schema_changed');
      await assertPersistenceAllowed(env, s, clock());
      const artifact =
        'evidence/' +
        s.source_id +
        '/' +
        run +
        '-' +
        intake.table_index +
        '-' +
        intake.data_start +
        '.json';
      const envelope: PageEnvelope = {
        version: 1,
        run_id: run,
        configuration_hash: config,
        page,
        response_sha256: response.response_sha256,
        fetched_at: response.fetched_at,
        request_url: response.request_url,
        expires_at: plusDays(response.fetched_at, s.policy.retention_days),
        synthetic: !!opt.synthetic,
      };
      const body = stable(envelope),
        evidenceHash = await hash(body);
      // Only normalized, credential-masked projection is retained, never the raw response.
      await env.EVIDENCE.put(artifact, body, {
        customMetadata: { source_id: s.source_id, expires_at: envelope.expires_at },
      });
      await env.PRIVATE_DB.batch([
        env.PRIVATE_DB.prepare(
          'INSERT OR IGNORE INTO raw_artifacts(artifact_ref,source_id,run_id,observed_at,payload_hash,evidence_hash,bytes,expires_at) VALUES (?,?,?,?,?,?,?,?)',
        ).bind(
          artifact,
          s.source_id,
          run,
          response.fetched_at,
          response.response_sha256,
          evidenceHash,
          new TextEncoder().encode(body).byteLength,
          envelope.expires_at,
        ),
        env.PRIVATE_DB.prepare('INSERT OR IGNORE INTO sc_schema_history VALUES (?,?,?,?)').bind(
          s.source_id,
          table.group,
          page.schema_signature,
          run,
        ),
        env.PRIVATE_DB.prepare(
          "UPDATE sc_intakes SET phase='rows',row_index=0,page_ref=?,page_hash=?,page_next=?,schema_signature=?,request_reserved=0 WHERE run_id=?",
        ).bind(artifact, evidenceHash, page.next, page.schema_signature, run),
      ]);
    } else if (intake.phase === 'rows') {
      const object = intake.page_ref && (await env.EVIDENCE.get(intake.page_ref));
      if (!object) throw new Error('estat_evidence_invalid');
      const body = await object.text();
      if ((await hash(body)) !== intake.page_hash) throw new Error('estat_evidence_invalid');
      const saved: PageEnvelope = JSON.parse(body);
      if (
        saved.version !== 1 ||
        saved.run_id !== run ||
        saved.configuration_hash !== config ||
        saved.expires_at <= clock() ||
        (saved.synthetic && env.ENVIRONMENT !== 'test')
      )
        throw new Error('estat_evidence_invalid');
      const rows = saved.page.rows.slice(intake.row_index, intake.row_index + 10);
      let changes = 0;
      for (const row of rows)
        changes += (
          await storeEstatRow(
            env,
            s,
            run,
            batch,
            saved.page,
            row,
            saved.response_sha256,
            saved.fetched_at,
            clock(),
            saved.synthetic,
          )
        ).changes;
      const offset = intake.row_index + rows.length;
      if (offset < saved.page.rows.length)
        await env.PRIVATE_DB.prepare('UPDATE sc_intakes SET row_index=? WHERE run_id=?')
          .bind(offset, run)
          .run();
      else {
        const nextTable = intake.page_next ? intake.table_index : intake.table_index + 1;
        const finished = nextTable >= JSON.parse(intake.tables_json).length;
        if (finished) {
          await assertPersistenceAllowed(env, s, clock());
          if (canPublish(s, clock()))
            await env.PUBLIC_DB.prepare(
              "UPDATE publication_batches SET state='complete',completed_at=? WHERE batch_id=? AND state='staging'",
            )
              .bind(clock(), batch)
              .run();
        }
        await env.PRIVATE_DB.prepare(
          'UPDATE sc_intakes SET phase=?,table_index=?,data_start=?,data_pages=?,row_index=0,page_ref=NULL,page_hash=NULL,schema_signature=? WHERE run_id=?',
        )
          .bind(
            finished ? 'complete' : 'data',
            nextTable,
            intake.page_next ?? 1,
            intake.page_next ? intake.data_pages + 1 : 0,
            intake.page_next ? intake.schema_signature : null,
            run,
          )
          .run();
        if (finished) {
          await finishRun(env, s, run, batch, clock());
          return {
            ...base(),
            state: 'complete',
            observations:
              (await env.PRIVATE_DB.prepare(
                'SELECT count(*) n FROM sc_observations WHERE batch_id=?',
              )
                .bind(batch)
                .first<number>('n')) ?? 0,
            changes,
          };
        }
      }
    } else if (intake.phase === 'complete') {
      await finishRun(env, s, run, batch, clock());
      return {
        ...base(),
        state: 'complete',
        observations:
          (await env.PRIVATE_DB.prepare('SELECT count(*) n FROM sc_observations WHERE batch_id=?')
            .bind(batch)
            .first<number>('n')) ?? 0,
      };
    }
    return { ...base(), state: 'pending' };
  } catch (error) {
    const reason =
      error instanceof Error && failures.has(error.message)
        ? error.message
        : 'estat_operation_failed';
    const quarantine =
      /schema|dimensions|classification|measure|period|decimal|base_year|duplicate/.test(reason);
    if (lease) {
      await env.PUBLIC_DB.prepare(
        "UPDATE publication_batches SET state='withdrawn' WHERE source_id=? AND batch_id=?",
      )
        .bind(s.source_id, await hash(run + '|estat-v1|' + (await estatConfigurationHash(s))))
        .run()
        .catch(() => logFailure('estat_cleanup_failed'));
      await env.PRIVATE_DB.prepare(
        'UPDATE collection_runs SET state=?,finished_at=?,error_code=? WHERE run_id=? AND lease_token=?',
      )
        .bind(quarantine ? 'quarantined' : 'failed', clock(), reason, run, lease)
        .run()
        .catch(() => logFailure('estat_cleanup_failed'));
      await env.PRIVATE_DB.prepare('UPDATE sc_intakes SET phase=? WHERE run_id=?')
        .bind(quarantine ? 'quarantined' : 'failed', run)
        .run()
        .catch(() => logFailure('estat_cleanup_failed'));
    }
    return { ...base(), state: quarantine ? 'quarantined' : 'failed', reason };
  } finally {
    if (lease)
      await env.PRIVATE_DB.prepare(
        'UPDATE collection_runs SET lease_token=NULL,lease_until=NULL WHERE run_id=? AND lease_token=?',
      )
        .bind(run, lease)
        .run()
        .catch(() => logFailure('estat_cleanup_failed'));
  }
}
async function finishRun(
  env: CollectorEnv,
  source: Source,
  run: string,
  batch: string,
  now: string,
) {
  await env.PRIVATE_DB.batch([
    env.PRIVATE_DB.prepare(
      "UPDATE collection_runs SET state='complete',finished_at=?,observation_count=(SELECT count(*) FROM sc_observations WHERE batch_id=?),accepted_count=(SELECT count(*) FROM sc_observations WHERE batch_id=?) WHERE run_id=?",
    ).bind(now, batch, batch, run),
    env.PRIVATE_DB.prepare('UPDATE sources SET last_success_at=? WHERE source_id=?').bind(
      now,
      source.source_id,
    ),
  ]);
}
export async function resumeEstat(
  env: CollectorEnv,
  sources: Source[],
  now: string,
  observer?: SourceObserver,
) {
  // Code deployment with unapplied migrations is inert for disabled sources and legacy collection.
  try {
    if (
      !(await env.PRIVATE_DB.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='sc_intakes'",
      ).first())
    )
      return { results: [], work: false };
    const publicTables = await env.PUBLIC_DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('sc_policy_versions','sc_observations','sc_definition_versions','sc_series','sc_revisions')",
    ).all();
    if (publicTables.results.length !== 5) {
      logFailure('estat_schema_unavailable');
      return { results: [], work: false };
    }
    if (await expireEstat(env, now)) return { results: [], work: true };
    if (env.ESTAT_ENABLED !== 'true') return { results: [], work: false };
    const row = await env.PRIVATE_DB.prepare(
      "SELECT c.run_id,c.source_id,c.scheduled_for FROM collection_runs c JOIN sc_intakes i ON c.run_id=i.run_id WHERE c.state='pending' AND (c.lease_until IS NULL OR c.lease_until<?) AND i.phase IN ('list','data','rows','complete') ORDER BY c.scheduled_for,c.source_id LIMIT 1",
    )
      .bind(now)
      .first<{ run_id: string; source_id: string; scheduled_for: string }>();
    const source = row && sources.find((s) => s.source_id === row.source_id && s.estat);
    const results =
      row && source
        ? [
            await observe(observer, source, row.scheduled_for, () =>
              collectEstat(env, source, row.scheduled_for, { now: () => now }),
            ),
          ]
        : [];
    if (row && results[0]?.state === 'policy_skipped') {
      // Early collection gates do not touch the checkpoint. Retire the pending run
      // with a fixed code so it cannot monopolize this queue or the GPU workload.
      await env.PRIVATE_DB.prepare(
        "UPDATE collection_runs SET state='failed',finished_at=?,error_code='estat_resume_skipped',lease_token=NULL,lease_until=NULL WHERE run_id=? AND state='pending' AND (lease_until IS NULL OR lease_until<?)",
      )
        .bind(now, row.run_id, now)
        .run();
      return { results, work: false };
    }
    return { results, work: results.length > 0 };
  } catch {
    logFailure('estat_resume_failed');
    return { results: [], work: true };
  }
}
