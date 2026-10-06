import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { lstat, mkdir, readFile, realpath, writeFile, rm, unlink, open } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { packageBackup, verifyBackup } from './backup-package.mjs';

const DAY = 86400000;
const API = 'https://api.cloudflare.com/client/v4';
const LIMIT = 100000;
const PAGE = 500;
const MAX_JSON = 32 * 1024 * 1024;
const SOURCES = ['ecb', 'models_dev'];
const hash = (value) => createHash('sha256').update(value).digest('hex');
const stable = (value) => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  return (
    '{' +
    Object.keys(value)
      .sort()
      .map((k) => JSON.stringify(k) + ':' + stable(value[k]))
      .join(',') +
    '}'
  );
};
class CaptureError extends Error {}
function fail(code) {
  throw new CaptureError(code);
}
const stamp = (value) =>
  typeof value === 'string' &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value) &&
  Number.isFinite(Date.parse(value));
const iso = (value) => new Date(value).toISOString();
const digest = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const safeKey = (key) =>
  typeof key === 'string' &&
  key.length <= 512 &&
  /^(evidence|archive)\/(ecb|models_dev)\/[a-zA-Z0-9_./-]+\.json$/.test(key) &&
  !key.split('/').some((p) => !p || p === '.' || p === '..');

// These are the only SQL operations exposed by the acquisition client. No arbitrary SQL.
export const QUERIES = Object.freeze({
  sources: 'SELECT source_id,policy_version,config_json FROM sources ORDER BY source_id LIMIT 257',
  policies:
    'SELECT source_id,version,configuration_hash,policy_json FROM source_policy_versions ORDER BY source_id,version LIMIT 1001',
  observations:
    'SELECT source_id,COUNT(*) AS n,MIN(observed_at) AS oldest,MAX(recorded_at) AS newest FROM observations GROUP BY source_id ORDER BY source_id',
  public:
    'SELECT source_id,COUNT(*) AS n,MIN(observed_at) AS oldest,MAX(recorded_at) AS newest FROM published_observations GROUP BY source_id ORDER BY source_id',
  gpu: 'SELECT COUNT(*) AS n FROM gpu_snapshots',
  active:
    "SELECT COUNT(*) AS n FROM collection_runs WHERE state='running' OR (lease_until IS NOT NULL AND lease_until>?)",
  artifacts:
    'SELECT artifact_ref,source_id,run_id,observed_at,expires_at,state,evidence_hash,payload_hash FROM raw_artifacts WHERE artifact_ref>? ORDER BY artifact_ref LIMIT 500',
  snapshots:
    'SELECT snapshot_id,source_id,run_id,policy_version,artifact_ref,observed_at,expires_at,state,stage,cursor,completed_at FROM model_snapshots WHERE snapshot_id>? ORDER BY snapshot_id LIMIT 500',
  schema:
    "SELECT name,type,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name",
});

export function validateCaptureConfig(config, now = Date.now()) {
  const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
  if (
    config?.schema_version !== 'nas-capture-v1' ||
    !/^[a-f0-9]{32}$/.test(config.account_id ?? '') ||
    !uuid.test(config.private_database_id ?? '') ||
    !uuid.test(config.public_database_id ?? '') ||
    config.private_database_id === config.public_database_id ||
    !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(config.bucket ?? '') ||
    !/^[a-zA-Z0-9_./:#-]{1,180}$/.test(config.approval_ref ?? '') ||
    !stamp(config.window_start) ||
    !stamp(config.window_end) ||
    Date.parse(config.window_start) > now ||
    Date.parse(config.window_end) <= now ||
    Date.parse(config.window_end) - Date.parse(config.window_start) > 3600000 ||
    !Array.isArray(config.export_hosts) ||
    config.export_hosts.length !== 1 ||
    !/^[a-z0-9-]+\.r2\.cloudflarestorage\.com$/.test(config.export_hosts[0]) ||
    !Number.isSafeInteger(config.max_total_bytes) ||
    config.max_total_bytes < 1 ||
    config.max_total_bytes > 32 * 1024 ** 3 ||
    !Number.isSafeInteger(config.max_file_bytes) ||
    config.max_file_bytes < 1 ||
    config.max_file_bytes > config.max_total_bytes ||
    !SOURCES.every((id) => digest(config.source_config_sha256?.[id])) ||
    !['private', 'public'].every((id) => digest(config.schema_sha256?.[id]))
  )
    fail('capture_config_or_approval_window_invalid');
  return config;
}

async function boundedJson(response) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > MAX_JSON) fail('response_limit_exceeded');
    chunks.push(Buffer.from(chunk));
  }
  try {
    return JSON.parse(Buffer.concat(chunks));
  } catch {
    fail('response_contract_invalid');
  }
}

export class CloudflareBackupClient {
  #token;
  constructor(
    config,
    token,
    { fetcher = fetch, now = Date.now, pause = (ms) => new Promise((r) => setTimeout(r, ms)) } = {},
  ) {
    validateCaptureConfig(config, now());
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{20,256}$/.test(token))
      fail('token_file_invalid');
    this.config = config;
    this.#token = token;
    this.fetcher = fetcher;
    this.now = now;
    this.pause = pause;
    this.base = API + '/accounts/' + config.account_id;
  }
  async request(path, body) {
    validateCaptureConfig(this.config, this.now());
    let response;
    try {
      response = await this.fetcher(this.base + path, {
        method: body ? 'POST' : 'GET',
        headers: {
          Authorization: 'Bearer ' + this.#token,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        redirect: 'error',
        signal: AbortSignal.timeout(60000),
      });
    } catch {
      fail('cloudflare_unreachable');
    }
    if (!response.ok)
      fail(
        response.status === 401 || response.status === 403
          ? 'cloudflare_authentication_failed'
          : 'cloudflare_request_failed',
      );
    return response;
  }
  async api(path, body) {
    const value = await boundedJson(await this.request(path, body));
    if (value.success !== true) fail('cloudflare_response_failed');
    return value;
  }
  db(which) {
    if (!['private', 'public'].includes(which)) fail('unknown_database');
    return '/d1/database/' + this.config[which + '_database_id'];
  }
  async query(which, name, params = []) {
    if (
      !Object.hasOwn(QUERIES, name) ||
      (which === 'public' && !['public', 'schema'].includes(name)) ||
      (which === 'private' && name === 'public') ||
      params.length !== (['active', 'artifacts', 'snapshots'].includes(name) ? 1 : 0) ||
      params.some((p) => typeof p !== 'string' || p.length > 512)
    )
      fail('query_not_allowed');
    const value = await this.api(this.db(which) + '/query', { sql: QUERIES[name], params });
    const result = value.result;
    if (
      !Array.isArray(result) ||
      result.length !== 1 ||
      result[0].success !== true ||
      result[0].meta?.changed_db !== false ||
      result[0].meta?.rows_written !== 0 ||
      !Array.isArray(result[0].results)
    )
      fail('read_only_query_not_verified');
    return result[0].results;
  }
  async objects(cursor) {
    const query = new URLSearchParams({ per_page: '1000', ...(cursor ? { cursor } : {}) });
    const result = await this.api('/r2/buckets/' + this.config.bucket + '/objects?' + query);
    if (!Array.isArray(result.result) || typeof result.result_info?.is_truncated !== 'boolean')
      fail('r2_inventory_invalid');
    return {
      objects: result.result,
      cursor: result.result_info.cursor,
      truncated: result.result_info.is_truncated,
    };
  }
  async object(key) {
    if (!safeKey(key)) fail('r2_key_not_allowed');
    return this.request(
      '/r2/buckets/' +
        this.config.bucket +
        '/objects/' +
        key.split('/').map(encodeURIComponent).join('/'),
    );
  }
  async exportDatabase(which) {
    let bookmark;
    for (let attempt = 0; attempt < 120; attempt++) {
      const value = await this.api(this.db(which) + '/export', {
        output_format: 'polling',
        ...(bookmark ? { current_bookmark: bookmark } : {}),
      });
      const result = value.result;
      if (
        result?.success !== true ||
        !['active', 'complete'].includes(result.status) ||
        typeof result.at_bookmark !== 'string' ||
        result.at_bookmark.length > 512
      )
        fail('d1_export_failed');
      bookmark = result.at_bookmark;
      if (result.status === 'complete') {
        let url;
        try {
          url = new URL(result.result?.signed_url);
        } catch {
          fail('export_url_invalid');
        }
        if (
          url.protocol !== 'https:' ||
          url.username ||
          url.password ||
          url.port ||
          url.hash ||
          !this.config.export_hosts.includes(url.hostname)
        )
          fail('export_host_not_reviewed');
        let response;
        try {
          response = await this.fetcher(url.href, {
            method: 'GET',
            redirect: 'error',
            signal: AbortSignal.timeout(20 * 60000),
          });
        } catch {
          fail('export_download_failed');
        }
        if (!response.ok) fail('export_download_failed');
        // The signed URL and authorization header are never persisted or forwarded.
        return { response, bookmark };
      }
      await this.pause(1000);
    }
    fail('d1_export_poll_limit');
  }
}

async function pages(client, name, key) {
  const all = [];
  let cursor = '';
  while (all.length <= LIMIT) {
    const rows = await client.query('private', name, [cursor]);
    if (rows.length > PAGE) fail('metadata_page_invalid');
    for (const row of rows) {
      if (typeof row[key] !== 'string' || row[key] <= cursor) fail('metadata_cursor_invalid');
      cursor = row[key];
      all.push(row);
    }
    if (all.length > LIMIT) fail('inventory_limit_exceeded');
    if (rows.length < PAGE) return all;
  }
  fail('inventory_limit_exceeded');
}

async function metadata(client, now) {
  const result = {};
  for (const name of ['sources', 'policies', 'observations', 'gpu'])
    result[name] = await client.query('private', name);
  const active = await client.query('private', 'active', [iso(now)]);
  if (active.length !== 1 || active[0].n !== 0) fail('collection_in_progress');
  result.public = await client.query('public', 'public');
  result.privateSchema = await client.query('private', 'schema');
  result.publicSchema = await client.query('public', 'schema');
  result.artifacts = await pages(client, 'artifacts', 'artifact_ref');
  result.snapshots = await pages(client, 'snapshots', 'snapshot_id');
  return result;
}

export async function inventory(client) {
  const objects = [],
    cursors = new Set(),
    keys = new Set();
  let cursor;
  for (let page = 0; page <= 100; page++) {
    const result = await client.objects(cursor);
    if (result.objects.length > 1000) fail('r2_page_invalid');
    for (const item of result.objects) {
      if (
        !safeKey(item.key) ||
        keys.has(item.key) ||
        !Number.isSafeInteger(item.size) ||
        item.size < 1 ||
        typeof item.etag !== 'string' ||
        !/^[a-fA-F0-9-]{1,80}$/.test(item.etag) ||
        !stamp(item.last_modified)
      )
        fail('r2_inventory_unreviewed_or_invalid');
      keys.add(item.key);
      objects.push({
        key: item.key,
        size: item.size,
        etag: item.etag,
        last_modified: item.last_modified,
        sha256: item.custom_metadata?.sha256 ?? null,
      });
    }
    if (objects.length > LIMIT) fail('inventory_limit_exceeded');
    if (result.truncated === false) return objects.sort((a, b) => (a.key < b.key ? -1 : 1));
    if (
      result.truncated !== true ||
      typeof result.cursor !== 'string' ||
      !result.cursor ||
      result.cursor.length > 4096 ||
      cursors.has(result.cursor)
    )
      fail('r2_cursor_invalid');
    cursors.add(result.cursor);
    cursor = result.cursor;
  }
  fail('inventory_limit_exceeded');
}

function sourceRules(meta, reviewed, config, now) {
  if (
    meta.sources.length > 256 ||
    meta.policies.length > 1000 ||
    meta.gpu.length !== 1 ||
    meta.gpu[0].n !== 0
  )
    fail('source_scope_requires_review');
  if (
    hash(stable(meta.privateSchema)) !== config.schema_sha256.private ||
    hash(stable(meta.publicSchema)) !== config.schema_sha256.public
  )
    fail('database_schema_requires_review');
  const rules = new Map();
  for (const id of SOURCES) {
    const expected = reviewed.find((s) => s.source_id === id),
      current = meta.sources.find((s) => s.source_id === id);
    if (!expected || !current) fail('source_configuration_missing');
    let source;
    try {
      source = JSON.parse(current.config_json);
    } catch {
      fail('source_configuration_invalid');
    }
    if (
      stable(source) !== stable(expected) ||
      hash(stable(source)) !== config.source_config_sha256[id] ||
      current.policy_version !== source.policy.version
    )
      fail('source_configuration_changed');
    const policyHash = hash(
      stable({
        policy: source.policy,
        adapter: source.adapter,
        endpoint: source.endpoint,
        selection: source.selection,
        ...(source.gpu ? { gpu: source.gpu } : {}),
        ...(source.models ? { models: source.models } : {}),
      }),
    );
    const policy = meta.policies.find(
      (p) => p.source_id === id && p.version === source.policy.version,
    );
    if (
      !policy ||
      policy.configuration_hash !== policyHash ||
      stable(JSON.parse(policy.policy_json)) !== stable(source.policy)
    )
      fail('source_policy_hash_mismatch');
    if (
      source.policy.rights.private_storage !== 'allowed' ||
      !stamp(source.policy.valid_from) ||
      Date.parse(source.policy.valid_from) > now ||
      !stamp(source.policy.valid_until) ||
      Date.parse(source.policy.valid_until) <= now ||
      !Number.isInteger(source.policy.retention_days) ||
      source.policy.retention_days < 1
    )
      fail('private_storage_not_allowed');
    const retention =
      id === 'models_dev'
        ? source.models?.retention
        : {
            evidence_days: source.policy.retention_days,
            archive_days: source.policy.retention_days,
            normalized_days: source.policy.retention_days,
            backup_days: 30,
          };
    if (
      !retention ||
      !['evidence_days', 'archive_days', 'normalized_days', 'backup_days'].every(
        (k) => Number.isSafeInteger(retention[k]) && retention[k] > 0,
      ) ||
      retention.backup_days > 30
    )
      fail('retention_requires_review');
    rules.set(id, {
      ...retention,
      valid_until: Date.parse(source.policy.valid_until),
      limit: source.policy.retention_limit_days ?? Infinity,
    });
  }
  let dbDeadline = now + 30 * DAY;
  for (const rows of [meta.observations, meta.public])
    for (const row of rows) {
      const rule = rules.get(row.source_id);
      if (
        !rule ||
        !Number.isSafeInteger(row.n) ||
        row.n < 1 ||
        !stamp(row.oldest) ||
        Date.parse(row.oldest) > now
      )
        fail('stored_source_requires_review');
      const originalDeadline =
        Date.parse(row.oldest) + Math.min(rule.normalized_days, rule.limit) * DAY;
      if (originalDeadline <= now) fail('expired_normalized_data_requires_cleanup');
      dbDeadline = Math.min(
        dbDeadline,
        originalDeadline,
        rule.valid_until,
        now + rule.backup_days * DAY,
      );
    }
  for (const snap of meta.snapshots) {
    if (
      !rules.has(snap.source_id) ||
      !stamp(snap.expires_at) ||
      !stamp(snap.observed_at) ||
      Date.parse(snap.expires_at) <= now ||
      Date.parse(snap.observed_at) > now
    )
      fail('snapshot_retention_requires_review');
    dbDeadline = Math.min(dbDeadline, Date.parse(snap.expires_at));
  }
  return { rules, dbDeadline };
}

function objectDeadlines(meta, objects, rules, now) {
  const artifacts = new Map(meta.artifacts.map((a) => [a.artifact_ref, a]));
  const snapshots = new Map(meta.snapshots.map((s) => [s.source_id + '/' + s.snapshot_id, s]));
  const runs = new Map();
  const listed = new Set(objects.map((o) => o.key));
  for (const a of meta.artifacts) {
    if (
      !rules.has(a.source_id) ||
      !stamp(a.observed_at) ||
      !stamp(a.expires_at) ||
      Date.parse(a.observed_at) > now
    )
      fail('artifact_metadata_invalid');
    const runKey = a.source_id + '/' + a.run_id;
    runs.set(runKey, Math.min(runs.get(runKey) ?? Infinity, Date.parse(a.observed_at)));
    if (a.state === 'retained' && Date.parse(a.expires_at) > now && !listed.has(a.artifact_ref))
      fail('retained_evidence_missing');
  }
  return objects.map((object) => {
    const [kind, source, group, snapshot] = object.key.split('/'),
      rule = rules.get(source);
    let observed,
      storedExpiry = Infinity;
    if (kind === 'evidence') {
      const artifact = artifacts.get(object.key);
      if (!artifact || artifact.source_id !== source || artifact.state !== 'retained')
        fail('unindexed_evidence_requires_review');
      observed = Date.parse(artifact.observed_at);
      storedExpiry = Date.parse(artifact.expires_at);
    } else if (group === 'models') {
      const entry = snapshots.get(source + '/' + snapshot);
      if (!entry) fail('unindexed_archive_requires_review');
      observed = Date.parse(entry.observed_at);
    } else {
      observed = runs.get(source + '/' + group);
      if (observed === undefined) fail('unindexed_archive_requires_review');
    }
    if (
      !rule ||
      !Number.isFinite(observed) ||
      observed > now ||
      (kind === 'archive' && !digest(object.sha256))
    )
      fail('object_metadata_invalid');
    const deadline = Math.min(
      observed +
        Math.min(kind === 'evidence' ? rule.evidence_days : rule.archive_days, rule.limit) * DAY,
      storedExpiry,
      rule.valid_until,
      now + rule.backup_days * DAY,
    );
    return { ...object, delete_after: iso(deadline), expired: deadline <= now };
  });
}

async function download(
  response,
  destination,
  { limit, expectedBytes, expectedHash, expectedEtag, budget },
) {
  if (!response.ok || !response.body) fail('download_failed');
  if (expectedEtag && response.headers.get('etag')?.replace(/^"|"$/g, '') !== expectedEtag)
    fail('object_changed_during_capture');
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const h = createHash('sha256');
  let bytes = 0;
  const meter = new Transform({
    transform(chunk, _encoding, done) {
      bytes += chunk.length;
      budget.bytes += chunk.length;
      if (
        bytes > limit ||
        budget.bytes > budget.limit ||
        (expectedBytes !== undefined && bytes > expectedBytes)
      ) {
        done(new CaptureError('capture_byte_limit'));
        return;
      }
      h.update(chunk);
      done(null, chunk);
    },
  });
  await pipeline(
    response.body,
    meter,
    createWriteStream(destination, { flags: 'wx', mode: 0o600 }),
  );
  const sha256 = h.digest('hex');
  if (
    bytes < 1 ||
    (expectedBytes !== undefined && bytes !== expectedBytes) ||
    (expectedHash && sha256 !== expectedHash)
  )
    fail('download_integrity_failed');
  return { bytes, sha256 };
}

async function verifyEvidence(file, entry, indexes) {
  if (!entry.key.startsWith('evidence/')) return;
  if (entry.size > MAX_JSON) fail('evidence_envelope_limit');
  let envelope;
  try {
    envelope = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    fail('evidence_envelope_invalid');
  }
  const indexed = indexes.artifacts.get(entry.key);
  const quarantine = entry.key.endsWith('.quarantine.json');
  const version = quarantine ? envelope.policy_version : envelope.source_policy_version;
  const recordedPolicy = indexes.policies.get(indexed.source_id + '/' + version);
  if (
    !recordedPolicy ||
    JSON.parse(recordedPolicy.policy_json)?.rights?.private_storage !== 'allowed' ||
    envelope.source_id !== indexed.source_id ||
    envelope.observed_at !== indexed.observed_at ||
    (quarantine ? envelope.source_payload_hash : envelope.payload_hash) !== indexed.payload_hash ||
    (quarantine ? envelope.body_hash : envelope.evidence_hash) !== indexed.evidence_hash ||
    !digest(indexed.evidence_hash) ||
    (typeof envelope.body !== 'string' && !(quarantine && envelope.body === null)) ||
    hash(envelope.body ?? '') !== indexed.evidence_hash
  )
    fail('evidence_provenance_mismatch');
  if (
    quarantine &&
    (envelope.format !== 'quarantine_evidence_v1' ||
      envelope.run_id !== indexed.run_id ||
      envelope.expires_at !== indexed.expires_at ||
      envelope.purpose !== 'recovery_only_never_public')
  )
    fail('quarantine_provenance_mismatch');
  if (
    !quarantine &&
    !(indexed.source_id === 'ecb'
      ? envelope.format === 'ecb_xml'
      : ['models_projection_v1', 'models_projection_v2'].includes(envelope.format))
  )
    fail('evidence_format_requires_review');
}

// Runs only on a private operator/NAS runner. Source bodies never enter an agent prompt.
// Any unindexed object blocks a complete capture; it is not silently omitted.
async function captureLocked(
  config,
  { client, reviewedSources, outputRoot, stagingRoot, recipient, ageBinary, now = Date.now },
) {
  const started = now();
  validateCaptureConfig(config, started);
  const before = await metadata(client, started),
    objects = await inventory(client);
  const { rules, dbDeadline } = sourceRules(before, reviewedSources, config, started);
  const entries = objectDeadlines(before, objects, rules, started);
  const retained = entries.filter((e) => !e.expired);
  if (retained.length > LIMIT - 2) fail('inventory_limit_exceeded');
  const indexes = {
    artifacts: new Map(before.artifacts.map((a) => [a.artifact_ref, a])),
    policies: new Map(before.policies.map((p) => [p.source_id + '/' + p.version, p])),
  };
  if (
    retained.some((e) => e.size > config.max_file_bytes) ||
    retained.reduce((n, e) => n + e.size, 0) >= config.max_total_bytes
  )
    fail('capture_byte_limit');
  const parent = await realpath(outputRoot);
  if (!(await lstat(parent)).isDirectory()) fail('output_root_invalid');
  const id = 'backup-' + iso(started).replace(/[^0-9]/g, '') + '-' + randomUUID();
  const directory = join(parent, id);
  await mkdir(directory, { mode: 0o700 });
  const stageParent = await realpath(stagingRoot);
  if (stageParent === parent) fail('separate_staging_required');
  const staging = join(stageParent, id),
    encrypted = join(directory, 'encrypted');
  await mkdir(staging, { mode: 0o700 });
  const files = [],
    bookmarks = {},
    budget = { bytes: 0, limit: config.max_total_bytes };
  // Use a private tmpfs for plaintext. Only this newly-created child may be removed.
  async function cleanStaging() {
    if (
      dirname(staging) !== stageParent ||
      (await realpath(staging)) !== staging ||
      (await lstat(staging)).isSymbolicLink()
    )
      fail('staging_cleanup_path_invalid');
    await rm(staging, { recursive: true, force: false });
  }
  try {
    for (const which of ['private', 'public']) {
      validateCaptureConfig(config, now());
      const exported = await client.exportDatabase(which);
      const path = 'd1/' + which + '.sql';
      files.push({
        path,
        ...(await download(exported.response, join(staging, path), {
          limit: config.max_file_bytes,
          budget,
        })),
        delete_after: iso(dbDeadline),
      });
      bookmarks[which] = exported.bookmark;
    }
    for (const entry of retained) {
      validateCaptureConfig(config, now());
      files.push({
        path: entry.key,
        ...(await download(await client.object(entry.key), join(staging, entry.key), {
          limit: config.max_file_bytes,
          expectedBytes: entry.size,
          expectedEtag: entry.etag,
          expectedHash: entry.sha256,
          budget,
        })),
        delete_after: entry.delete_after,
      });
      await verifyEvidence(join(staging, entry.key), entry, indexes);
    }
    const after = await metadata(client, now()),
      afterObjects = await inventory(client);
    if (stable(before) !== stable(after) || stable(objects) !== stable(afterObjects))
      fail('inventory_changed_during_capture');
    const finished = now();
    validateCaptureConfig(config, finished);
    const deadline = files.reduce((n, f) => Math.min(n, Date.parse(f.delete_after)), dbDeadline);
    if (deadline <= finished) fail('capture_expired_before_completion');
    const plan = {
      schema_version: 'backup-input-v1',
      snapshot_id: id,
      captured_at: iso(started),
      delete_after: iso(deadline),
      inventory_complete: true,
      files,
    };
    const audit = {
      schema_version: 'backup-capture-audit-v1',
      captured_at: iso(started),
      finished_at: iso(finished),
      delete_after: iso(deadline),
      databases_exported: 2,
      r2_listed: objects.length,
      r2_copied: retained.length,
      r2_expired_excluded: entries.length - retained.length,
      metadata_sha256: hash(stable(before)),
      inventory_sha256: hash(stable(objects)),
      source_config_sha256: config.source_config_sha256,
      schema_sha256: config.schema_sha256,
      bookmarks,
      cross_database_atomic: false,
      restore_verified: false,
      publication_allowed: false,
    };
    await writeFile(join(directory, 'capture-audit.json'), JSON.stringify(audit), {
      flag: 'wx',
      mode: 0o600,
    });
    plan.capture_audit_sha256 = hash(JSON.stringify(audit));
    const packaged = await packageBackup(plan, {
      inputRoot: staging,
      outputDir: encrypted,
      recipient,
      ageBinary,
      now: finished,
    });
    const receipt = await verifyBackup(encrypted, now());
    await cleanStaging();
    const result = {
      ...packaged,
      encrypted_bytes: receipt.files.reduce((n, f) => n + f.bytes, 0),
      restore_verified: false,
      plaintext_cleanup_required: false,
      r2_copied: retained.length,
      r2_expired_excluded: entries.length - retained.length,
      cross_database_atomic: false,
    };
    await writeFile(join(directory, 'status.json'), JSON.stringify(result), {
      flag: 'wx',
      mode: 0o600,
    });
    return { result, directory };
  } catch (error) {
    let cleanupRequired = true;
    try {
      await cleanStaging();
      cleanupRequired = false;
    } catch {}
    await writeFile(
      join(directory, 'status.json'),
      JSON.stringify({
        status: 'failed',
        complete: false,
        code: error instanceof CaptureError ? error.message : 'capture_failed',
        plaintext_cleanup_required: cleanupRequired,
      }),
      { flag: 'wx', mode: 0o600 },
    ).catch(() => {});
    throw error;
  }
}

export async function captureBackup(config, options) {
  validateCaptureConfig(config, (options.now ?? Date.now)());
  if (
    !/^age1[a-z0-9]{58}$/.test(options.recipient ?? '') ||
    !isAbsolute(options.ageBinary ?? '') ||
    !options.stagingRoot
  )
    fail('encryption_or_staging_unconfigured');
  const parent = await realpath(options.outputRoot),
    lock = join(parent, '.capture.lock');
  let handle;
  try {
    handle = await open(lock, 'wx', 0o600);
  } catch {
    fail('capture_locked_or_output_unavailable');
  }
  try {
    return await captureLocked(config, options);
  } finally {
    await handle.close();
    await unlink(lock);
  }
}

export function reviewHashes(sources, schemas) {
  return {
    source_config_sha256: Object.fromEntries(sources.map((s) => [s.source_id, hash(stable(s))])),
    schema_sha256: Object.fromEntries(
      Object.entries(schemas).map(([k, v]) => [k, hash(stable(v))]),
    ),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 4 || args[0] !== '--remote' || args[1] !== '--allow-network')
      fail('explicit_network_flags_required');
    const configPath = resolve(args[2]);
    if ((await lstat(configPath)).size > 16384) fail('config_too_large');
    const config = validateCaptureConfig(JSON.parse(await readFile(configPath, 'utf8')));
    const tokenFile = process.env.BACKUP_CLOUDFLARE_TOKEN_FILE;
    if (!tokenFile || !isAbsolute(tokenFile)) fail('protected_token_file_required');
    const tokenStat = await lstat(tokenFile);
    if (
      !tokenStat.isFile() ||
      tokenStat.isSymbolicLink() ||
      tokenStat.size > 512 ||
      (process.platform !== 'win32' && tokenStat.mode & 0o077)
    )
      fail('protected_token_file_required');
    const token = (await readFile(tokenFile, 'utf8')).trim();
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const reviewedSources = await Promise.all(
      SOURCES.map(async (id) =>
        JSON.parse(await readFile(join(root, 'config/sources', id + '.json'), 'utf8')),
      ),
    );
    const result = await captureBackup(config, {
      client: new CloudflareBackupClient(config, token),
      reviewedSources,
      outputRoot: args[3],
      stagingRoot: process.env.BACKUP_STAGING_ROOT,
      recipient: process.env.BACKUP_AGE_RECIPIENT,
      ageBinary: process.env.AGE_BINARY,
    });
    console.log(JSON.stringify(result.result));
  } catch (error) {
    console.error(
      JSON.stringify({
        status: 'failed',
        complete: false,
        code: error instanceof CaptureError ? error.message : 'capture_failed',
      }),
    );
    process.exitCode = 1;
  }
}
