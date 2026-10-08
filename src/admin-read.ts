import { AdminQuery, AdminReport, AdminResource, ReleaseRecord } from './admin-contract';
import type {
  Query,
  Report,
  Resource,
  RunDTO,
  SourceDTO,
  PolicyDTO,
  FieldDTO,
} from './admin-contract';
import type { CollectorEnv, Source } from './schema';
import { PolicySchema, SourceSchema } from './schema';
import { sources as configuredSources } from './sources';
import { canCollect, canPublish, modelsAuthorizationReady, gpuAuthorizationReady } from './policy';
import { dailyCollectionSlot, minuteSlot } from './run-identity';
import { freshness } from './fx';
import { hash, stable, notificationEpoch } from './util';
import { safeLogCode, safeAttemptCode } from './telemetry';
import { MIT_NOTICE, visibleJoin, visibleSQL } from './publication';
import { readData } from './admin-read-data';
import { runRecovery } from './admin-recovery';
import { readGPUCollectionEvidence } from './operational-gpu';

export type Row = Record<string, unknown>;
export const obj = (v: unknown): Row => {
  if (typeof v === 'string') {
    try {
      return obj(JSON.parse(v));
    } catch {
      return {};
    }
  }
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Row) : {};
};
export const str = (v: unknown): string | null => (typeof v === 'string' ? v.slice(0, 2000) : null);
export const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
export const stamp = (v: unknown): string | null =>
  typeof v === 'string' && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null;
export const texts = (v: unknown): string[] =>
  Array.isArray(v)
    ? v
        .filter((x): x is string => typeof x === 'string')
        .slice(0, 100)
        .map((x) => x.slice(0, 2000))
    : [];
export const safeURL = (v: unknown) => {
  try {
    const u = new URL(String(v));
    return u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash
      ? u.href
      : null;
  } catch {
    return null;
  }
};
export const field = (name: string, value: unknown, unit: string | null = null): FieldDTO => ({
  name,
  value: typeof value === 'number' || typeof value === 'boolean' ? value : str(value),
  unit,
});
export async function rows(db: D1Database, sql: string, values: unknown[] = []): Promise<Row[]> {
  // Every call site supplies a fixed SELECT/WITH. This module deliberately has no write helper.
  if (
    !/^\s*(SELECT|WITH)\b/i.test(sql) ||
    /\b(INSERT|UPDATE|DELETE|REPLACE|ALTER|DROP|CREATE|PRAGMA|ATTACH)\b/i.test(sql)
  )
    throw new Error('admin_read_only');
  return (
    await db
      .prepare(sql)
      .bind(...values)
      .all<Row>()
  ).results;
}
export function publicationBlockers(s: Source, now: string): string[] {
  const out = (
    ['public_display', 'normalized_redistribution', 'commercial_redistribution'] as const
  )
    .filter((k) => s.policy.rights[k] !== 'allowed')
    .map((k) => k + '_not_allowed');
  if (!canPublish(s, now) && !out.length) out.push('publication_policy_gate');
  return out;
}
async function currentPublicPolicies(env: CollectorEnv, sources: Source[]) {
  const out = new Map<string, Row>();
  try {
    for (let offset = 0; offset < sources.length; offset += 40) {
      const chunk = sources.slice(offset, offset + 40);
      const found = await rows(
        env.PUBLIC_DB,
        'SELECT source_id,policy_version,active,revoked,valid_from,valid_until FROM source_publications WHERE ' +
          chunk.map(() => '(source_id=? AND policy_version=?)').join(' OR '),
        chunk.flatMap((s) => [s.source_id, s.policy.version]),
      );
      for (const r of found) out.set(String(r.source_id), r);
    }
    return out;
  } catch {
    return null;
  }
}
function publicStoreBlockers(s: Source, policies: Map<string, Row> | null, now: string) {
  if (!policies) return ['public_policy_unavailable'];
  const p = policies.get(s.source_id);
  if (!p) return ['public_policy_not_registered'];
  return [
    ...(p.active !== 1 ? ['public_policy_inactive'] : []),
    ...(p.revoked === 1 ? ['public_policy_revoked'] : []),
    ...(typeof p.valid_from === 'string' && p.valid_from > now
      ? ['public_policy_not_yet_valid']
      : []),
    ...(typeof p.valid_until === 'string' && p.valid_until <= now ? ['public_policy_expired'] : []),
  ];
}
export const unavailablePublication = (): RunDTO['publication'] => ({
  state: 'unavailable',
  original_count: null,
  derived_count: null,
  visible_count: null,
  completed_at: null,
});
export function internalReadAllowed(s: Source | undefined, stored: Row | undefined, now: string) {
  if (!s || !stored || stored.suspended || stored.policy_version !== s.policy.version) return false;
  const parsed = SourceSchema.safeParse(obj(stored.config_json));
  return (
    parsed.success &&
    stable(parsed.data) === stable(s) &&
    now >= s.policy.valid_from &&
    (!s.policy.valid_until || now < s.policy.valid_until) &&
    s.policy.rights.private_storage === 'allowed' &&
    s.policy.rights.internal_analysis === 'allowed' &&
    modelsAuthorizationReady(s) &&
    gpuAuthorizationReady(s)
  );
}
export function blockers(s: Source, stored: Row | undefined, now: string): string[] {
  const out: string[] = [];
  if (!s.enabled) out.push('source_disabled');
  if (s.adapter === 'candidate') out.push('adapter_not_available');
  if (now < s.policy.valid_from) out.push('policy_not_yet_valid');
  if (s.policy.valid_until && now >= s.policy.valid_until) out.push('policy_expired');
  if (!modelsAuthorizationReady(s) || !gpuAuthorizationReady(s))
    out.push('scope_or_retention_not_authorized');
  if (!stored) out.push('source_not_registered');
  else {
    if (stored.suspended) out.push('source_suspended');
    if (!stored.enabled && s.enabled) out.push('stored_source_disabled');
    const parsed = SourceSchema.safeParse(obj(stored.config_json));
    if (
      stored.policy_version !== s.policy.version ||
      !parsed.success ||
      stable(parsed.data) !== stable(s)
    )
      out.push('runtime_stored_config_mismatch');
    if (typeof stored.circuit_until === 'string' && stored.circuit_until > now)
      out.push('source_backoff');
  }
  for (const k of ['automated_collection', 'private_storage', 'internal_analysis'] as const)
    if (s.policy.rights[k] !== 'allowed') out.push(k + '_not_allowed');
  return out;
}
export function retention(s: Source): FieldDTO[] {
  const r = s.models?.retention ?? s.gpu?.retention;
  return r
    ? ['evidence_days', 'archive_days', 'normalized_days', 'backup_days'].map((k) =>
        field(k, obj(r)[k], 'days'),
      )
    : [
        field('evidence_days', s.policy.retention_days, 'days'),
        field('normalized_days', null, 'days'),
      ];
}
export async function pageContext(q: Query, resource: Resource, now: string) {
  let c: Row = {};
  if (q.cursor) {
    try {
      c = obj(JSON.parse(atob(q.cursor.replace(/-/g, '+').replace(/_/g, '/'))));
    } catch {
      throw new Error('invalid_cursor');
    }
  }
  const asOf = stamp(c.as_of ?? q.as_of ?? now);
  if (!asOf || asOf > now) throw new Error('invalid_query');
  const to = q.to && q.to < asOf ? q.to : asOf;
  const from = q.from ?? new Date(Date.parse(to) - 7 * 86400000).toISOString();
  if (from > to || Date.parse(to) - Date.parse(from) > 31 * 86400000)
    throw new Error('invalid_query');
  const fingerprint = await hash(
    stable({ ...q, cursor: undefined, as_of: asOf, from, to, resource }),
  );
  if (
    q.cursor &&
    (c.v !== 1 ||
      c.fingerprint !== fingerprint ||
      typeof c.after !== 'string' ||
      c.after.length > 500)
  )
    throw new Error('invalid_cursor');
  return {
    asOf,
    from,
    to,
    after: str(c.after),
    cursor: (after: string) =>
      btoa(JSON.stringify({ v: 1, as_of: asOf, fingerprint, after }))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, ''),
  };
}
export type PageContext = Awaited<ReturnType<typeof pageContext>>;
export const canonicalRunsSQL =
  "WITH ranked AS (SELECT r.*,substr(scheduled_for,1,16)||':00.000Z' logical_slot,ROW_NUMBER() OVER(PARTITION BY source_id,substr(scheduled_for,1,16) ORDER BY CASE state WHEN 'complete' THEN 0 WHEN 'quarantined' THEN 1 WHEN 'missing' THEN 3 ELSE 2 END,scheduled_for,run_id) priority FROM collection_runs r WHERE scheduled_for>=? AND scheduled_for<?) SELECT * FROM ranked WHERE priority=1";

export async function publicationForBatches(
  env: CollectorEnv,
  batchIds: string[],
  now: string,
  asOf = now,
): Promise<RunDTO['publication']> {
  if (!batchIds.length)
    return {
      state: 'not_published',
      original_count: 0,
      derived_count: 0,
      visible_count: 0,
      completed_at: null,
    };
  const ids = [...new Set(batchIds)].slice(0, 40),
    marks = ids.map(() => '?').join(',');
  const batches = await rows(
    env.PUBLIC_DB,
    'SELECT state,completed_at FROM publication_batches WHERE batch_id IN (' +
      marks +
      ') AND created_at<=?',
    [...ids, asOf],
  );
  const all = (
    await rows(
      env.PUBLIC_DB,
      'SELECT SUM(CASE WHEN derived=0 THEN 1 ELSE 0 END) originals,SUM(derived) derived FROM published_observations WHERE batch_id IN (' +
        marks +
        ') AND recorded_at<=?',
      [...ids, asOf],
    )
  )[0];
  const visible = (
    await rows(
      env.PUBLIC_DB,
      'SELECT COUNT(*) n' +
        visibleJoin +
        'WHERE ' +
        visibleSQL +
        ' AND o.batch_id IN (' +
        marks +
        ') AND b.completed_at<=? AND o.recorded_at<=?',
      [now, now, now, now, now, ...ids, asOf, asOf],
    )
  )[0];
  const original = num(all?.originals) ?? 0,
    derived = num(all?.derived) ?? 0,
    n = num(visible?.n) ?? 0;
  const completed = batches.filter(
    (b) => b.state === 'complete' && typeof b.completed_at === 'string' && b.completed_at <= asOf,
  );
  return {
    state: !batches.length
      ? 'not_published'
      : batches.some((b) => b.state === 'withdrawn')
        ? 'held'
        : completed.length !== batches.length
          ? 'staging'
          : n < original + derived
            ? 'held'
            : 'complete',
    original_count: original,
    derived_count: derived,
    visible_count: n,
    completed_at:
      completed
        .map((b) => stamp(b.completed_at))
        .filter((v): v is string => !!v)
        .sort()
        .at(-1) ?? null,
  };
}
export async function runDTO(
  env: CollectorEnv,
  r: Row,
  now: string,
  detail = false,
  asOf = now,
  currentSource = configuredSources.find((s) => s.source_id === r.source_id),
): Promise<RunDTO> {
  const id = String(r.run_id),
    source = String(r.source_id),
    scheduled = String(r.scheduled_for);
  const models = await rows(
    env.PRIVATE_DB,
    'SELECT snapshot_id,state,stage,observed_at,completed_at,model_count,price_count,component_count,quarantined_count FROM model_snapshots WHERE run_id=? AND recorded_at<=? ORDER BY recorded_at DESC LIMIT 20',
    [id, asOf],
  );
  const gpu = await rows(
    env.PRIVATE_DB,
    'SELECT snapshot_id,state,processing_stage,started_at,completed_at,received_count,next_page FROM gpu_snapshots WHERE run_id=? AND started_at<=? ORDER BY started_at DESC LIMIT 20',
    [id, asOf],
  );
  const versions = await rows(
    env.PRIVATE_DB,
    'SELECT DISTINCT parser_version,policy_version FROM observations WHERE run_id=? AND recorded_at<=? LIMIT 20',
    [id, asOf],
  );
  const batchIds = [...models, ...gpu].map((x) => String(x.snapshot_id));
  for (const v of versions)
    batchIds.push(await hash(id + '|' + v.parser_version + '|' + v.policy_version));
  let publication = unavailablePublication();
  try {
    publication = await publicationForBatches(env, batchIds, now, asOf);
  } catch {
    /* independent public store failure */
  }
  const laterProgress = [r.started_at, r.finished_at, r.last_progress_at].some(
    (v) => typeof v === 'string' && v > asOf,
  );
  const state = laterProgress ? 'unavailable_at_as_of' : String(r.state);
  const measured =
    ['complete', 'quarantined'].includes(state) ||
    (state === 'partial' && models.length > 0 && !!r.finished_at);
  if (publication.state === 'complete' && [...models, ...gpu].some((s) => s.state !== 'complete'))
    publication.state = 'held';
  const n = measured ? num(r.observation_count) : null,
    a = measured ? num(r.accepted_count) : null;
  const result: RunDTO = {
    run_id: id,
    canonical_run_id: id,
    source_id: source,
    logical_slot: minuteSlot(scheduled),
    scheduled_for: stamp(scheduled),
    state,
    started_at: stamp(r.started_at),
    finished_at: stamp(r.finished_at),
    last_progress_at: stamp(r.last_progress_at),
    observation_count: n,
    accepted_count: a,
    quarantined_count: n !== null && a !== null && n >= a ? n - a : null,
    error_code: safeLogCode(str(r.error_code) ?? undefined),
    recovery_count: num(r.recovery_count),
    next_attempt_at: stamp(r.next_attempt_at),
    publication,
    checkpoints: [
      ...models.map((m) => ({
        id: String(m.snapshot_id),
        kind: 'models',
        state: String(m.state),
        stage: str(m.stage),
        observed_at: stamp(m.observed_at),
        completed_at: stamp(m.completed_at),
        counts: ['model_count', 'price_count', 'component_count', 'quarantined_count'].map((k) =>
          field(k, m[k]),
        ),
      })),
      ...gpu.map((g) => ({
        id: String(g.snapshot_id),
        kind: 'gpu',
        state: String(g.state),
        stage: str(g.processing_stage),
        observed_at: stamp(g.started_at),
        completed_at: stamp(g.completed_at),
        counts: ['received_count', 'next_page'].map((k) => field(k, g[k])),
      })),
    ].slice(0, 20),
    attempts: [],
    invocations: [],
    details_truncated: models.length + gpu.length > 20,
  };
  // The run/checkpoint tables are mutable; never reconstruct an earlier success
  // from fields that were updated after the requested cut-off.
  if (laterProgress) {
    result.finished_at = null;
    result.last_progress_at = null;
    result.error_code = null;
    result.recovery_count = null;
    result.next_attempt_at = null;
    result.checkpoints = [];
    if (result.started_at && result.started_at > asOf) result.started_at = null;
  }
  if (currentSource?.source_id === 'price_of_compute') {
    result.capture_verified = null;
    // A private-only policy must be explicit and match the stored runtime config.
    // An unavailable public read or unexpected public rows never become N/A.
    const stored = (
      await rows(
        env.PRIVATE_DB,
        'SELECT source_id,policy_version,enabled,suspended,config_json FROM sources WHERE source_id=?',
        [source],
      )
    )[0];
    if (
      !laterProgress &&
      canCollect(currentSource, now) &&
      internalReadAllowed(currentSource, stored, now) &&
      stored?.enabled === 1
    ) {
      try {
        result.capture_verified = (
          await readGPUCollectionEvidence(env, currentSource, id, asOf, result)
        ).completeCapture;
      } catch {
        // The run's complete flag alone cannot prove the configured capture scope.
      }
      if (
        ['public_display', 'normalized_redistribution', 'commercial_redistribution'].every((key) =>
          ['review_required', 'denied'].includes(
            currentSource.policy.rights[key as keyof typeof currentSource.policy.rights],
          ),
        ) &&
        publication.state === 'not_published' &&
        publication.original_count === 0 &&
        publication.derived_count === 0 &&
        publication.visible_count === 0
      )
        publication.state = 'not_applicable';
    }
  }
  result.recovery = runRecovery(result, r.metrics_json, now, asOf);
  if (!detail) return result;
  const canonical = await rows(env.PRIVATE_DB, canonicalRunsSQL + ' AND source_id=?', [
    minuteSlot(scheduled),
    new Date(Date.parse(minuteSlot(scheduled)) + 60000).toISOString(),
    source,
  ]);
  result.canonical_run_id = String(canonical[0]?.run_id ?? id);
  const attempts = await rows(
    env.PRIVATE_DB,
    'SELECT attempt,started_at,status,code,duration_ms FROM fetch_attempts WHERE run_id=? AND started_at<=? ORDER BY id DESC LIMIT 101',
    [id, asOf],
  );
  result.attempts = attempts.slice(0, 100).map((x) => ({
    attempt: Number(x.attempt),
    started_at: stamp(x.started_at),
    status: num(x.status),
    code: safeAttemptCode(str(x.code) ?? undefined, num(x.status)),
    duration_ms: num(x.duration_ms),
  }));
  const summaries = await rows(
    env.PRIVATE_DB,
    "SELECT d.summary_id,d.recorded_at,d.summary_json,n.state notification_state,n.attempts,n.sent_at FROM daily_summaries d LEFT JOIN notification_outbox n ON n.notification_id=d.summary_id WHERE d.recorded_at>=? AND d.recorded_at<=? AND EXISTS(SELECT 1 FROM json_each(d.summary_json,'$.sources') x WHERE json_extract(x.value,'$.source_id')=? AND (json_extract(x.value,'$.run_id')=? OR json_extract(x.value,'$.logical_slot')=?)) ORDER BY d.recorded_at DESC LIMIT 101",
    [minuteSlot(scheduled), asOf, source, id, minuteSlot(scheduled)],
  );
  result.invocations = summaries.slice(0, 100).map((d) => {
    const summary = obj(d.summary_json);
    const entries = Array.isArray(summary.sources) ? summary.sources.map(obj) : [];
    const entry =
      entries.find(
        (x) =>
          x.source_id === source && (x.run_id === id || x.logical_slot === minuteSlot(scheduled)),
      ) ?? {};
    const kind = summary.process_kind;
    return {
      id: String(d.summary_id),
      kind:
        kind === 'collection' || kind === 'watchdog' || kind === 'continuation' ? kind : 'unknown',
      scheduled_at: stamp(summary.event_scheduled_at ?? summary.scheduled_for),
      recorded_at: stamp(d.recorded_at),
      state: str(entry.state) ?? 'unknown',
      reason: safeLogCode(str(entry.reason) ?? undefined),
      notification:
        d.notification_state === 'sent'
          ? 'sent'
          : texts(summary.setup_warnings).includes('notification_not_configured') &&
              !env.ALERT_WEBHOOK_URL
            ? 'not_configured'
            : d.notification_state === 'pending'
              ? Number(d.attempts) >= 3
                ? 'attempts_exhausted'
                : 'pending'
              : 'not_queued',
      attempts: num(d.attempts),
      sent_at: stamp(d.sent_at),
    };
  });
  result.details_truncated ||= attempts.length > 100 || summaries.length > 100;
  return result;
}

export async function sourceStatuses(
  env: CollectorEnv,
  sources: Source[],
  now: string,
  asOf = now,
): Promise<SourceDTO[]> {
  const publicPolicies = await currentPublicPolicies(env, sources);
  const stored = await rows(
    env.PRIVATE_DB,
    'SELECT source_id,policy_version,enabled,suspended,circuit_until,config_json FROM sources',
  );
  const out: SourceDTO[] = [];
  for (const s of sources.slice(0, 100)) {
    const db = stored.find((r) => r.source_id === s.source_id),
      stops = blockers(s, db, now);
    const latest = (
      await rows(
        env.PRIVATE_DB,
        "SELECT o.observed_at,json_extract(o.metadata_json,'$.source_date') source_date FROM observations o LEFT JOIN model_snapshots m ON m.snapshot_id=json_extract(o.metadata_json,'$.model_snapshot_id') LEFT JOIN gpu_snapshots g ON g.snapshot_id=json_extract(o.metadata_json,'$.snapshot_id') WHERE o.source_id=? AND o.observed_at<=? AND o.recorded_at<=? AND o.quality_status='accepted' AND json_extract(o.metadata_json,'$.data_origin')='live' AND (m.snapshot_id IS NULL OR (m.state='complete' AND m.completed_at<=? AND m.expires_at>?)) AND (g.snapshot_id IS NULL OR (g.state='complete' AND g.completed_at<=?)) ORDER BY o.observed_at DESC,o.recorded_at DESC LIMIT 1",
        [s.source_id, asOf, asOf, asOf, now, asOf],
      )
    )[0];
    const last = (
      await rows(
        env.PRIVATE_DB,
        "SELECT * FROM collection_runs WHERE source_id=? AND scheduled_for<=? ORDER BY substr(scheduled_for,1,16) DESC,CASE state WHEN 'complete' THEN 0 WHEN 'quarantined' THEN 1 WHEN 'missing' THEN 3 ELSE 2 END,scheduled_for,run_id LIMIT 1",
        [s.source_id, asOf],
      )
    )[0];
    const observed = stamp(latest?.observed_at);
    const age = observed
      ? freshness(observed, str(latest?.source_date), now, s.dataset_type)
      : null;
    const activation = notificationEpoch(env.NOTIFICATIONS_ACTIVE_FROM, now);
    const notification =
      activation && env.ALERT_WEBHOOK_URL
        ? (
            await rows(
              env.PRIVATE_DB,
              "SELECT n.attempts FROM notification_outbox n JOIN notification_incidents i ON i.activation_at=n.activation_at AND i.incident_key=n.incident_key AND i.last_event_id=n.notification_id WHERE n.activation_at=? AND n.state='pending' AND n.recorded_at<=? AND n.recorded_at>=? AND substr(n.incident_key,1,length(?)+1)=?||':' AND ((n.event_kind IN ('opened','reminder') AND i.active=1 AND i.last_condition='alert') OR (n.event_kind='recovered' AND i.active=0 AND i.last_condition='clear')) ORDER BY n.attempts DESC LIMIT 1",
              [
                activation,
                asOf,
                new Date(
                  Math.max(Date.parse(activation), Date.parse(now) - 86400000),
                ).toISOString(),
                s.source_id,
                s.source_id,
              ],
            )
          )[0]
        : null;
    out.push({
      source_id: s.source_id,
      name: s.operator,
      dataset: s.dataset_type,
      adapter_available: s.adapter !== 'candidate',
      enabled: s.enabled,
      registered: !!db,
      suspended: db ? !!db.suspended : null,
      collection_allowed: canCollect(s, now) && stops.length === 0,
      publication_allowed:
        canPublish(s, now) &&
        stops.length === 0 &&
        !publicStoreBlockers(s, publicPolicies, now).length,
      blockers: stops,
      latest_observed_at: observed,
      source_date: str(latest?.source_date),
      freshness: !s.enabled
        ? 'not_applicable'
        : !age
          ? 'unavailable'
          : age.stale
            ? 'stale'
            : 'healthy',
      freshness_reason:
        age?.stale_reason ?? (!observed && s.enabled ? 'no_live_observation' : null),
      last_run: last ? await runDTO(env, last, now, false, asOf, s) : null,
      source_url: safeURL(s.source_url),
      attribution: s.attribution_text,
      coverage: s.models ? s.models.providers.map((x) => x + '/*') : s.selection,
      limitations: s.known_limitations,
      policy_valid_until: s.policy.valid_until,
      publication_blockers: [
        ...publicationBlockers(s, now),
        ...publicStoreBlockers(s, publicPolicies, now),
      ],
      notification_problem: notification
        ? Number(notification.attempts) >= 3
          ? 'attempts_exhausted'
          : 'pending'
        : null,
    });
  }
  return out;
}
export function summarize(
  list: SourceDTO[],
  env: CollectorEnv,
  now: string,
  asOf = now,
): NonNullable<Report['overview']> {
  let slot: string | null = null;
  try {
    slot = dailyCollectionSlot(env.COLLECTION_CRON, Date.parse(asOf));
  } catch {
    /* unknown schedule */
  }
  const eligible = list.filter((s) => s.enabled && s.adapter_available);
  const measured = env.COLLECTION_ENABLED === 'true' && slot !== null;
  const attention: NonNullable<Report['overview']>['attention'] = [];
  for (const s of eligible) {
    const link = { source: s.source_id, run: s.last_run?.run_id ?? null };
    if (s.blockers.length)
      attention.push({
        id: s.source_id + ':blocked',
        severity: 'error',
        message: s.source_id + '：収集条件を確認 (' + s.blockers.join(', ') + ')',
        page: 'rights',
        ...link,
      });
    if (s.publication_blockers?.length && s.last_run?.publication.state !== 'not_applicable')
      attention.push({
        id: s.source_id + ':rights',
        severity: 'warning',
        message: s.source_id + '：公開権利の条件を確認 (' + s.publication_blockers.join(', ') + ')',
        page: 'rights',
        ...link,
      });
    if (
      s.policy_valid_until &&
      s.policy_valid_until > now &&
      Date.parse(s.policy_valid_until) - Date.parse(now) <= 30 * 86400000
    )
      attention.push({
        id: s.source_id + ':expiry',
        severity: 'warning',
        message:
          s.source_id +
          '：権利確認期限まで ' +
          Math.ceil((Date.parse(s.policy_valid_until) - Date.parse(now)) / 86400000) +
          ' 日',
        page: 'rights',
        ...link,
      });
    if (s.notification_problem)
      attention.push({
        id: s.source_id + ':notification',
        severity: s.notification_problem === 'attempts_exhausted' ? 'error' : 'warning',
        message: s.source_id + '：通知 ' + s.notification_problem,
        page: 'runs',
        ...link,
      });
    const run = s.last_run?.logical_slot === slot ? s.last_run : null;
    if (
      run?.state === 'complete' &&
      run.capture_verified !== undefined &&
      run.capture_verified !== true
    )
      attention.push({
        id: s.source_id + ':capture',
        severity: run.capture_verified === null ? 'unknown' : 'warning',
        message: s.source_id + '：取得範囲・snapshot・件数の整合を確認できません',
        page: 'runs',
        ...link,
      });
    if (!run)
      attention.push({
        id: s.source_id + ':unconfirmed',
        severity: 'unknown',
        message: s.source_id + '：直近予定枠の実行記録を確認できません',
        page: 'runs',
        ...link,
        run: null,
      });
    else if (!['complete', 'policy_skipped'].includes(run.state))
      attention.push({
        id: s.source_id + ':run',
        severity:
          run.state === 'unavailable_at_as_of'
            ? 'unknown'
            : ['failed', 'missing'].includes(run.state)
              ? 'error'
              : 'warning',
        message:
          s.source_id +
          (run.recovery?.schema_drift ? '：schema drift・障害詳細を確認' : '：収集 ' + run.state),
        page: 'runs',
        ...link,
      });
    if (
      run?.publication.state === 'held' ||
      run?.publication.state === 'unavailable' ||
      (run?.state === 'complete' && s.publication_allowed && run.publication.state !== 'complete')
    )
      attention.push({
        id: s.source_id + ':publication',
        severity: run.publication.state === 'unavailable' ? 'unknown' : 'warning',
        message: s.source_id + '：公開 ' + run.publication.state,
        page: 'data',
        ...link,
      });
    if (s.freshness !== 'healthy')
      attention.push({
        id: s.source_id + ':freshness',
        severity: s.freshness === 'unavailable' ? 'unknown' : 'warning',
        message: s.source_id + '：観測鮮度 ' + s.freshness,
        page: 'data',
        ...link,
      });
  }
  if (!measured)
    attention.push({
      id: 'schedule',
      severity: 'unknown',
      message: '収集の実効設定・予定枠を確認してください',
      page: 'settings',
      source: null,
      run: null,
    });
  attention.sort(
    (a, b) =>
      ['error', 'warning', 'unknown'].indexOf(a.severity) -
        ['error', 'warning', 'unknown'].indexOf(b.severity) || a.id.localeCompare(b.id),
  );
  const currentRuns = eligible.map((s) => (s.last_run?.logical_slot === slot ? s.last_run : null));
  const collectionKnown = currentRuns.every((r) => r && r.state !== 'unavailable_at_as_of');
  const publicationKnown = currentRuns.every((r) => r && r.publication.state !== 'unavailable');
  return {
    logical_slot: slot,
    expected: measured ? eligible.length : null,
    publication_expected:
      measured && publicationKnown
        ? currentRuns.filter((r) => r?.publication.state !== 'not_applicable').length
        : null,
    completed:
      measured && collectionKnown
        ? eligible.filter(
            (s) =>
              s.last_run?.logical_slot === slot &&
              s.last_run.state === 'complete' &&
              (s.last_run.capture_verified === undefined || s.last_run.capture_verified === true),
          ).length
        : null,
    published:
      measured && publicationKnown
        ? eligible.filter(
            (s) => s.last_run?.logical_slot === slot && s.last_run.publication.state === 'complete',
          ).length
        : null,
    fresh: eligible.some((s) => s.freshness === 'unavailable')
      ? null
      : eligible.filter((s) => s.freshness === 'healthy').length,
    checked_sources: eligible.length,
    attention,
    sources: list,
  };
}
function settingFields(s: Source): FieldDTO[] {
  return [
    field('enabled', s.enabled),
    field('policy_version', s.policy.version),
    field('adapter', s.adapter),
    field('scope', (s.models?.providers ?? s.selection).join(', ')),
    field('fields', s.policy.fields.join(', ')),
    ...retention(s),
  ];
}
export async function readAdmin(
  resourceInput: unknown,
  input: unknown,
  env: CollectorEnv,
  now = new Date().toISOString(),
  sources = configuredSources,
): Promise<Report> {
  const resource = AdminResource.parse(resourceInput),
    q = AdminQuery.parse(input);
  const page = await pageContext(q, resource, now);
  const report: Report = {
    schema_version: 'admin-read-v1',
    resource,
    fetched_at: now,
    as_of: page.asOf,
    state: 'ready',
    issues: [],
    next_cursor: null,
  };
  const selected = sources.filter((s) => !q.source || s.source_id === q.source);
  try {
    if (resource === 'overview' || resource === 'sources') {
      const status = await sourceStatuses(env, selected, now, page.asOf);
      if (status.some((s) => s.publication_blockers?.includes('public_policy_unavailable'))) {
        report.state = 'partial';
        report.issues.push('public_policy_unavailable');
      }
      if (resource === 'overview') report.overview = summarize(status, env, now, page.asOf);
      else report.sources = status;
    } else if (resource === 'runs') {
      const args: unknown[] = [page.from, new Date(Date.parse(page.to) + 1).toISOString()];
      let sql = canonicalRunsSQL;
      if (q.id || q.run) {
        sql = 'SELECT * FROM collection_runs WHERE run_id=? AND scheduled_for<=?';
        args.splice(0, args.length, q.id ?? q.run, page.asOf);
      }
      if (q.source) {
        sql += ' AND source_id=?';
        args.push(q.source);
      }
      if (q.state) {
        sql += ' AND state=?';
        args.push(q.state);
      }
      if (page.after) {
        sql += " AND (scheduled_for||'|'||run_id)<?";
        args.push(page.after);
      }
      const found = await rows(
        env.PRIVATE_DB,
        sql + ' ORDER BY scheduled_for DESC,run_id DESC LIMIT ?',
        [...args, q.limit + 1],
      );
      report.runs = [];
      for (let offset = 0; offset < Math.min(found.length, q.limit); offset += 4)
        report.runs.push(
          ...(await Promise.all(
            found.slice(offset, Math.min(offset + 4, q.limit)).map((r) =>
              runDTO(
                env,
                r,
                now,
                !!(q.id || q.run),
                page.asOf,
                sources.find((s) => s.source_id === r.source_id),
              ),
            ),
          )),
        );
      if (found.length > q.limit) {
        const r = found[q.limit - 1];
        report.next_cursor = page.cursor(r.scheduled_for + '|' + r.run_id);
      }
    } else if (resource === 'data') {
      const data = await readData(env, sources, q, page, now);
      Object.assign(report, data);
    } else if (resource === 'rights' || resource === 'settings') {
      const publicPolicies = await currentPublicPolicies(env, selected);
      if (!publicPolicies) {
        report.state = 'partial';
        report.issues.push('public_policy_unavailable');
      }
      const stored = await rows(
        env.PRIVATE_DB,
        'SELECT source_id,policy_version,enabled,suspended,config_json,circuit_until FROM sources',
      );
      if (resource === 'settings') {
        report.settings = [
          {
            source_id: null,
            name: 'Collector runtime',
            runtime: [
              field('collection_enabled', env.COLLECTION_ENABLED ?? null),
              field('collection_cron', env.COLLECTION_CRON ?? null),
              field('watchdog_cron', env.WATCHDOG_CRON ?? null),
              field('continuation_cron', env.GPU_RESUME_CRON ?? null),
              field('notification_configured', !!env.ALERT_WEBHOOK_URL),
              field(
                'notification_activation_at',
                notificationEpoch(env.NOTIFICATIONS_ACTIVE_FROM, now),
              ),
              field('agent_enabled', env.AGENT_ENABLED ?? null),
            ],
            stored: [],
            matches: null,
            blockers: !env.ALERT_WEBHOOK_URL
              ? ['notification_not_configured']
              : notificationEpoch(env.NOTIFICATIONS_ACTIVE_FROM, now)
                ? []
                : ['notification_activation_required'],
          },
        ];
        for (const s of selected) {
          const db = stored.find((x) => x.source_id === s.source_id),
            parsed = SourceSchema.safeParse(obj(db?.config_json));
          const runtime = settingFields(s);
          const keyPresence =
            s.adapter === 'lambda'
              ? !!env.LAMBDA_API_KEY
              : s.adapter === 'sakura_dok'
                ? !!env.SAKURA_ACCESS_TOKEN && !!env.SAKURA_ACCESS_SECRET
                : s.adapter === 'ebay_browse'
                  ? !!env.EBAY_CLIENT_ID && !!env.EBAY_CLIENT_SECRET
                  : null;
          if (s.authentication_required) runtime.push(field('credentials_configured', keyPresence));
          report.settings.push({
            source_id: s.source_id,
            name: s.operator,
            runtime,
            stored: parsed.success
              ? [
                  ...settingFields(parsed.data),
                  field('db_enabled', !!db?.enabled),
                  field('suspended', !!db?.suspended),
                  field('circuit_until', db?.circuit_until),
                ]
              : [],
            matches: db
              ? parsed.success && stable(parsed.data) === stable(s) && !!db.enabled === s.enabled
              : null,
            blockers: [
              ...blockers(s, db, now),
              ...publicStoreBlockers(s, publicPolicies, now),
              ...(s.enabled && keyPresence === false ? ['authentication_not_configured'] : []),
            ],
          });
        }
      } else {
        report.policies = [];
        for (const s of selected) {
          const db = stored.find((x) => x.source_id === s.source_id);
          const history = await rows(
            env.PRIVATE_DB,
            'SELECT version,policy_json,recorded_at FROM source_policy_versions WHERE source_id=? AND recorded_at<=? ORDER BY recorded_at DESC LIMIT 20',
            [s.source_id, page.asOf],
          );
          if (!history.some((x) => x.version === s.policy.version))
            history.unshift({
              version: s.policy.version,
              policy_json: stable(s.policy),
              recorded_at: null,
            });
          for (const h of history) {
            const parsed = PolicySchema.safeParse(obj(h.policy_json));
            if (!parsed.success) continue;
            const p = parsed.data,
              current = p.version === s.policy.version;
            const remaining = p.valid_until
              ? Math.ceil((Date.parse(p.valid_until) - Date.parse(now)) / 86400000)
              : null;
            const reasons = blockers(s, db, now),
              publicReasons = publicStoreBlockers(s, publicPolicies, now);
            const row: PolicyDTO = {
              source_id: s.source_id,
              version: p.version,
              current,
              runtime_matches: current && stable(p) === stable(s.policy),
              recorded_at: stamp(h.recorded_at),
              rights: p.rights,
              valid_from: p.valid_from,
              valid_until: p.valid_until,
              days_remaining: remaining,
              expiry:
                remaining === null
                  ? 'no_deadline'
                  : p.valid_until! <= now
                    ? 'expired'
                    : remaining <= 7
                      ? 'seven_days'
                      : remaining <= 30
                        ? 'thirty_days'
                        : 'valid',
              collection_allowed: current && canCollect(s, now) && !reasons.length,
              publication_allowed:
                current && canPublish(s, now) && !reasons.length && !publicReasons.length,
              blockers: [...reasons, ...publicationBlockers(s, now), ...publicReasons],
              fields: p.fields,
              conditions: p.conditions,
              evidence_refs: p.evidence_refs,
              checked_at: current ? s.rights_checked_at : null,
              retention: current
                ? retention(s)
                : [field('evidence_days', p.retention_days, 'days')],
              license_url: safeURL(s.license_url),
              attribution: s.attribution_text,
              license_notice: s.adapter === 'models_dev' ? MIT_NOTICE : null,
            };
            report.policies.push(row);
          }
        }
      }
    } else if (resource === 'releases') {
      report.releases = { records: [], migrations: [], ledger_available: false };
      try {
        const records = await rows(
          env.PRIVATE_DB,
          'SELECT record_json FROM admin_release_ledger WHERE recorded_at<=?' +
            (page.after ? " AND (recorded_at||'|'||record_id)<?" : '') +
            ' ORDER BY recorded_at DESC,record_id DESC LIMIT ?',
          [page.asOf, ...(page.after ? [page.after] : []), q.limit + 1],
        );
        report.releases.records = records
          .slice(0, q.limit)
          .map((r) => ReleaseRecord.parse(obj(r.record_json)));
        report.releases.ledger_available = true;
        if (records.length > q.limit) {
          const last = report.releases.records.at(-1)!;
          report.next_cursor = page.cursor(last.recorded_at + '|' + last.record_id);
        }
      } catch {
        report.state = 'partial';
        report.issues.push('release_ledger_unavailable');
      }
      for (const database of ['private', 'public'] as const) {
        try {
          const migrations = await rows(
            database === 'private' ? env.PRIVATE_DB : env.PUBLIC_DB,
            'SELECT name,applied_at FROM d1_migrations ORDER BY name LIMIT 100',
          );
          report.releases.migrations.push(
            ...migrations.map((x) => ({
              database,
              name: String(x.name),
              applied_at: str(x.applied_at),
            })),
          );
        } catch {
          report.state = 'partial';
          report.issues.push(database + '_migration_journal_unavailable');
        }
      }
    }
    return AdminReport.parse(report);
  } catch {
    return {
      ...report,
      state: 'unavailable',
      issues: ['operational_store_unavailable'],
      overview: undefined,
      sources: undefined,
      runs: undefined,
      data: undefined,
      policies: undefined,
      settings: undefined,
      releases: undefined,
    };
  }
}
