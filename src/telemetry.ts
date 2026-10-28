import type { CollectorEnv, Source } from './schema';
import type { RunResult } from './pipeline';
import { minuteSlot } from './run-identity';
import { visibleJoin, visibleSQL } from './publication';
import { PARSER_VERSION } from './ingest';
import { MODELS_PARSER } from './models';
import { gpuParser } from './gpu-store';

export const COLLECTOR_VERSION = 'collector-reliability-20260930.1';
export type ProcessKind = 'collection' | 'watchdog' | 'continuation';
export type SourceObserver = (
  source: Source,
  slot: string,
  work: () => Promise<RunResult>,
) => Promise<RunResult>;
export const observe = (
  observer: SourceObserver | undefined,
  s: Source,
  slot: string,
  work: () => Promise<RunResult>,
) => (observer ? observer(s, slot, work) : work());

// Never log arbitrary Error.message or arbitrary result properties, even if they look like a code.
const codes = new Set([
  'estat_disabled',
  'estat_resume_failed',
  'estat_schema_unavailable',
  'estat_cleanup_failed',
  'estat_app_id_missing',
  'estat_not_due',
  'estat_operation_failed',
  'estat_request_failed',
  'estat_request_interrupted',
  'estat_evidence_invalid',
  'estat_schema_changed',
  'estat_schema_invalid',
  'estat_page_limit',
  'estat_scope_changed',
  'operation_failed',
  'research_schema_unavailable',
  'highreso_os_unrecognized',
  'research_identity_link_conflict',
  'dc_schema_unavailable',
  'dc_robots_disallowed',
  'dc_robots_invalid',
  'dc_weekly_slot_required',
  'dc_tracker_live_scope_unreviewed',
  'dc_tracker_coverage_mismatch',
  'research_request_budget_exhausted',
  'research_config_version_invalid',
  'research_cursor_invalid',
  'research_collection_stopped',
  'research_policy_changed',
  'research_source_revoked',
  'research_review_required',
  'retention_review_required',
  'public_access_review_required',
  'terms_review_required',
  'historical_backup_review_required',
  'historical_retention_unreviewed',
  'research_evidence_delete_failed',
  'research_deletion_scope_invalid',
  'public_gpu_source_review_required',
  'public_gpu_robots_review_required',
  'public_gpu_terms_review_required',
  'research_retention_leased',
  'scheduled_run_missing',
  'incomplete_run',
  'already_processed',
  'policy_blocked',
  'source_suspended_or_policy_changed',
  'model_scope_changed',
  'model_scope_not_authorized',
  'collection_run_identity_mismatch',
  'invalid_schedule',
  'retry_after',
  'retryable_429',
  'retryable_5xx',
  'source_backoff',
  'price_of_compute_success_cache',
  'price_of_compute_reservation_failed',
  'price_of_compute_daily_request_limit',
  'timeout',
  'network_error',
  'attempts_exhausted',
  'authentication_not_configured',
  'endpoint_not_allowed',
  'redirect_blocked',
  'response_too_large',
  'unexpected_content_type',
  'empty_response',
  'saved_evidence_missing',
  'evidence_integrity_failure',
  'evidence_scope_mismatch',
  'evidence_retention_expired',
  'evidence_write_failed',
  'recovery_exhausted',
  'catalog_partial',
  'catalog_parse_error',
  'schema_drift_detected',
  'quarantine_reparse_review_required',
  'recovery_capture_failed',
  'attempt_log_failed',
  'invalid_decimal',
  'decimal_out_of_bounds',
]);
export function safeLogCode(code?: string) {
  if (!code) return null;
  return codes.has(code) || /^http_[45]\d{2}$/.test(code) ? code : 'operation_failed';
}
// Fetch outcomes include successful requests; error-only sanitization must not
// turn them into failures. Never infer success from an HTTP status by itself.
export function safeAttemptCode(code: string | undefined, status: number | null) {
  if (code === 'success')
    return status !== null && status >= 200 && status < 300 ? code : 'unknown';
  if (code === 'revalidated') return status === 304 ? code : 'unknown';
  if (!code) return 'unknown';
  return codes.has(code) || /^http_[45]\d{2}$/.test(code) ? code : 'unknown';
}
const states = new Set([
  'complete',
  'failed',
  'partial',
  'pending',
  'missing',
  'quarantined',
  'policy_skipped',
  'deferred',
  'in_progress',
  'circuit_open',
]);
const count = (n: number | undefined) =>
  n !== undefined && Number.isSafeInteger(n) && n >= 0 ? n : null;
export const newlyCompleted = (r: RunResult) =>
  r.state === 'complete' && r.reason !== 'already_processed' && r.observations !== undefined;
export const emitLog = (record: Record<string, unknown>) => console.log(JSON.stringify(record));

export function sourceObserver(
  env: CollectorEnv,
  process: ProcessKind,
  eventScheduledAt: string,
  sink = emitLog,
  clock = () => new Date().toISOString(),
  monotonic = () => performance.now(),
): SourceObserver {
  return async (source, slot, work) => {
    const start = monotonic(),
      started = clock();
    const base = {
      collector_version: COLLECTOR_VERSION,
      configured_parser_version: source.estat
        ? 'estat-v1'
        : source.models
          ? MODELS_PARSER
          : source.gpu
            ? gpuParser(source)
            : PARSER_VERSION,
      process_kind: process,
      run_kind: 'collection',
      source_id: source.source_id,
      logical_slot: minuteSlot(slot),
      event_scheduled_at: eventScheduledAt,
      started_at: started,
    };
    // A legacy run id is only known after the pipeline resolves its saved identity.
    sink({ ...base, phase: 'source_start', run_id: null });
    try {
      const result = await work();
      let published: number | null = null;
      let publicationMeasurement = 'not_measured';
      if (result.publication_batches?.length) {
        try {
          const measuredAt = clock();
          published = await env.PUBLIC_DB.prepare(
            'SELECT COUNT(*) n' +
              visibleJoin +
              'WHERE ' +
              visibleSQL +
              ' AND o.source_id=? AND o.batch_id IN (' +
              result.publication_batches.map(() => '?').join(',') +
              ')',
          )
            .bind(
              measuredAt,
              measuredAt,
              measuredAt,
              measuredAt,
              measuredAt,
              source.source_id,
              ...result.publication_batches,
            )
            .first<number>('n');
          publicationMeasurement = 'api_visible_rows_in_completed_batches';
        } catch {
          publicationMeasurement = 'measurement_failed';
        }
      }
      // stable() serializes stored summaries: omit absent optional fields entirely.
      const enriched = published === null ? result : { ...result, published };
      sink({
        ...base,
        phase: 'source_finish',
        run_id: /^[a-f0-9]{64}$/.test(result.run_id) ? result.run_id : null,
        logical_slot: result.logical_slot ?? base.logical_slot,
        state: states.has(result.state) ? result.state : 'failed',
        error_code: safeLogCode(result.reason),
        finished_at: clock(),
        elapsed_ms: Math.max(0, monotonic() - start),
        elapsed_scope: 'source_work_including_io_and_measurement',
        observation_count: count(result.observations),
        accepted_count: count(result.accepted),
        published_count: published,
        publication_measurement: publicationMeasurement,
        observation_completed_in_this_process: newlyCompleted(result),
      });
      return enriched;
    } catch (error) {
      sink({
        ...base,
        phase: 'source_finish',
        run_id: null,
        state: 'failed',
        error_code: 'operation_failed',
        finished_at: clock(),
        elapsed_ms: Math.max(0, monotonic() - start),
        elapsed_scope: 'source_work_including_io_and_measurement',
      });
      throw error;
    }
  };
}
