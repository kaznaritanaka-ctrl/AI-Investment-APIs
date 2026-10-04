import type { Source, CollectorEnv, Evidence, Observation, AIPrice } from './schema';
import type { ProjectedModel, ModelProjection } from './models';
import { modelScope, MODELS_PARSER } from './models';
import { assertPersistenceAllowed, canPublish } from './policy';
import { publicObservation, MIT_NOTICE } from './publication';
import { stable, hash, batches, D } from './util';

export type ModelSnapshot = {
  snapshot_id: string;
  run_id: string;
  source_id: string;
  policy_version: string;
  scope_hash: string;
  scope_json: string;
  parser_version: string;
  artifact_ref: string;
  observed_at: string;
  recorded_at: string;
  completed_at: string | null;
  state: string;
  stage: string;
  cursor: number;
  previous_snapshot_id: string | null;
  revises_snapshot_id: string | null;
  review_ref: string | null;
  enumerated_count: number;
  model_count: number;
  price_count: number;
  component_count: number;
  quarantined_count: number;
  complete_capture: number;
  issues_json: string;
  data_origin: 'live' | 'synthetic';
  expires_at: string;
  metrics_json: string;
};
export type ModelLease = { run_id: string; token: string; now: () => string };
export async function assertModelLease(env: CollectorEnv, lease?: ModelLease) {
  if (!lease) return;
  const held = await env.PRIVATE_DB.prepare(
    'SELECT 1 held FROM collection_runs WHERE run_id=? AND lease_token=? AND lease_until>?',
  )
    .bind(lease.run_id, lease.token, lease.now())
    .first();
  if (!held) throw new Error('operation_lease_lost');
}
async function checkpoint(
  env: CollectorEnv,
  snap: ModelSnapshot,
  stage: string,
  cursor: number,
  lease?: ModelLease,
) {
  const result = await env.PRIVATE_DB.prepare(
    'UPDATE model_snapshots SET stage=?,cursor=? WHERE snapshot_id=? AND stage=? AND cursor=?' +
      (lease
        ? ' AND EXISTS(SELECT 1 FROM collection_runs WHERE run_id=? AND lease_token=? AND lease_until>?)'
        : ''),
  )
    .bind(
      stage,
      cursor,
      snap.snapshot_id,
      snap.stage,
      snap.cursor,
      ...(lease ? [lease.run_id, lease.token, lease.now()] : []),
    )
    .run();
  if (!result.meta.changes) throw new Error('operation_lease_lost');
}
type Member = {
  record_key: string;
  catalog_observation_id: string;
  price_observation_id: string | null;
  first_model_observed_at: string;
};
type Event = {
  event_id: string;
  snapshot_id: string;
  record_key: string;
  kind: string;
  observation_id: string | null;
  previous_observation_id: string | null;
  observed_at: string;
  recorded_at: string;
  details_json: string;
};
async function loadObservation(env: CollectorEnv, id: string | null): Promise<Observation | null> {
  if (!id) return null;
  const row = await env.PRIVATE_DB.prepare(
    'SELECT o.metadata_json,COALESCE(c.domain_json,p.domain_json) domain_json FROM observations o LEFT JOIN ai_model_catalog c ON c.observation_id=o.observation_id LEFT JOIN ai_api_prices p ON p.observation_id=o.observation_id WHERE o.observation_id=?',
  )
    .bind(id)
    .first<{ metadata_json: string; domain_json: string }>();
  return row ? { ...JSON.parse(row.metadata_json), domain: JSON.parse(row.domain_json) } : null;
}
export async function initializeModelSnapshot(
  env: CollectorEnv,
  s: Source,
  run: string,
  scheduled: string,
  artifact: string,
  e: Evidence,
  p: ModelProjection,
  now: string,
  parser = MODELS_PARSER,
  revises: ModelSnapshot | null = null,
  review: string | null = null,
  lease?: ModelLease,
) {
  const id = await hash(run + '|' + s.policy.version + '|' + parser);
  const prior = await env.PRIVATE_DB.prepare(
    "SELECT snapshot_id FROM model_snapshots WHERE source_id=? AND scope_hash=? AND state='complete' AND observed_at<? AND expires_at>? ORDER BY observed_at DESC,completed_at DESC LIMIT 1",
  )
    .bind(s.source_id, p.scope_hash, e.observed_at, now)
    .first<{ snapshot_id: string }>();
  const expiry = new Date(
    Date.parse(e.observed_at) + s.models!.retention.normalized_days * 86400000,
  ).toISOString();
  await assertModelLease(env, lease);
  await assertPersistenceAllowed(env, s, lease?.now() ?? now);
  await env.PRIVATE_DB.prepare(
    'INSERT OR IGNORE INTO model_snapshots(snapshot_id,run_id,source_id,policy_version,scope_hash,scope_json,parser_version,artifact_ref,observed_at,recorded_at,state,previous_snapshot_id,revises_snapshot_id,review_ref,enumerated_count,complete_capture,issues_json,data_origin,expires_at,metrics_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
  )
    .bind(
      id,
      run,
      s.source_id,
      s.policy.version,
      p.scope_hash,
      revises?.scope_json ?? stable(modelScope(s)),
      parser,
      artifact,
      e.observed_at,
      now,
      'processing',
      prior?.snapshot_id ?? null,
      revises?.snapshot_id ?? null,
      review,
      p.enumerated_count,
      p.complete ? 1 : 0,
      stable(p.issues),
      e.synthetic ? 'synthetic' : 'live',
      expiry,
      stable({
        payload_bytes: e.bytes,
        projection_bytes: new TextEncoder().encode(e.body).byteLength,
        parse_elapsed_ms: p.parse_elapsed_ms,
        cloud_cpu_measured: false,
      }),
    )
    .run();
  return id;
}
export function modelCoverage(s: Source, snap: ModelSnapshot) {
  return {
    schema_version: '1',
    snapshot_id: snap.snapshot_id,
    source_id: s.source_id,
    rights_version: snap.policy_version,
    dataset: ['ai_model_catalog', 'ai_api_prices'],
    scope_hash: snap.scope_hash,
    providers: s.models!.providers,
    fields: s.models!.fields,
    observed_at: snap.observed_at,
    recorded_at: snap.recorded_at,
    completed_at: snap.completed_at,
    state: snap.state,
    capture_complete: !!snap.complete_capture,
    enumerated_model_count: snap.enumerated_count,
    model_count: snap.model_count,
    price_observation_count: snap.price_count,
    price_component_count: snap.component_count,
    price_quarantined_count: snap.quarantined_count,
    reasons: JSON.parse(snap.issues_json),
    data_origin: snap.data_origin,
    basis: 'secondary_community_catalog',
    availability_verified: false,
    market_representative: false,
    attribution: s.attribution_text,
    reuse: { license_url: s.license_url, conditions: s.policy.conditions, notice: MIT_NOTICE },
  };
}
async function stageSnapshot(env: CollectorEnv, s: Source, snap: ModelSnapshot, now: string) {
  if (!canPublish(s, now)) return;
  await env.PUBLIC_DB.batch([
    env.PUBLIC_DB.prepare(
      "INSERT OR IGNORE INTO publication_batches VALUES(?,?,?,'staging',?,NULL)",
    ).bind(snap.snapshot_id, s.source_id, s.policy.version, now),
    env.PUBLIC_DB.prepare(
      'INSERT OR IGNORE INTO published_model_snapshots VALUES(?,?,?,?,?,?,?,?,?,?,?)',
    ).bind(
      snap.snapshot_id,
      snap.snapshot_id,
      s.source_id,
      s.policy.version,
      snap.scope_hash,
      snap.observed_at,
      snap.recorded_at,
      null,
      'processing',
      snap.expires_at,
      stable(modelCoverage(s, snap)),
    ),
  ]);
}
export function modelPriceSeries(r: ProjectedModel) {
  const price = r.price!;
  return stable({
    ...price,
    canonical_model_id: r.catalog.canonical_model_id,
    price_components: price.price_components.map(
      ({ amount_decimal: _, price_state: __, free_evidence_ref: ___, ...c }) => c,
    ),
  });
}
async function observation(
  env: CollectorEnv,
  s: Source,
  snap: ModelSnapshot,
  e: Evidence,
  r: ProjectedModel,
  dataset: 'ai_api_prices' | 'ai_model_catalog',
  scheduled: string,
  now: string,
  flags: string[],
  supersedes: string | null,
): Promise<Observation> {
  const domain = dataset === 'ai_model_catalog' ? r.catalog : r.price!;
  const entity =
    dataset === 'ai_model_catalog'
      ? 'catalog/' + r.key
      : r.key + ':' + (await hash(modelPriceSeries(r))).slice(0, 16);
  const fingerprint = await hash(stable({ domain, source_date: null }));
  const first = await env.PRIVATE_DB.prepare(
    'SELECT recorded_at FROM observations WHERE source_id=? AND policy_version=? AND entity_key=? AND fingerprint=? ORDER BY recorded_at LIMIT 1',
  )
    .bind(s.source_id, s.policy.version, entity, fingerprint)
    .first<{ recorded_at: string }>();
  return {
    dataset,
    domain,
    entity_key: entity,
    source_record_key: r.key,
    source_date: null,
    source_published_at: null,
    source_effective_at: null,
    observation_basis: dataset === 'ai_model_catalog' ? 'catalog_listing' : 'advertised_quote',
    quality_flags: flags,
    quality_status: flags.some((f) => f !== 'zero_price_reported') ? 'quarantined' : 'accepted',
    observation_id: await hash(snap.snapshot_id + '|' + entity + '|' + fingerprint),
    source_id: s.source_id,
    source_policy_version: s.policy.version,
    scheduled_for: scheduled,
    observed_at: e.observed_at,
    first_seen_at: first?.recorded_at ?? now,
    recorded_at: now,
    native_frequency: s.native_frequency,
    source_url: s.source_url,
    raw_artifact_ref: snap.artifact_ref,
    raw_payload_hash: e.payload_hash,
    record_fingerprint: fingerprint,
    collector_version: '0.3.0',
    parser_version: snap.parser_version,
    schema_version: '1',
    model_snapshot_id: snap.snapshot_id,
    data_origin: e.synthetic ? 'synthetic' : 'live',
    supersedes_observation_id: supersedes,
    ...(snap.revises_snapshot_id ? { backfill: true } : {}),
  };
}
function privateObservation(env: CollectorEnv, o: Observation, run: string) {
  const { domain, ...metadata } = o;
  const a = env.PRIVATE_DB.prepare(
    'INSERT OR IGNORE INTO observations VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
  ).bind(
    o.observation_id,
    o.source_id,
    o.source_policy_version,
    run,
    o.dataset,
    o.entity_key,
    o.observed_at,
    o.recorded_at,
    o.record_fingerprint,
    o.parser_version,
    o.quality_status,
    o.supersedes_observation_id,
    stable(metadata),
  );
  const d = domain as ProjectedModel['catalog'];
  const b =
    o.dataset === 'ai_model_catalog'
      ? env.PRIVATE_DB.prepare('INSERT OR IGNORE INTO ai_model_catalog VALUES(?,?,?,?,?)').bind(
          o.observation_id,
          d.serving_provider,
          d.model_id,
          d.canonical_model_id,
          stable(domain),
        )
      : env.PRIVATE_DB.prepare('INSERT OR IGNORE INTO ai_api_prices VALUES(?,?,?,?)').bind(
          o.observation_id,
          d.serving_provider,
          d.model_id,
          stable(domain),
        );
  return [a, b];
}
async function stagePublic(
  env: CollectorEnv,
  s: Source,
  snap: ModelSnapshot,
  rows: Observation[],
  events: Event[],
  firstModel: string,
  now: string,
) {
  if (!snap.complete_capture || !canPublish(s, now)) return;
  await assertPersistenceAllowed(env, s, now);
  await batches(
    env.PUBLIC_DB,
    rows
      .filter((o) => o.quality_status === 'accepted')
      .map((o) =>
        env.PUBLIC_DB.prepare(
          'INSERT OR IGNORE INTO published_observations(observation_id,batch_id,source_id,policy_version,dataset,entity_key,observed_at,recorded_at,supersedes_observation_id,derived,public_json,provider,model_snapshot_id) VALUES(?,?,?,?,?,?,?,?,?,0,?,?,?)',
        ).bind(
          o.observation_id,
          snap.snapshot_id,
          s.source_id,
          s.policy.version,
          o.dataset,
          o.entity_key,
          o.observed_at,
          o.recorded_at,
          o.supersedes_observation_id,
          stable({
            ...publicObservation(o, s, snap.snapshot_id),
            model_snapshot_id: snap.snapshot_id,
            first_model_observed_at: firstModel,
          }),
          (o.domain as AIPrice).serving_provider,
          snap.snapshot_id,
        ),
      ),
  );
  if (!canPublish(s, now, true)) return;
  const eligibleEvents: Event[] = [];
  for (const event of events) {
    if (
      event.observation_id &&
      !rows.some(
        (o) => o.observation_id === event.observation_id && o.quality_status === 'accepted',
      )
    )
      continue;
    if (event.previous_observation_id) {
      const input = await env.PUBLIC_DB.prepare(
        "SELECT o.observation_id FROM published_observations o JOIN publication_batches b ON b.batch_id=o.batch_id JOIN published_model_snapshots ms ON ms.snapshot_id=o.model_snapshot_id JOIN source_publications p ON p.source_id=o.source_id AND p.policy_version=o.policy_version WHERE o.observation_id=? AND b.state='complete' AND b.completed_at<=? AND ms.state='complete' AND ms.expires_at>? AND p.active=1 AND p.revoked=0 AND p.derived_allowed=1 AND p.valid_from<=? AND (p.valid_until IS NULL OR p.valid_until>?)",
      )
        .bind(event.previous_observation_id, now, now, now, now)
        .first();
      if (!input) continue;
    }
    eligibleEvents.push(event);
  }
  await batches(
    env.PUBLIC_DB,
    eligibleEvents.map((event) => {
      const { details_json, ...rest } = event;
      return env.PUBLIC_DB.prepare(
        'INSERT OR IGNORE INTO published_model_events(event_id,snapshot_id,observation_id,previous_observation_id,observed_at,recorded_at,public_json) VALUES(?,?,?,?,?,?,?)',
      ).bind(
        event.event_id,
        snap.snapshot_id,
        event.observation_id,
        event.previous_observation_id,
        event.observed_at,
        event.recorded_at,
        stable({
          ...rest,
          details: JSON.parse(details_json),
          methodology: 'models-catalog-v1',
          attribution: s.attribution_text,
          source_id: s.source_id,
          reuse: {
            license_url: s.license_url,
            conditions: s.policy.conditions,
            notice: MIT_NOTICE,
          },
        }),
      );
    }),
  );
  for (const event of eligibleEvents.filter((e) => e.kind === 'price_changed')) {
    const o = rows.find(
      (o) => o.observation_id === event.observation_id && o.quality_status === 'accepted',
    );
    if (!o) continue;
    const change = {
      event_id: event.event_id,
      observation_id: o.observation_id,
      previous_observation_id: event.previous_observation_id,
      dataset: o.dataset,
      entity_key: o.entity_key,
      observed_at: o.observed_at,
      details: JSON.parse(event.details_json),
      source: { source_id: s.source_id, source_url: s.source_url },
      attribution: s.attribution_text,
      methodology: 'same-series-change-v1',
      reuse: { license_url: s.license_url, conditions: s.policy.conditions, notice: MIT_NOTICE },
    };
    await env.PUBLIC_DB.prepare(
      'INSERT OR IGNORE INTO published_changes(event_id,observation_id,dataset,entity_key,observed_at,public_json) VALUES(?,?,?,?,?,?)',
    )
      .bind(
        event.event_id,
        o.observation_id,
        o.dataset,
        o.entity_key,
        o.observed_at,
        stable(change),
      )
      .run();
  }
}
async function eventFor(
  snap: ModelSnapshot,
  key: string,
  kind: string,
  current: string | null,
  prior: string | null,
  details: unknown,
  now: string,
): Promise<Event> {
  return {
    event_id: await hash(snap.snapshot_id + '|' + key + '|' + kind),
    snapshot_id: snap.snapshot_id,
    record_key: key,
    kind,
    observation_id: current,
    previous_observation_id: prior,
    observed_at: snap.observed_at,
    recorded_at: now,
    details_json: stable(details),
  };
}
const eventStatement = (env: CollectorEnv, e: Event) =>
  env.PRIVATE_DB.prepare('INSERT OR IGNORE INTO model_events VALUES(?,?,?,?,?,?,?,?,?)').bind(
    e.event_id,
    e.snapshot_id,
    e.record_key,
    e.kind,
    e.observation_id,
    e.previous_observation_id,
    e.observed_at,
    e.recorded_at,
    e.details_json,
  );
export async function storeModelChunk(
  env: CollectorEnv,
  s: Source,
  snap: ModelSnapshot,
  e: Evidence,
  p: ModelProjection,
  scheduled: string,
  now: string,
  lease?: ModelLease,
) {
  await assertModelLease(env, lease);
  await stageSnapshot(env, s, snap, now);
  const archive: unknown[] = [];
  const page = p.records.slice(snap.cursor, snap.cursor + s.models!.models_per_invocation);
  for (const r of page) {
    await assertModelLease(env, lease);
    await assertPersistenceAllowed(env, s, lease?.now() ?? now);
    const existing = await env.PRIVATE_DB.prepare(
      'SELECT * FROM model_snapshot_members WHERE snapshot_id=? AND record_key=?',
    )
      .bind(snap.snapshot_id, r.key)
      .first<Member>();
    let rows: Observation[], events: Event[], firstModel: string;
    if (existing) {
      rows = (
        await Promise.all([
          loadObservation(env, existing.catalog_observation_id),
          loadObservation(env, existing.price_observation_id),
        ])
      ).filter((o): o is Observation => !!o);
      events = (
        await env.PRIVATE_DB.prepare(
          'SELECT * FROM model_events WHERE snapshot_id=? AND record_key=?',
        )
          .bind(snap.snapshot_id, r.key)
          .all<Event>()
      ).results;
      firstModel = existing.first_model_observed_at;
    } else {
      const priorMember = await env.PRIVATE_DB.prepare(
        "SELECT m.* FROM model_snapshot_members m JOIN model_snapshots sn ON sn.snapshot_id=m.snapshot_id WHERE sn.source_id=? AND sn.scope_hash=? AND sn.state='complete' AND sn.observed_at<=? AND sn.snapshot_id<>? AND sn.expires_at>? AND m.record_key=? ORDER BY sn.observed_at DESC,sn.completed_at DESC LIMIT 1",
      )
        .bind(s.source_id, snap.scope_hash, snap.observed_at, snap.snapshot_id, now, r.key)
        .first<Member & { snapshot_id: string }>();
      const priorCatalog = await loadObservation(env, priorMember?.catalog_observation_id ?? null);
      const revision = snap.revises_snapshot_id
        ? await env.PRIVATE_DB.prepare(
            'SELECT * FROM model_snapshot_members WHERE snapshot_id=? AND record_key=?',
          )
            .bind(snap.revises_snapshot_id, r.key)
            .first<Member>()
        : null;
      const catalog = await observation(
        env,
        s,
        snap,
        e,
        r,
        'ai_model_catalog',
        scheduled,
        now,
        [],
        revision?.catalog_observation_id ?? null,
      );
      const first = await env.PRIVATE_DB.prepare(
        'SELECT MIN(m.first_model_observed_at) first_observed FROM model_snapshot_members m JOIN model_snapshots sn ON sn.snapshot_id=m.snapshot_id WHERE sn.source_id=? AND sn.policy_version=? AND sn.expires_at>? AND m.record_key=?',
      )
        .bind(s.source_id, s.policy.version, now, r.key)
        .first<{ first_observed: string | null }>();
      firstModel = first?.first_observed ?? e.observed_at;
      rows = [catalog];
      events = [];
      if (snap.complete_capture && !snap.revises_snapshot_id) {
        const kind = !snap.previous_snapshot_id
          ? 'baseline_seen'
          : !priorMember
            ? 'first_seen'
            : priorMember.snapshot_id !== snap.previous_snapshot_id
              ? 'reappeared'
              : 'observed_again';
        events.push(
          await eventFor(
            snap,
            r.key,
            kind,
            catalog.observation_id,
            priorCatalog?.observation_id ?? null,
            { release_inferred: false },
            now,
          ),
        );
        if (priorCatalog) {
          const previous = priorCatalog.domain as ProjectedModel['catalog'];
          const changed = Object.keys(r.catalog).filter(
            (k) =>
              stable(previous[k as keyof typeof previous]) !==
              stable(r.catalog[k as keyof typeof previous]),
          );
          if (changed.length)
            events.push(
              await eventFor(
                snap,
                r.key,
                'metadata_changed',
                catalog.observation_id,
                priorCatalog.observation_id,
                { fields: changed },
                now,
              ),
            );
          if (previous.canonical_model_id !== r.catalog.canonical_model_id)
            events.push(
              await eventFor(
                snap,
                r.key,
                'source_mapping_changed',
                catalog.observation_id,
                priorCatalog.observation_id,
                {
                  before: previous.canonical_model_id,
                  after: r.catalog.canonical_model_id,
                  automatic_merge: false,
                },
                now,
              ),
            );
          if (
            previous.source_status !== r.catalog.source_status &&
            r.catalog.source_status === 'deprecated'
          )
            events.push(
              await eventFor(
                snap,
                r.key,
                'source_deprecated',
                catalog.observation_id,
                priorCatalog.observation_id,
                { availability: 'unknown' },
                now,
              ),
            );
        }
      }
      if (r.price) {
        const price = await observation(
          env,
          s,
          snap,
          e,
          r,
          'ai_api_prices',
          scheduled,
          now,
          [...r.price_issues],
          revision?.price_observation_id ?? null,
        );
        let priorPrice = await loadObservation(env, priorMember?.price_observation_id ?? null);
        // A repeated unreviewed jump must not become accepted merely by repeating tomorrow.
        if (
          priorPrice?.entity_key === price.entity_key &&
          priorPrice.quality_status !== 'accepted'
        ) {
          const accepted = await env.PRIVATE_DB.prepare(
            "SELECT o.observation_id FROM observations o JOIN model_snapshot_members m ON m.price_observation_id=o.observation_id JOIN model_snapshots sn ON sn.snapshot_id=m.snapshot_id WHERE o.source_id=? AND o.policy_version=? AND o.entity_key=? AND o.quality_status='accepted' AND sn.state='complete' AND sn.expires_at>? AND o.observed_at<? ORDER BY o.observed_at DESC,o.recorded_at DESC LIMIT 1",
          )
            .bind(s.source_id, s.policy.version, price.entity_key, now, snap.observed_at)
            .first<{ observation_id: string }>();
          if (accepted) priorPrice = await loadObservation(env, accepted.observation_id);
        }
        if (priorPrice && !snap.revises_snapshot_id && snap.complete_capture) {
          if (priorPrice.entity_key !== price.entity_key)
            events.push(
              await eventFor(
                snap,
                r.key,
                'price_conditions_changed',
                price.observation_id,
                priorPrice.observation_id,
                { price_direction: null },
                now,
              ),
            );
          else {
            const before = (priorPrice.domain as AIPrice).price_components;
            const diffs = r.price.price_components
              .map((c, i) => ({
                component: c.source_path,
                before: before[i]?.amount_decimal ?? null,
                after: c.amount_decimal,
              }))
              .filter((c) => c.before !== c.after);
            if (
              diffs.some(
                (c) =>
                  c.before !== null &&
                  c.after !== null &&
                  (new D(c.before).eq(0)
                    ? new D(c.after).gt(0)
                    : new D(c.after).minus(c.before).abs().div(c.before).gt('0.5')),
              )
            ) {
              price.quality_flags.push('large_change_review');
              price.quality_status = 'quarantined';
            }
            if (diffs.length && priorPrice.quality_status === 'accepted')
              events.push(
                await eventFor(
                  snap,
                  r.key,
                  'price_changed',
                  price.observation_id,
                  priorPrice.observation_id,
                  { components: diffs },
                  now,
                ),
              );
          }
        }
        rows.push(price);
      }
      await assertModelLease(env, lease);
      await assertPersistenceAllowed(env, s, lease?.now() ?? now);
      await env.PRIVATE_DB.batch([
        ...rows.flatMap((o) => privateObservation(env, o, snap.run_id)),
        env.PRIVATE_DB.prepare(
          'INSERT OR IGNORE INTO model_snapshot_members VALUES(?,?,?,?,?,?,?,?)',
        ).bind(
          snap.snapshot_id,
          r.key,
          catalog.observation_id,
          rows[1]?.observation_id ?? null,
          r.price?.price_components.length ?? 0,
          rows[1]?.quality_status === 'accepted' ? 1 : 0,
          stable(rows[1]?.quality_flags ?? r.price_issues),
          firstModel,
        ),
        ...events.map((ev) => eventStatement(env, ev)),
      ]);
    }
    archive.push({ observations: rows, events });
    await assertModelLease(env, lease);
    await stagePublic(env, s, snap, rows, events, firstModel, lease?.now() ?? now);
  }
  await assertModelLease(env, lease);
  await assertPersistenceAllowed(env, s, lease?.now() ?? now);
  const body = stable({
    schema_version: '1',
    snapshot_id: snap.snapshot_id,
    policy: s.policy,
    page_start: snap.cursor,
    records: archive,
  });
  await env.EVIDENCE.put(
    'archive/' + s.source_id + '/models/' + snap.snapshot_id + '/' + snap.cursor + '.json',
    body,
    { onlyIf: { etagDoesNotMatch: '*' }, customMetadata: { sha256: await hash(body) } },
  );
  const cursor = snap.cursor + page.length,
    done = cursor >= p.records.length;
  await checkpoint(env, snap, done ? 'absence' : 'ingest', done ? 0 : cursor, lease);
}
export async function storeModelAbsence(
  env: CollectorEnv,
  s: Source,
  snap: ModelSnapshot,
  now: string,
  lease?: ModelLease,
) {
  await assertModelLease(env, lease);
  if (!snap.complete_capture || !snap.previous_snapshot_id || snap.revises_snapshot_id) {
    await checkpoint(env, snap, 'finalize', 0, lease);
    return;
  }
  const rows = (
    await env.PRIVATE_DB.prepare(
      'SELECT m.* FROM model_snapshot_members m WHERE m.snapshot_id=? AND NOT EXISTS(SELECT 1 FROM model_snapshot_members current WHERE current.snapshot_id=? AND current.record_key=m.record_key) ORDER BY m.record_key LIMIT 50 OFFSET ?',
    )
      .bind(snap.previous_snapshot_id, snap.snapshot_id, snap.cursor)
      .all<Member>()
  ).results;
  const events: Event[] = [];
  for (const row of rows)
    events.push(
      await eventFor(
        snap,
        row.record_key,
        'not_seen',
        null,
        row.catalog_observation_id,
        { scope_hash: snap.scope_hash, availability: 'unknown', deprecation_inferred: false },
        now,
      ),
    );
  await assertModelLease(env, lease);
  await assertPersistenceAllowed(env, s, lease?.now() ?? now);
  await batches(
    env.PRIVATE_DB,
    events.map((e) => eventStatement(env, e)),
  );
  await assertModelLease(env, lease);
  await stagePublic(env, s, snap, [], events, '', lease?.now() ?? now);
  const body = stable({ snapshot_id: snap.snapshot_id, events });
  await env.EVIDENCE.put(
    'archive/' + s.source_id + '/models/' + snap.snapshot_id + '/absence-' + snap.cursor + '.json',
    body,
    { onlyIf: { etagDoesNotMatch: '*' }, customMetadata: { sha256: await hash(body) } },
  );
  await checkpoint(
    env,
    snap,
    rows.length < 50 ? 'finalize' : 'absence',
    snap.cursor + rows.length,
    lease,
  );
}
export async function finalizeModels(
  env: CollectorEnv,
  s: Source,
  snap: ModelSnapshot,
  now: string,
  lease?: ModelLease,
) {
  await assertModelLease(env, lease);
  const totals = await env.PRIVATE_DB.prepare(
    'SELECT COUNT(*) model_count,COUNT(price_observation_id) price_count,COALESCE(SUM(component_count),0) component_count,COALESCE(SUM(CASE WHEN price_eligible=0 THEN 1 ELSE 0 END),0) quarantined_count,COALESCE(SUM(price_eligible),0) accepted_prices FROM model_snapshot_members WHERE snapshot_id=?',
  )
    .bind(snap.snapshot_id)
    .first<any>();
  const complete = !!snap.complete_capture && totals.model_count === snap.enumerated_count;
  // A prior public commit may have succeeded even when private completion failed.
  // Preserve its original as_of boundary while reconciling the remaining database.
  const publicCompletion = await env.PUBLIC_DB.prepare(
    "SELECT completed_at FROM publication_batches WHERE batch_id=? AND state='complete'",
  )
    .bind(snap.snapshot_id)
    .first<{ completed_at: string }>();
  const completedAt = publicCompletion?.completed_at ?? snap.completed_at ?? now;
  const finished: ModelSnapshot = {
    ...snap,
    ...totals,
    state: complete ? 'complete' : 'partial',
    stage: 'done',
    completed_at: completedAt,
  };
  await assertModelLease(env, lease);
  await assertPersistenceAllowed(env, s, lease?.now() ?? now);
  await stageSnapshot(env, s, snap, now);
  if (canPublish(s, lease?.now() ?? now)) {
    if (complete) {
      const count = await env.PUBLIC_DB.prepare(
        'SELECT COUNT(*) n FROM published_observations WHERE model_snapshot_id=?',
      )
        .bind(snap.snapshot_id)
        .first<{ n: number }>();
      if (count?.n !== totals.model_count + totals.accepted_prices)
        throw new Error('public_model_count_mismatch');
    }
    await assertModelLease(env, lease);
    await assertPersistenceAllowed(env, s, lease?.now() ?? now);
    // One atomic public commit. as_of cannot see staged rows or future completion.
    await env.PUBLIC_DB.batch([
      env.PUBLIC_DB.prepare(
        'UPDATE published_model_snapshots SET state=?,completed_at=?,public_json=? WHERE snapshot_id=?',
      ).bind(finished.state, completedAt, stable(modelCoverage(s, finished)), snap.snapshot_id),
      env.PUBLIC_DB.prepare(
        "UPDATE publication_batches SET state='complete',completed_at=COALESCE(completed_at,?) WHERE batch_id=? AND state='staging'",
      ).bind(completedAt, snap.snapshot_id),
    ]);
  }
  const committed = await env.PRIVATE_DB.prepare(
    "UPDATE model_snapshots SET state=?,stage='done',completed_at=COALESCE(completed_at,?),model_count=?,price_count=?,component_count=?,quarantined_count=? WHERE snapshot_id=?" +
      (lease
        ? ' AND EXISTS(SELECT 1 FROM collection_runs WHERE run_id=? AND lease_token=? AND lease_until>?)'
        : ''),
  )
    .bind(
      finished.state,
      completedAt,
      totals.model_count,
      totals.price_count,
      totals.component_count,
      totals.quarantined_count,
      snap.snapshot_id,
      ...(lease ? [lease.run_id, lease.token, lease.now()] : []),
    )
    .run();
  if (!committed.meta.changes) throw new Error('operation_lease_lost');
  return { ...finished, accepted_prices: totals.accepted_prices };
}
