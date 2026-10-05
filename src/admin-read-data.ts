import type { CollectorEnv, Source } from './schema';
import type { DataDTO, FieldDTO, Query, Report } from './admin-contract';
import {
  rows,
  obj,
  str,
  stamp,
  field,
  safeURL,
  internalReadAllowed,
  unavailablePublication,
} from './admin-read';
import type { Row, PageContext } from './admin-read';
import { visibleJoin, visibleSQL, MIT_NOTICE } from './publication';
import { ATTRIBUTION } from './price-of-compute';

// Only normalized contract fields may leave the private store. Never forward metadata_json,
// domain_json, error text, artifact paths or unknown keys, even to authenticated clients.
const scalarFields = [
  'base_currency',
  'quote_currency',
  'rate_decimal',
  'reference_rate_type',
  'model_id',
  'serving_provider',
  'model_author',
  'canonical_model_id',
  'context_limit',
  'max_input',
  'max_output',
  'release_date',
  'upstream_updated_date',
  'source_status',
  'availability',
  'pricing_scope',
  'billing_notes',
  'tax_status',
  'gpu_sku_id',
  'provider',
  'secondary_source',
  'origin_source_id',
  'origin_offer_id',
  'region',
  'country',
  'contract_type',
  'item_condition',
  'marketplace',
  'amount_decimal',
  'currency',
  'unit',
  'basis',
  'gpu_count',
  'memory_gb',
  'shipping_amount_decimal',
  'shipping_included',
  'accelerator_model',
  'vram_gb',
  'form_factor',
  'interconnect',
  'dedicated_or_shared',
  'billing_unit',
  'minimum_term',
  'commitment',
  'interruptible',
  'includes_cpu_ram_storage',
  'egress_notes',
  'availability_status',
  'sale_unit',
  'price_scope',
  'condition',
  'listing_format',
  'gpu_count_in_lot',
  'asking_price',
  'shipping_price',
  'delivery_region',
  'warranty_status',
  'listing_state',
  'observation_basis',
  'period',
  'period_start',
  'period_end',
  'delivery_date',
  'area',
  'sector',
  'price_decimal',
  'rate_unit',
  'interval_start',
  'interval_end',
] as const;
export function domainFields(value: unknown): FieldDTO[] {
  const d = obj(value),
    out: FieldDTO[] = [];
  // Prioritize the source-native conditions and clocks so they survive list-view limits.
  // Flatten only these known scalars; never forward the nested object or evidence fields.
  const poc = obj(d.price_of_compute);
  for (const name of [
    'source_sku',
    'source_pricing_type',
    'source_day',
    'source_updated_at',
    'source_observed_at',
    'retrieved_at',
  ])
    if (Object.hasOwn(poc, name)) out.push(field('price_of_compute.' + name, poc[name]));
  for (const name of scalarFields)
    if (Object.hasOwn(d, name))
      out.push(
        field(
          name,
          d[name],
          ['amount_decimal', 'asking_price', 'shipping_price', 'price_decimal'].includes(name)
            ? [str(d.currency), str(d.billing_unit ?? d.unit)].filter(Boolean).join(' / ') || null
            : name === 'rate_decimal'
              ? [str(d.quote_currency), str(d.base_currency)].filter(Boolean).join(' / ')
              : null,
        ),
      );
  for (const name of ['input', 'output']) {
    const v = obj(d.modality)[name];
    if (Array.isArray(v))
      out.push(field('modality.' + name, v.filter((x) => typeof x === 'string').join(', ')));
  }
  for (const name of ['reasoning', 'tool_call', 'structured_output', 'attachment', 'temperature'])
    if (Object.hasOwn(obj(d.capabilities), name))
      out.push(field('capabilities.' + name, obj(d.capabilities)[name]));
  if (Array.isArray(d.price_components)) {
    for (const [i, item] of d.price_components.slice(0, 64).entries()) {
      const c = obj(item),
        prefix = 'price_components.' + i + '.';
      const unit = [str(c.currency), str(c.unit)].filter(Boolean).join(' / ') || null;
      for (const key of [
        'component_type',
        'amount_decimal',
        'currency',
        'unit',
        'tier_conditions',
        'cache_ttl',
      ])
        out.push(field(prefix + key, c[key], key === 'amount_decimal' ? unit : null));
    }
  }
  return out;
}
const knownQuality = new Set([
  'invalid_decimal',
  'decimal_out_of_bounds',
  'missing_price',
  'price_unknown',
  'price_not_provided',
  'zero_not_confirmed_free',
  'missing_input_output',
  'invalid_price',
  'zero_price_reported',
  'provider_observation_time_missing',
  'negative_price',
  'price_parse_error',
  'missing_required_field',
  'currency_mismatch',
  'large_relative_change',
  'invalid_source_date',
  'incompatible_fx_inputs',
  'catalog_partial',
  'price_quarantined',
  'missing_currency',
  'unknown_unit',
  'invalid_source_value',
  'not_in_policy',
  'not_provided',
  'not_established_by_catalog',
]);
const safeQuality = (v: unknown) =>
  typeof v === 'string' && knownQuality.has(v) ? v : 'quality_review_required';
const joins =
  ' FROM observations o LEFT JOIN fx_observations f ON f.observation_id=o.observation_id' +
  ' LEFT JOIN ai_api_prices a ON a.observation_id=o.observation_id' +
  ' LEFT JOIN ai_model_catalog c ON c.observation_id=o.observation_id' +
  ' LEFT JOIN gpu_rental gr ON gr.observation_id=o.observation_id' +
  ' LEFT JOIN gpu_secondary gs ON gs.observation_id=o.observation_id' +
  " LEFT JOIN model_snapshots ms ON ms.snapshot_id=json_extract(o.metadata_json,'$.model_snapshot_id')" +
  " LEFT JOIN gpu_snapshots g ON g.snapshot_id=json_extract(o.metadata_json,'$.snapshot_id')";
const select =
  'SELECT o.*,COALESCE(f.domain_json,a.domain_json,c.domain_json,gr.domain_json,gs.domain_json) domain_json,' +
  'ms.expires_at,ms.snapshot_id model_snapshot_id,g.snapshot_id gpu_snapshot_id,' +
  '(SELECT mm.price_eligible FROM model_snapshot_members mm WHERE mm.catalog_observation_id=o.observation_id LIMIT 1) price_eligible,' +
  '(SELECT mm.price_issues_json FROM model_snapshot_members mm WHERE mm.catalog_observation_id=o.observation_id LIMIT 1) price_issues_json,' +
  '(SELECT ce.previous_observation_id FROM change_events ce WHERE ce.observation_id=o.observation_id ORDER BY ce.observed_at DESC LIMIT 1) changed_from,' +
  "(SELECT me.previous_observation_id FROM model_events me WHERE me.observation_id=o.observation_id AND me.kind IN ('price_changed','metadata_changed','price_conditions_changed') ORDER BY me.recorded_at DESC LIMIT 1) model_changed_from";

async function publicRows(env: CollectorEnv, ids: string[], now: string, asOf: string) {
  const all = new Map<string, Row>(),
    visible = new Map<string, Row>();
  for (let offset = 0; offset < ids.length; offset += 40) {
    const chunk = ids.slice(offset, offset + 40),
      marks = chunk.map(() => '?').join(',');
    for (const r of await rows(
      env.PUBLIC_DB,
      'SELECT o.observation_id,o.public_json,o.derived,b.state,b.completed_at FROM published_observations o JOIN publication_batches b ON b.batch_id=o.batch_id WHERE o.observation_id IN (' +
        marks +
        ') AND o.recorded_at<=?',
      [...chunk, asOf],
    ))
      all.set(String(r.observation_id), r);
    for (const r of await rows(
      env.PUBLIC_DB,
      'SELECT o.observation_id,o.public_json,o.derived,b.completed_at' +
        visibleJoin +
        'WHERE ' +
        visibleSQL +
        ' AND o.observation_id IN (' +
        marks +
        ') AND o.recorded_at<=? AND b.completed_at<=?',
      [now, now, now, now, now, ...chunk, asOf, asOf],
    ))
      visible.set(String(r.observation_id), r);
  }
  return { all, visible };
}
async function project(
  env: CollectorEnv,
  sources: Source[],
  selected: Row[],
  now: string,
  asOf: string,
  detail: boolean,
): Promise<DataDTO[]> {
  const stored = await rows(
    env.PRIVATE_DB,
    'SELECT source_id,policy_version,config_json,suspended FROM sources',
  );
  let publicState: Awaited<ReturnType<typeof publicRows>> | null = null;
  try {
    publicState = await publicRows(
      env,
      selected.map((r) => String(r.observation_id)),
      now,
      asOf,
    );
  } catch {
    /* public state is independent */
  }
  const out: DataDTO[] = [];
  for (const r of selected) {
    const source = sources.find((s) => s.source_id === r.source_id),
      db = stored.find((x) => x.source_id === r.source_id);
    const id = String(r.observation_id),
      meta = obj(r.metadata_json),
      domain = obj(r.domain_json);
    const pub = publicState?.all.get(id),
      live = publicState?.visible.get(id);
    const publicValue = obj(obj(live?.public_json).value);
    const expiry =
      stamp(r.expires_at) ??
      (source?.gpu?.retention.normalized_days && stamp(r.observed_at)
        ? new Date(
            Date.parse(String(r.observed_at)) + source.gpu.retention.normalized_days * 86400000,
          ).toISOString()
        : null);
    const allowed =
      internalReadAllowed(source, db, now) &&
      source?.policy.version === r.policy_version &&
      (!expiry || expiry > now) &&
      r.lineage_readable !== false;
    const fields = allowed ? domainFields(domain) : [];
    const publicFields = live ? domainFields(publicValue) : [];
    const previousId = str(r.supersedes_observation_id ?? r.changed_from ?? r.model_changed_from);
    let previous: FieldDTO[] = [];
    if (detail && previousId) {
      const prior = await rows(
        env.PRIVATE_DB,
        select + joins + ' WHERE o.observation_id=? AND o.recorded_at<=? LIMIT 1',
        [previousId, asOf],
      );
      if (prior[0]) {
        const p = prior[0],
          priorSource = sources.find((s) => s.source_id === p.source_id),
          priorDB = stored.find((x) => x.source_id === p.source_id);
        const priorExpiry =
          stamp(p.expires_at) ??
          (priorSource?.gpu?.retention.normalized_days
            ? new Date(
                Date.parse(String(p.observed_at)) +
                  priorSource.gpu.retention.normalized_days * 86400000,
              ).toISOString()
            : null);
        if (
          internalReadAllowed(priorSource, priorDB, now) &&
          priorSource?.policy.version === p.policy_version &&
          (!priorExpiry || priorExpiry > now)
        )
          previous = domainFields(p.domain_json);
      }
    }
    const events = detail
      ? await rows(
          env.PRIVATE_DB,
          'SELECT code FROM quality_events WHERE run_id=? AND (record_key=? OR record_key IS NULL) AND recorded_at<=? LIMIT 100',
          [r.run_id, meta.source_record_key ?? r.entity_key, asOf],
        )
      : [];
    const issues = [
      ...new Set([
        ...(Array.isArray(meta.quality_flags) ? meta.quality_flags.map(safeQuality) : []),
        ...events.map((x) => safeQuality(x.code)),
      ]),
    ];
    if (r.price_eligible === 0) issues.push('price_quarantined');
    if (!detail && fields.length > 28) issues.push('more_fields_in_detail');
    const derived = r.derived === 1;
    out.push({
      observation_id: id,
      source_id: String(r.source_id),
      dataset: String(r.dataset),
      entity_key: allowed || live ? String(r.entity_key) : 'withheld',
      run_id: String(r.run_id),
      snapshot_id: str(r.model_snapshot_id ?? r.gpu_snapshot_id),
      observed_at: stamp(r.observed_at),
      recorded_at: stamp(r.recorded_at),
      source_period:
        allowed || live ? str(meta.source_date ?? domain.period ?? domain.delivery_date) : null,
      quality:
        r.price_eligible === 0 ? 'price_quarantined' : String(r.quality_status ?? 'accepted'),
      data_origin: str(meta.data_origin) ?? 'unknown',
      policy_version: String(r.policy_version),
      supersedes_id: previousId,
      retention_until: expiry,
      private_readable: !!allowed,
      private_blocker: allowed
        ? null
        : expiry && expiry <= now
          ? 'retention_expired'
          : 'current_internal_rights_not_confirmed',
      fields: detail ? fields : fields.slice(0, 28),
      public_fields: detail ? publicFields : publicFields.slice(0, 28),
      previous_fields: previous,
      publication: !publicState
        ? unavailablePublication()
        : {
            state: !pub
              ? 'not_published'
              : pub.state === 'withdrawn'
                ? 'held'
                : pub.state !== 'complete' ||
                    (typeof pub.completed_at === 'string' && pub.completed_at > asOf)
                  ? 'staging'
                  : !live
                    ? 'held'
                    : 'complete',
            original_count: pub && !derived ? 1 : 0,
            derived_count: pub && derived ? 1 : 0,
            visible_count: live ? 1 : 0,
            completed_at: stamp(pub?.completed_at),
          },
      issues,
      attribution:
        source?.adapter === 'price_of_compute'
          ? ATTRIBUTION.text
          : (source?.attribution_text ?? ''),
      source_url: safeURL(source?.source_url),
      conditions: source?.policy.conditions ?? [],
      license_notice: source?.adapter === 'models_dev' ? MIT_NOTICE : null,
      related_ids: previousId ? [previousId] : [],
      derived,
    });
  }
  return out;
}
async function derivedFX(
  env: CollectorEnv,
  sources: Source[],
  q: Query,
  page: PageContext,
  now: string,
): Promise<Row[]> {
  if (
    (q.dataset && q.dataset !== 'fx') ||
    q.snapshot ||
    (q.state && q.state !== 'accepted') ||
    ['quality', 'changes'].includes(q.view ?? '')
  )
    return [];
  const filters = ["d.dataset='fx'", 'd.recorded_at<=?', 'd.observed_at<=?'],
    args: unknown[] = [page.asOf, page.asOf];
  for (const [value, sql] of [
    [q.source, 'r.source_id=?'],
    [q.run, 'd.run_id=?'],
    [q.entity, 'd.entity_key=?'],
    [q.id, 'd.observation_id=?'],
  ] as const)
    if (value) {
      filters.push(sql);
      args.push(value);
    }
  if (!q.id && !q.run && !q.snapshot && ((q.view && q.view !== 'latest') || q.from || q.to)) {
    filters.push('d.observed_at>=? AND d.observed_at<=?');
    args.push(page.from, page.to);
  }
  let sql =
    'WITH eligible AS (SELECT d.*,r.source_id,ROW_NUMBER() OVER(PARTITION BY r.source_id,d.entity_key ORDER BY d.observed_at DESC,d.recorded_at DESC,d.observation_id DESC) latest_rank FROM derived_observations d JOIN collection_runs r ON r.run_id=d.run_id WHERE ' +
    filters.join(' AND ') +
    ') SELECT * FROM eligible WHERE 1=1';
  if ((!q.view || q.view === 'latest') && !q.id && !q.run) sql += ' AND latest_rank=1';
  if (page.after) {
    sql += " AND (observed_at||'|'||observation_id)<?";
    args.push(page.after);
  }
  const found = await rows(
    env.PRIVATE_DB,
    sql + ' ORDER BY observed_at DESC,observation_id DESC LIMIT ?',
    [...args, q.limit + 1],
  );
  if (!found.length) return found;
  const stored = await rows(
    env.PRIVATE_DB,
    'SELECT source_id,policy_version,config_json,suspended FROM sources',
  );
  for (const d of found) {
    const inputs = await rows(
      env.PRIVATE_DB,
      'SELECT o.source_id,o.policy_version,o.metadata_json,o.recorded_at FROM lineage l JOIN observations o ON o.observation_id=l.input_observation_id WHERE l.observation_id=? LIMIT 101',
      [d.observation_id],
    );
    d.lineage_readable =
      inputs.length > 0 &&
      inputs.length <= 100 &&
      inputs.every(
        (i) =>
          (i.recorded_at as string) <= page.asOf &&
          internalReadAllowed(
            sources.find((s) => s.source_id === i.source_id),
            stored.find((s) => s.source_id === i.source_id),
            now,
          ) &&
          sources.find((s) => s.source_id === i.source_id)?.policy.version === i.policy_version,
      );
    d.policy_version = inputs[0]?.policy_version ?? 'unknown';
    d.domain_json = d.lineage_readable ? d.value_json : '{}';
    d.metadata_json = stableDerivedMetadata(inputs);
    d.quality_status = 'accepted';
    d.derived = 1;
  }
  return found;
}
function stableDerivedMetadata(inputs: Row[]) {
  const metas = inputs.map((i) => obj(i.metadata_json));
  return JSON.stringify({
    data_origin: metas.length && metas.every((m) => m.data_origin === 'live') ? 'live' : 'unknown',
    source_date: metas[0]?.source_date,
  });
}
async function datasetCounts(
  env: CollectorEnv,
  q: Query,
  page: PageContext,
  now: string,
): Promise<Pick<Report, 'datasets' | 'state' | 'issues'>> {
  try {
    const predicates = [visibleSQL, 'o.recorded_at<=?', 'b.completed_at<=?'],
      args: unknown[] = [now, now, now, now, now, page.asOf, page.asOf];
    if (q.source) {
      predicates.push('o.source_id=?');
      args.push(q.source);
    }
    if (q.dataset) {
      predicates.push('o.dataset=?');
      args.push(q.dataset);
    }
    const result = await rows(
      env.PUBLIC_DB,
      'SELECT o.dataset,COUNT(*) n,MAX(o.observed_at) latest' +
        visibleJoin +
        'WHERE ' +
        predicates.join(' AND ') +
        ' GROUP BY o.dataset LIMIT 20',
      args,
    );
    return {
      datasets: result.map((r) => ({
        dataset: String(r.dataset),
        visible_count: Number(r.n),
        latest_observed_at: stamp(r.latest),
      })),
      state: 'ready',
      issues: [],
    };
  } catch {
    return { datasets: undefined, state: 'partial', issues: ['public_dataset_counts_unavailable'] };
  }
}
export async function readData(
  env: CollectorEnv,
  sources: Source[],
  q: Query,
  page: PageContext,
  now: string,
): Promise<Partial<Report>> {
  if (q.dataset === 'electricity')
    return { state: 'not_supported', issues: ['electricity_adapter_not_deployed'], data: [] };
  const view = q.view ?? 'latest',
    args: unknown[] = [page.asOf, page.asOf],
    filters = ['o.recorded_at<=?', 'o.observed_at<=?'];
  if (q.source) {
    filters.push('o.source_id=?');
    args.push(q.source);
  }
  if (q.dataset) {
    filters.push('o.dataset=?');
    args.push(q.dataset);
  }
  if (q.entity) {
    filters.push('o.entity_key=?');
    args.push(q.entity);
  }
  if (q.run) {
    filters.push('o.run_id=?');
    args.push(q.run);
  }
  if (q.id) {
    filters.push('o.observation_id=?');
    args.push(q.id);
  }
  if (q.snapshot) {
    filters.push('(ms.snapshot_id=? OR g.snapshot_id=?)');
    args.push(q.snapshot, q.snapshot);
  }
  if (!q.id && !q.run && !q.snapshot && (view !== 'latest' || q.from || q.to)) {
    filters.push('o.observed_at>=? AND o.observed_at<=?');
    args.push(page.from, page.to);
  }
  if (!q.id && view === 'quality')
    filters.push(
      "(o.quality_status='quarantined' OR EXISTS(SELECT 1 FROM model_snapshot_members mm WHERE mm.catalog_observation_id=o.observation_id AND mm.price_eligible=0) OR EXISTS(SELECT 1 FROM quality_events qe WHERE qe.run_id=o.run_id AND qe.record_key=json_extract(o.metadata_json,'$.source_record_key')))",
    );
  if (!q.id && view === 'changes')
    filters.push(
      "(o.supersedes_observation_id IS NOT NULL OR EXISTS(SELECT 1 FROM change_events ce WHERE ce.observation_id=o.observation_id) OR EXISTS(SELECT 1 FROM model_events me WHERE me.observation_id=o.observation_id AND me.kind IN ('price_changed','metadata_changed','price_conditions_changed')))",
    );
  if (q.state) {
    filters.push('o.quality_status=?');
    args.push(q.state);
  }
  if (!q.id && !q.run && !q.snapshot && view === 'latest') {
    filters.push(
      "(ms.snapshot_id IS NOT NULL OR NOT EXISTS(SELECT 1 FROM model_snapshots m WHERE m.source_id=o.source_id AND m.state='complete' AND m.completed_at<=?))",
    );
    args.push(page.asOf);
    filters.push(
      "(ms.snapshot_id IS NULL OR (ms.state='complete' AND ms.completed_at<=? AND ms.snapshot_id=(SELECT m.snapshot_id FROM model_snapshots m WHERE m.source_id=ms.source_id AND m.scope_hash=ms.scope_hash AND m.state='complete' AND m.completed_at<=? ORDER BY m.observed_at DESC,m.completed_at DESC,m.snapshot_id DESC LIMIT 1)))",
    );
    args.push(page.asOf, page.asOf);
    filters.push(
      "(g.snapshot_id IS NULL OR (g.state='complete' AND g.completed_at<=? AND g.snapshot_id=(SELECT gg.snapshot_id FROM gpu_snapshots gg WHERE gg.source_id=g.source_id AND gg.scope_hash=g.scope_hash AND gg.state='complete' AND gg.completed_at<=? ORDER BY gg.completed_at DESC,gg.snapshot_id DESC LIMIT 1)))",
    );
    args.push(page.asOf, page.asOf);
  }
  const query =
    select +
    ',ROW_NUMBER() OVER(PARTITION BY o.source_id,o.dataset,o.entity_key ORDER BY o.observed_at DESC,o.recorded_at DESC,o.observation_id DESC) latest_rank' +
    joins +
    ' WHERE ' +
    filters.join(' AND ');
  let sql = 'WITH eligible AS (' + query + ') SELECT * FROM eligible WHERE 1=1';
  if (view === 'latest' && !q.id && !q.run && !q.snapshot) sql += ' AND latest_rank=1';
  if (page.after) {
    sql += " AND (observed_at||'|'||observation_id)<?";
    args.push(page.after);
  }
  const originals = await rows(
    env.PRIVATE_DB,
    sql + ' ORDER BY observed_at DESC,observation_id DESC LIMIT ?',
    [...args, q.limit + 1],
  );
  const derived = await derivedFX(env, sources, q, page, now);
  const found = [...originals, ...derived].sort((a, b) => {
    const x = a.observed_at + '|' + a.observation_id,
      y = b.observed_at + '|' + b.observation_id;
    return x === y ? 0 : x < y ? 1 : -1;
  });
  const selected = found.slice(0, q.limit);
  const data = await project(env, sources, selected, now, page.asOf, !!q.id);
  if (q.id && data[0]) {
    const links = await rows(
      env.PRIVATE_DB,
      'SELECT observation_id FROM lineage WHERE input_observation_id=? UNION SELECT input_observation_id observation_id FROM lineage WHERE observation_id=? LIMIT 100',
      [q.id, q.id],
    );
    data[0].related_ids = [
      ...new Set([...data[0].related_ids, ...links.map((x) => String(x.observation_id))]),
    ].slice(0, 100);
  }
  const last = selected.at(-1);
  return {
    ...(await datasetCounts(env, q, page, now)),
    data,
    next_cursor:
      found.length > q.limit && last
        ? page.cursor(last.observed_at + '|' + last.observation_id)
        : null,
  };
}
