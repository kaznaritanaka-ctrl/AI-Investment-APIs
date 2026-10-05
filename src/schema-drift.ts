import type { Source } from './schema';
import { canCollect, canPublish } from './policy';
import { stable, hash, isoDate } from './util';

export type DriftStage =
  'http' | 'body' | 'projection' | 'parser' | 'private_store' | 'publication';
export const diagnosticCodes = [
  'json_shape',
  'wrapper_changed',
  'pagination_contract',
  'semantics_changed',
  'field_type_or_enum',
  'field_type',
  'unknown_pricing_field',
  'pricing_basis_changed',
  'record_scope_changed',
  'required_field_missing',
  'identifier_or_shape_changed',
  'identifier_changed',
  'contract_failure',
] as const;
export type Diagnostic = {
  code: (typeof diagnosticCodes)[number];
  path: string;
  expected: string;
  actual: string;
  severity: 'info' | 'block';
};
export type RecoveryCapture = {
  body: string | null;
  diagnostics: Diagnostic[];
  complete: boolean;
  wrapper: 'data' | 'catalog' | 'result' | null;
  record_count: number | null;
};
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const kind = (v: unknown) =>
  v === undefined ? 'missing' : v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
const identifier = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,179}$/.test(v);
const numeric = (v: unknown) =>
  typeof v === 'string' && /^(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d{1,3})?$/.test(v) && v.length <= 100;
const costs = [
  'input',
  'output',
  'cache_read',
  'cache_write',
  'reasoning',
  'input_audio',
  'output_audio',
];
const semantics = ['currency', 'unit', 'basis', 'price_basis', 'contract_type', 'sku', 'region'];

// This describes existing grants; it grants nothing and never modifies source policy.
export function recoveryRights(s: Source, now: string) {
  const allowed = canCollect(s, now);
  const models = allowed && s.adapter === 'models_dev' && !!s.models;
  const ecb = allowed && s.adapter === 'ecb' && s.source_id === 'ecb';
  return {
    source_id: s.source_id,
    raw_response: ecb,
    minimal_projection: models || ecb,
    field_whitelist: models ? [...s.models!.fields] : ecb ? [...s.policy.fields] : [],
    retention_days:
      models || ecb
        ? Math.min(
            s.policy.retention_days,
            s.models?.retention.evidence_days ?? Infinity,
            s.policy.retention_limit_days ?? Infinity,
          )
        : null,
    storage: 'private_r2_encrypted_at_rest' as const,
    external_llm_processing: s.policy.rights.external_llm_processing === 'allowed' && allowed,
    quarantine_public_redistribution: false,
    normalized_publication: canPublish(s, now),
  };
}

export function classifyFailure(code: string, stage: DriftStage) {
  if (
    ['http_401', 'http_403', 'authentication_not_configured', 'oauth_response_invalid'].includes(
      code,
    )
  )
    return 'authentication';
  if (['rate_limited', 'retryable_429'].includes(code)) return 'rate_limit';
  if (['timeout', 'network_error', 'retryable_5xx'].includes(code)) return 'transport';
  if (['unexpected_content_type', 'empty_response', 'response_too_large'].includes(code))
    return 'response_contract';
  if (['attempt_log_failed', 'recovery_capture_failed', 'quarantine_write_failed'].includes(code))
    return 'storage_or_publication';
  if (['private_store', 'publication'].includes(stage)) return 'storage_or_publication';
  if (
    code === 'schema_drift_detected' ||
    /^(invalid_(xml|source_date|currency_rows|structure)|missing_selected_currencies|catalog_parse_error|unexpected_catalog_structure|invalid_model_identity|gpu_schema_invalid|gpu_field_invalid|gpu_count_invalid|.*pagination.*)$/.test(
      code,
    )
  )
    return 'schema_drift';
  return 'unclassified';
}

export function captureECB(text: string): RecoveryCapture {
  // ECB's reviewed contract is EUR reference rates. Newly explicit basis/scale
  // metadata is a human decision, even if the old parser could ignore it.
  const changed =
    /(?:\s(?:base|base_currency|unit|basis|denomination|scale)\s*=|<(?:[\w-]+:)?(?:base|base_currency|unit|basis|denomination|scale)(?:\s|>))/i.test(
      text,
    );
  return {
    body: text,
    complete: true,
    wrapper: null,
    record_count: null,
    diagnostics: changed
      ? [
          {
            code: 'semantics_changed',
            path: '$.basis',
            expected: 'reviewed_contract',
            actual: 'unreviewed_field',
            severity: 'block',
          },
        ]
      : [],
  };
}

// Only fixed field paths/type labels enter diagnostics. Unknown keys/values, model IDs,
// source-supplied URLs, arbitrary exception messages and headers never enter this output.
export function captureModelFields(
  text: string,
  s: Source,
  previousCount: number | null = null,
): RecoveryCapture {
  const diagnostics: Diagnostic[] = [];
  const add = (
    code: Diagnostic['code'],
    path: string,
    expected: string,
    actual: string,
    severity: 'info' | 'block' = 'block',
  ) => {
    if (
      diagnostics.length < 64 &&
      !diagnostics.some((d) => d.code === code && d.path === path && d.actual === actual)
    )
      diagnostics.push({ code, path, expected, actual, severity });
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text, (_key, value, context?: { source?: string }) => {
      if (typeof value !== 'number') return value;
      if (!context?.source) throw new Error('numeric_lexeme_unavailable');
      return context.source;
    });
  } catch {
    add('json_shape', '$', 'json_object', 'invalid_json');
    return { body: null, diagnostics, complete: false, wrapper: null, record_count: null };
  }
  if (!object(parsed)) {
    add('json_shape', '$', 'object', kind(parsed));
    return { body: null, diagnostics, complete: false, wrapper: null, record_count: null };
  }
  let root = parsed;
  let wrapper: RecoveryCapture['wrapper'] = null;
  const providers = s.models?.providers ?? [];
  const present = (v: Record<string, unknown>) => providers.some((p) => Object.hasOwn(v, p));
  if (present(root) && ['data', 'catalog', 'result', 'error'].some((k) => Object.hasOwn(root, k)))
    add('json_shape', '$', 'provider_map', 'ambiguous_root');
  if (!present(root)) {
    const matches = (['data', 'catalog', 'result'] as const).filter(
      (k) => object(root[k]) && present(root[k]),
    );
    if (matches.length === 1) {
      wrapper = matches[0];
      root = root[wrapper] as Record<string, unknown>;
      add('wrapper_changed', '$', 'provider_map', wrapper);
    }
  }
  for (const k of ['next', 'links', 'pagination', 'has_more', 'cursor'])
    if (Object.hasOwn(parsed, k) || Object.hasOwn(root, k))
      add('pagination_contract', '$.pagination', 'complete_catalog', 'metadata_present');
  for (const k of semantics)
    if (Object.hasOwn(root, k) || Object.hasOwn(parsed, k))
      add('semantics_changed', '$.' + k, 'reviewed_contract', 'unreviewed_field');
  const output: Record<string, unknown> = Object.create(null);
  let count = 0,
    complete = true;
  const fields = new Set<string>(s.models?.fields ?? []);
  const scalar = (value: unknown, path: string, check: (x: unknown) => boolean): unknown => {
    if (value == null) return value ?? null;
    if (check(value)) return value;
    add('field_type_or_enum', '$.provider.models.*.' + path, 'reviewed_type_or_enum', kind(value));
    complete = false;
    return null;
  };
  const price = (v: unknown, depth = 0): unknown => {
    if (v == null) return v ?? null;
    if (!object(v)) {
      add('field_type', '$.provider.models.*.cost', 'object', kind(v));
      complete = false;
      return null;
    }
    const out: Record<string, unknown> = Object.create(null);
    for (const k of semantics)
      if (Object.hasOwn(v, k))
        add(
          'semantics_changed',
          '$.provider.models.*.cost.' + k,
          'reviewed_contract',
          'unreviewed_field',
        );
    if (Object.keys(v).some((k) => ![...costs, 'tiers', 'tier', 'context_over_200k'].includes(k))) {
      add(
        'unknown_pricing_field',
        '$.provider.models.*.cost.*',
        'known_component',
        'unretained_field',
      );
      complete = false;
    }
    for (const k of costs) if (Object.hasOwn(v, k)) out[k] = scalar(v[k], 'cost.' + k, numeric);
    if (depth === 0 && Array.isArray(v.tiers) && v.tiers.length <= 8)
      out.tiers = v.tiers.map((row) => {
        if (
          !object(row) ||
          !object(row.tier) ||
          Object.keys(row.tier).some((k) => !['type', 'size'].includes(k)) ||
          row.tier.type !== 'context' ||
          !numeric(row.tier.size)
        ) {
          add(
            'pricing_basis_changed',
            '$.provider.models.*.cost.tiers',
            'context_threshold',
            'invalid',
          );
          complete = false;
          return null;
        }
        return {
          ...(price(row, 1) as Record<string, unknown>),
          tier: { type: 'context', size: row.tier.size },
        };
      });
    else if (v.tiers !== undefined && depth === 0) {
      add('field_type', '$.provider.models.*.cost.tiers', 'bounded_array', kind(v.tiers));
      complete = false;
    }
    if (depth === 0 && v.context_over_200k !== undefined)
      out.context_over_200k = price(v.context_over_200k, 1);
    if (v.tier !== undefined && depth === 0) {
      add('pricing_basis_changed', '$.provider.models.*.cost.tier', 'reviewed_basis', 'unreviewed');
      complete = false;
    }
    return out;
  };
  for (const provider of providers) {
    const p = root[provider];
    if (!object(p) || p.id !== provider || !object(p.models)) {
      add(
        p === undefined ? 'required_field_missing' : 'identifier_or_shape_changed',
        '$.provider.models',
        'matching_provider_object',
        kind(p),
      );
      complete = false;
      continue;
    }
    for (const k of semantics)
      if (Object.hasOwn(p, k))
        add('semantics_changed', '$.provider.' + k, 'reviewed_contract', 'unreviewed_field');
    const selected: Record<string, unknown> = Object.create(null);
    for (const [id, value] of Object.entries(p.models)) {
      if (++count > (s.models?.max_models ?? 0)) {
        add('record_scope_changed', '$.provider.models', 'within_reviewed_limit', 'limit_exceeded');
        complete = false;
        break;
      }
      if (!identifier(id) || !object(value) || value.id !== id) {
        add(
          'identifier_changed',
          '$.provider.models.*.id',
          'matching_model_id',
          kind(object(value) ? value.id : value),
        );
        complete = false;
        continue;
      }
      const m: Record<string, unknown> = { id };
      for (const k of semantics)
        if (Object.hasOwn(value, k))
          add(
            'semantics_changed',
            '$.provider.models.*.' + k,
            'reviewed_contract',
            'unreviewed_field',
          );
      for (const k of ['reasoning', 'tool_call', 'structured_output', 'attachment', 'temperature'])
        if (fields.has(k) && Object.hasOwn(value, k))
          m[k] = scalar(value[k], k, (v) => typeof v === 'boolean');
      if (fields.has('canonical_model_id') && value.canonical_model_id !== undefined)
        m.canonical_model_id = scalar(value.canonical_model_id, 'canonical_model_id', identifier);
      for (const k of ['release_date', 'last_updated'])
        if (fields.has(k) && value[k] !== undefined)
          m[k] = scalar(
            value[k],
            k,
            (v) => typeof v === 'string' && (isoDate(v) || /^\d{4}-(0[1-9]|1[0-2])$/.test(v)),
          );
      if (fields.has('status') && value.status !== undefined)
        m.status = scalar(value.status, 'status', (v) =>
          ['alpha', 'beta', 'deprecated'].includes(String(v)),
        );
      for (const parent of ['limit', 'modalities']) {
        const child = value[parent];
        if (child === undefined) continue;
        if (child === null) {
          m[parent] = null;
          continue;
        }
        if (!object(child)) {
          add('field_type', '$.provider.models.*.' + parent, 'object', kind(child));
          complete = false;
          continue;
        }
        const kept: Record<string, unknown> = Object.create(null);
        for (const k of parent === 'limit' ? ['context', 'input', 'output'] : ['input', 'output'])
          if (fields.has(parent + '.' + k) && child[k] !== undefined)
            kept[k] = scalar(child[k], parent + '.' + k, (v) =>
              parent === 'limit'
                ? typeof v === 'string' && /^(0|[1-9]\d*)$/.test(v)
                : Array.isArray(v) &&
                  v.length <= 16 &&
                  v.every((x) => ['text', 'audio', 'image', 'video', 'pdf'].includes(x)),
            );
        m[parent] = kept;
      }
      if (fields.has('cost') && value.cost !== undefined) m.cost = price(value.cost);
      if (
        fields.has('experimental.modes.cost') &&
        value.experimental != null &&
        (!object(value.experimental) ||
          (value.experimental.modes != null && !object(value.experimental.modes)))
      ) {
        add('field_type', '$.provider.models.*.experimental.modes', 'object', 'invalid');
        complete = false;
      }
      if (
        fields.has('experimental.modes.cost') &&
        object(value.experimental) &&
        object(value.experimental.modes)
      ) {
        const modes: Record<string, unknown> = Object.create(null);
        const entries = Object.entries(value.experimental.modes);
        if (entries.length > 8) {
          add(
            'record_scope_changed',
            '$.provider.models.*.experimental.modes',
            'bounded_modes',
            'limit_exceeded',
          );
          complete = false;
        } else
          for (const [name, entry] of entries) {
            if (!/^[a-z0-9_-]{1,40}$/.test(name) || !object(entry)) {
              complete = false;
              add(
                'identifier_or_shape_changed',
                '$.provider.models.*.experimental.modes.*',
                'mode_object',
                kind(entry),
              );
              continue;
            }
            if (Object.keys(entry).some((k) => !['cost', 'provider'].includes(k))) {
              complete = false;
              add(
                'pricing_basis_changed',
                '$.provider.models.*.experimental.modes.*',
                'reviewed_basis',
                'unreviewed',
              );
            }
            modes[name] = {
              ...(entry.cost !== undefined ? { cost: price(entry.cost) } : {}),
              ...(entry.provider !== undefined ? { provider: {} } : {}),
            };
          }
        m.experimental = { modes };
      }
      selected[id] = m;
    }
    output[provider] = { id: provider, models: selected };
  }
  if (
    previousCount !== null &&
    previousCount > 0 &&
    (count < previousCount * 0.8 || count > previousCount * 2)
  )
    add(
      'record_scope_changed',
      '$.provider.models',
      'within_previous_count_bounds',
      'abrupt_change',
    );
  if (count === 0)
    add('record_scope_changed', '$.provider.models', 'within_reviewed_limit', 'abrupt_change');
  return {
    body: stable(wrapper ? { [wrapper]: output } : output),
    diagnostics,
    complete,
    wrapper,
    record_count: count,
  };
}

export async function recoveryPolicyHash(s: Source) {
  return hash(
    stable({
      policy: s.policy,
      endpoint: s.endpoint,
      models: s.models ?? null,
      selection: s.selection,
    }),
  );
}
