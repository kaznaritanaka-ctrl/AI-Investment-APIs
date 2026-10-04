import { z } from 'zod';
import type { Source, CollectorEnv } from './schema';
import { assertPersistenceAllowed } from './policy';
import { hash, stable, isoTime } from './util';
import {
  captureModelFields,
  captureECB,
  classifyFailure,
  recoveryRights,
  recoveryPolicyHash,
  diagnosticCodes,
  type DriftStage,
} from './schema-drift';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const DiagnosticSchema = z
  .object({
    code: z.enum(diagnosticCodes),
    path: z
      .string()
      .max(110)
      .regex(
        /^\$(?:\.(?:provider|models|\*|id|canonical_model_id|limit|context|input|output|modalities|reasoning|tool_call|structured_output|attachment|temperature|release_date|last_updated|status|cost|cache_read|cache_write|input_audio|output_audio|tiers|tier|experimental|modes|currency|unit|basis|price_basis|contract_type|sku|region|pagination))*$/,
      ),
    expected: z.enum([
      'json_object',
      'object',
      'provider_map',
      'complete_catalog',
      'reviewed_contract',
      'reviewed_type_or_enum',
      'known_component',
      'context_threshold',
      'bounded_array',
      'reviewed_basis',
      'matching_provider_object',
      'within_reviewed_limit',
      'matching_model_id',
      'bounded_modes',
      'mode_object',
      'within_previous_count_bounds',
    ]),
    actual: z.enum([
      'missing',
      'null',
      'array',
      'object',
      'string',
      'number',
      'boolean',
      'invalid_json',
      'invalid',
      'data',
      'catalog',
      'result',
      'metadata_present',
      'unreviewed_field',
      'unretained_field',
      'unreviewed',
      'limit_exceeded',
      'abrupt_change',
      'ambiguous_root',
    ]),
    severity: z.enum(['info', 'block']),
  })
  .strict();
export const IncidentSchema = z
  .object({
    schema_version: z.literal(1),
    source_id: z.string().regex(/^[a-z0-9_-]+$/),
    run_id: digest,
    detected_at: z.iso.datetime(),
    observed_at: z.iso.datetime().nullable(),
    stage: z.enum(['http', 'body', 'projection', 'parser', 'private_store', 'publication']),
    classification: z.enum([
      'authentication',
      'rate_limit',
      'transport',
      'response_contract',
      'storage_or_publication',
      'schema_drift',
      'unclassified',
    ]),
    schema_drift: z.boolean(),
    evidence_state: z.enum([
      'preserved',
      'partial',
      'metadata_only',
      'not_captured',
      'unavailable',
    ]),
    evidence_ref: z
      .string()
      .regex(/^evidence\/[a-z0-9_-]+\/[a-f0-9]{64}\.quarantine\.json$/)
      .nullable(),
    evidence_hash: digest.nullable(),
    expires_at: z.iso.datetime().nullable(),
    diagnostic_codes: z.array(z.enum(diagnosticCodes)).max(64),
    repair_status: z.literal('not_started'),
  })
  .strict();
export type RecoveryIncident = z.infer<typeof IncidentSchema>;
export const QuarantineSchema = z
  .object({
    format: z.literal('quarantine_evidence_v1'),
    source_id: z.string().regex(/^[a-z0-9_-]+$/),
    run_id: digest,
    policy_version: z.string().min(1).max(180),
    policy_hash: digest,
    observed_at: z.iso.datetime(),
    expires_at: z.iso.datetime(),
    synthetic: z.boolean(),
    purpose: z.literal('recovery_only_never_public'),
    raw_response: z.boolean(),
    source_payload_hash: digest,
    body: z.string().nullable(),
    body_hash: digest,
    wrapper: z.enum(['data', 'catalog', 'result']).nullable(),
    complete_projection: z.boolean(),
    record_count: z.number().int().nonnegative().nullable(),
    diagnostics: z.array(DiagnosticSchema).max(64),
  })
  .strict();
export type QuarantineEvidence = z.infer<typeof QuarantineSchema>;
export class SchemaDriftFailure extends Error {
  constructor() {
    super('schema_drift_detected');
  }
}
export const quarantineKey = (s: Source, run: string) =>
  'evidence/' + s.source_id + '/' + run + '.quarantine.json';
export async function validateQuarantine(
  s: Source,
  input: unknown,
  now: string,
  environment: string,
) {
  const parsed = QuarantineSchema.safeParse(input);
  if (!parsed.success) throw new Error('quarantine_integrity_failure');
  const e = parsed.data;
  if (
    e.format !== 'quarantine_evidence_v1' ||
    e.source_id !== s.source_id ||
    !/^[a-f0-9]{64}$/.test(e.run_id) ||
    e.policy_version !== s.policy.version ||
    e.policy_hash !== (await recoveryPolicyHash(s)) ||
    e.body_hash !== (await hash(e.body ?? '')) ||
    e.purpose !== 'recovery_only_never_public'
  )
    throw new Error('quarantine_integrity_failure');
  const rights = recoveryRights(s, now);
  if (
    !rights.minimal_projection ||
    !isoTime(e.observed_at) ||
    !isoTime(e.expires_at) ||
    e.observed_at > now ||
    e.expires_at <= now ||
    e.expires_at !==
      new Date(Date.parse(e.observed_at) + rights.retention_days! * 86400000).toISOString() ||
    e.raw_response !== rights.raw_response
  )
    throw new Error('quarantine_policy_or_time_blocked');
  if (e.synthetic && environment !== 'test') throw new Error('synthetic_data_blocked');
  if (new TextEncoder().encode(e.body ?? '').byteLength > s.max_bytes * 2)
    throw new Error('quarantine_size_invalid');
  if (s.models && e.body !== null) {
    const check = captureModelFields(e.body, s);
    if (check.body !== e.body || check.wrapper !== e.wrapper)
      throw new Error('quarantine_field_scope_mismatch');
  }
  return e;
}

// Retrying registration uses the original capture time and expiry, never now + retention.
async function register(env: CollectorEnv, s: Source, e: QuarantineEvidence) {
  await env.PRIVATE_DB.prepare(
    'INSERT OR IGNORE INTO raw_artifacts(artifact_ref,source_id,run_id,observed_at,payload_hash,evidence_hash,bytes,expires_at) VALUES(?,?,?,?,?,?,?,?)',
  )
    .bind(
      quarantineKey(s, e.run_id),
      s.source_id,
      e.run_id,
      e.observed_at,
      e.source_payload_hash,
      e.body_hash,
      new TextEncoder().encode(stable(e)).byteLength,
      e.expires_at,
    )
    .run();
}
export async function loadRecoveryEvidence(
  env: CollectorEnv,
  s: Source,
  run: string,
  now: string,
  registerExpiry = false,
) {
  const saved = await env.EVIDENCE.get(quarantineKey(s, run));
  if (!saved) return null;
  const e = await validateQuarantine(s, await saved.json(), now, env.ENVIRONMENT);
  if (e.run_id !== run) throw new Error('quarantine_run_mismatch');
  if (registerExpiry) {
    await assertPersistenceAllowed(env, s, now);
    await register(env, s, e);
  }
  return e;
}

// Fixed first-response key is deliberately distinct from normal evidence. It can
// never be consumed by normal replay or overwrite observations/publication.
export async function preserveRecoveryEvidence(
  env: CollectorEnv,
  s: Source,
  run: string,
  text: string,
  observed: string,
  now: string,
  synthetic = false,
) {
  if (env.SCHEMA_RECOVERY_ENABLED !== 'true') return null;
  await assertPersistenceAllowed(env, s, now);
  if (synthetic && env.ENVIRONMENT !== 'test') throw new Error('synthetic_data_blocked');
  const rights = recoveryRights(s, now);
  if (!rights.minimal_projection) return null;
  if (new TextEncoder().encode(text).byteLength > s.max_bytes)
    throw new Error('response_too_large');
  const key = quarantineKey(s, run);
  const saved = await loadRecoveryEvidence(env, s, run, now, true);
  if (saved) return saved;
  const previous = await env.PRIVATE_DB.prepare('SELECT last_count FROM sources WHERE source_id=?')
    .bind(s.source_id)
    .first<{ last_count: number | null }>();
  const capture = s.models
    ? captureModelFields(text, s, previous?.last_count ?? null)
    : captureECB(text);
  const envelope = {
    format: 'quarantine_evidence_v1',
    source_id: s.source_id,
    run_id: run,
    policy_version: s.policy.version,
    policy_hash: await recoveryPolicyHash(s),
    observed_at: observed,
    expires_at: new Date(Date.parse(observed) + rights.retention_days! * 86400000).toISOString(),
    synthetic,
    purpose: 'recovery_only_never_public',
    raw_response: rights.raw_response,
    source_payload_hash: await hash(text),
    body: capture.body,
    body_hash: await hash(capture.body ?? ''),
    wrapper: capture.wrapper,
    complete_projection: capture.complete,
    record_count: capture.record_count,
    diagnostics: capture.diagnostics,
  };
  const approved = await validateQuarantine(s, envelope, now, env.ENVIRONMENT);
  await assertPersistenceAllowed(env, s, now);
  await env.EVIDENCE.put(key, stable(approved), {
    onlyIf: { etagDoesNotMatch: '*' },
    httpMetadata: { contentType: 'application/json' },
  });
  const canonical = await env.EVIDENCE.get(key);
  if (!canonical) throw new Error('quarantine_write_failed');
  const e = await validateQuarantine(
    s,
    await canonical.json<QuarantineEvidence>(),
    now,
    env.ENVIRONMENT,
  );
  if (e.run_id !== run) throw new Error('quarantine_run_mismatch');
  await register(env, s, e);
  return e;
}

export async function recordRecoveryFailure(
  env: CollectorEnv,
  s: Source,
  run: string,
  lease: string,
  now: string,
  stage: DriftStage,
  code: string,
  e: QuarantineEvidence | null,
) {
  if (env.SCHEMA_RECOVERY_ENABLED !== 'true') return null;
  const classification = classifyFailure(code, stage);
  const incident = IncidentSchema.parse({
    schema_version: 1,
    source_id: s.source_id,
    run_id: run,
    detected_at: now,
    observed_at: e?.observed_at ?? null,
    stage,
    classification,
    schema_drift:
      classification === 'schema_drift' || !!e?.diagnostics.some((d) => d.severity === 'block'),
    evidence_state: e
      ? e.body === null
        ? 'metadata_only'
        : e.complete_projection
          ? 'preserved'
          : 'partial'
      : 'not_captured',
    evidence_ref: e ? quarantineKey(s, run) : null,
    evidence_hash: e?.body_hash ?? null,
    expires_at: e?.expires_at ?? null,
    diagnostic_codes: e?.diagnostics.length
      ? [...new Set(e.diagnostics.map((d) => d.code))]
      : ['contract_failure'],
    repair_status: 'not_started',
  });
  // Compare-and-set the active run lease. Diagnostic failures never release or
  // mutate a successor's lease and never turn an ingestion failure into success.
  await env.PRIVATE_DB.prepare(
    "UPDATE collection_runs SET metrics_json=json_set(COALESCE(metrics_json,'{}'),'$.recovery',CASE WHEN json_extract(metrics_json,'$.recovery.schema_drift')=1 THEN json_extract(metrics_json,'$.recovery') ELSE json(?) END) WHERE run_id=? AND source_id=? AND lease_token=? AND lease_until>?",
  )
    .bind(stable(incident), run, s.source_id, lease, now)
    .run();
  return incident;
}

export function incidentFromMetrics(
  metrics: unknown,
  run: string,
  source: string,
): RecoveryIncident | null {
  try {
    const parsed = IncidentSchema.safeParse(JSON.parse(String(metrics)).recovery);
    return parsed.success && parsed.data.run_id === run && parsed.data.source_id === source
      ? parsed.data
      : null;
  } catch {
    return null;
  }
}
