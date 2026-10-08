import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import {
  CloudflareBackupClient,
  captureBackup,
  inventory,
  reviewHashes,
  validateCaptureConfig,
  QUERIES,
} from './backup-capture.mjs';
import { decryptBackup } from './backup-package.mjs';

const NOW = Date.parse('2026-10-06T01:00:00.000Z');
const DAY = 86400000;
const iso = (n) => new Date(n).toISOString();
const sha = (s) => createHash('sha256').update(s).digest('hex');
const stable = (v) =>
  v === null || typeof v !== 'object'
    ? JSON.stringify(v)
    : Array.isArray(v)
      ? '[' + v.map(stable).join(',') + ']'
      : '{' +
        Object.keys(v)
          .sort()
          .map((k) => JSON.stringify(k) + ':' + stable(v[k]))
          .join(',') +
        '}';
const sourceConfigs = await Promise.all(
  ['ecb', 'models_dev'].map(async (id) =>
    JSON.parse(await readFile('config/sources/' + id + '.json', 'utf8')),
  ),
);
const schema = [
  { name: 'synthetic', type: 'table', sql: 'CREATE TABLE synthetic(id TEXT PRIMARY KEY)' },
];
const config = {
  schema_version: 'nas-capture-v1',
  account_id: 'a'.repeat(32),
  private_database_id: '11111111-1111-1111-1111-111111111111',
  public_database_id: '22222222-2222-2222-2222-222222222222',
  bucket: 'synthetic-only',
  approval_ref: 'synthetic-only',
  window_start: iso(NOW - 1000),
  window_end: iso(NOW + 1800000),
  export_hosts: ['synthetic.r2.cloudflarestorage.com'],
  max_total_bytes: 10000000,
  max_file_bytes: 1000000,
  ...reviewHashes(sourceConfigs, { private: schema, public: schema }),
};
const policyHash = (s) =>
  sha(
    stable({
      policy: s.policy,
      adapter: s.adapter,
      endpoint: s.endpoint,
      selection: s.selection,
      ...(s.gpu ? { gpu: s.gpu } : {}),
      ...(s.models ? { models: s.models } : {}),
    }),
  );

function fixture() {
  const meta = {
    sources: sourceConfigs.map((s) => ({
      source_id: s.source_id,
      policy_version: s.policy.version,
      config_json: JSON.stringify(s),
    })),
    policies: sourceConfigs.map((s) => ({
      source_id: s.source_id,
      version: s.policy.version,
      configuration_hash: policyHash(s),
      policy_json: JSON.stringify(s.policy),
    })),
    observations: sourceConfigs.map((s) => ({
      source_id: s.source_id,
      n: 2,
      oldest: iso(NOW - DAY),
      newest: iso(NOW - DAY),
    })),
    public: sourceConfigs.map((s) => ({
      source_id: s.source_id,
      n: 2,
      oldest: iso(NOW - DAY),
      newest: iso(NOW - DAY),
    })),
    gpu: [{ n: 0 }],
    active: [{ n: 0 }],
    schema,
    artifacts: [],
    snapshots: [],
    gpuSnapshots: [],
    gpuPages: [],
  };
  const bodies = {},
    objects = [];
  for (const s of sourceConfigs) {
    const key = 'evidence/' + s.source_id + '/synthetic.json';
    const body = s.source_id === 'ecb' ? '<synthetic />' : '{"synthetic":true}';
    const envelope = {
      source_id: s.source_id,
      source_policy_version: s.policy.version,
      format: s.source_id === 'ecb' ? 'ecb_xml' : 'models_projection_v2',
      observed_at: iso(NOW - DAY),
      body,
      payload_hash: sha(body),
      evidence_hash: sha(body),
      synthetic: true,
    };
    bodies[key] = JSON.stringify(envelope);
    objects.push({
      key,
      size: Buffer.byteLength(bodies[key]),
      etag: 'ab'.repeat(16),
      last_modified: iso(NOW - DAY),
    });
    meta.artifacts.push({
      artifact_ref: key,
      source_id: s.source_id,
      run_id: 'synthetic',
      observed_at: iso(NOW - DAY),
      expires_at: iso(NOW + 2 * DAY),
      state: 'retained',
      evidence_hash: sha(body),
      payload_hash: sha(body),
    });
  }
  meta.artifacts.sort((a, b) => a.artifact_ref.localeCompare(b.artifact_ref));
  const sql =
    "CREATE TABLE observations(id TEXT PRIMARY KEY, observed_at TEXT, fingerprint TEXT); INSERT INTO observations VALUES('synthetic-1','2026-10-05T01:00:00.000Z','synthetic-fingerprint'); CREATE TRIGGER immutable BEFORE UPDATE ON observations BEGIN SELECT RAISE(ABORT,'append-only'); END;";
  const calls = [];
  const client = {
    async query(which, name, params = []) {
      calls.push({ kind: 'query', which, name });
      let rows = meta[name];
      if (['artifacts', 'snapshots', 'gpuSnapshots', 'gpuPages'].includes(name))
        rows = rows
          .filter(
            (r) =>
              r[
                name === 'artifacts'
                  ? 'artifact_ref'
                  : name === 'gpuPages'
                    ? 'page_key'
                    : 'snapshot_id'
              ] > params[0],
          )
          .slice(0, 500);
      return structuredClone(rows);
    },
    async objects(cursor) {
      calls.push({ kind: 'list' });
      const page = cursor ? Number(cursor) : 0;
      return {
        objects: [objects[page]].filter(Boolean),
        truncated: page + 1 < objects.length,
        cursor: page + 1 < objects.length ? String(page + 1) : undefined,
      };
    },
    async object(key) {
      calls.push({ kind: 'object', key });
      return new Response(bodies[key], {
        headers: { etag: '"' + objects.find((o) => o.key === key).etag + '"' },
      });
    },
    async exportDatabase(which) {
      calls.push({ kind: 'export', which });
      return { response: new Response(sql), bookmark: 'synthetic-' + which };
    },
  };
  return { meta, bodies, objects, client, calls, sql };
}

async function dirs() {
  await mkdir('work/backup-capture-tests', { recursive: true });
  const root = await mkdtemp(resolve('work/backup-capture-tests/synthetic-'));
  const output = join(root, 'output'),
    staging = join(root, 'staging');
  await mkdir(output);
  await mkdir(staging);
  return { root, output, staging };
}
const pocSource = JSON.parse(await readFile('config/sources/price_of_compute.json', 'utf8'));
// A synthetic backup policy has fixed dates, independent of rollout timing.
pocSource.policy.version = 'synthetic-poc-backup-v1';
pocSource.policy.valid_from = '2026-01-01T00:00:00.000Z';
pocSource.policy.valid_until = '2030-01-01T00:00:00.000Z';
function pocFixture(ageDays = 6) {
  const f = fixture(),
    s = structuredClone(pocSource),
    observed = iso(NOW - ageDays * DAY);
  const sources = [...sourceConfigs, s];
  const snapshot = sha('synthetic-poc-snapshot'),
    run = 'synthetic-poc-run';
  const scope = {
    adapter: s.adapter,
    endpoint: s.endpoint,
    partition: s.gpu.partitions[0],
    classification_version: 'gpu-price-of-compute-20261005.2',
    page_size: 50,
    region_map: {},
    market_scope: 'observed_search_only',
  };
  const metadata = {
    projection: 'poc_private_projection_v1',
    source_id: s.source_id,
    source_url: 'https://priceofcompute.com/api/v1/prices/h100-sxm',
    source_day: observed.slice(0, 10),
    source_updated_at: observed,
    retrieved_at: observed,
    attribution: { text: 'Data: Price of Compute', url: 'https://www.priceofcompute.com/' },
  };
  const projection = {
    records: [
      {
        provider: 'Synthetic provider',
        amount_decimal: '1.250000000000000001',
        currency: 'USD',
        billing_unit: 'gpu_hour',
        observation_basis: 'advertised_quote',
        price_of_compute: { ...metadata, requested_sku: 'h100-sxm' },
      },
    ],
    price_of_compute: metadata,
  };
  const evidence = 'evidence/price_of_compute/' + run + '/' + snapshot + '/0.json';
  const archive =
    'archive/price_of_compute/' + snapshot + '/0-gpu-price-of-compute-20261005.2.json';
  const body = stable(projection),
    payload = sha('synthetic-only-upstream');
  const envelope = {
    format: 'gpu_projection_v1',
    body,
    observed_at: observed,
    response_status: 200,
    payload_hash: payload,
    evidence_hash: sha(body),
    synthetic: false,
    source_id: s.source_id,
    source_policy_version: s.policy.version,
    gpu_page: {
      snapshot_id: snapshot,
      partition_id: 'h100-sxm',
      scope_hash: sha(stable(scope)),
      page_number: 0,
      next_page: null,
      reported_total: 1,
      received_count: 1,
      complete: true,
      issues: [],
    },
  };
  f.meta.sources.push({
    source_id: s.source_id,
    policy_version: s.policy.version,
    config_json: JSON.stringify(s),
  });
  f.meta.policies.push({
    source_id: s.source_id,
    version: s.policy.version,
    configuration_hash: policyHash(s),
    policy_json: JSON.stringify(s.policy),
  });
  f.meta.observations.push({ source_id: s.source_id, n: 1, oldest: observed, newest: observed });
  f.meta.gpu = [{ n: 1 }];
  f.meta.gpuSnapshots = [
    {
      snapshot_id: snapshot,
      run_id: run,
      source_id: s.source_id,
      policy_version: s.policy.version,
      dataset: 'gpu_rental',
      partition_id: 'h100-sxm',
      scope_hash: sha(stable(scope)),
      scope_json: stable(scope),
      state: 'complete',
      started_at: observed,
      completed_at: observed,
      received_count: 1,
      member_count: 1,
      processing_stage: 'done',
      data_origin: 'live',
    },
  ];
  f.meta.gpuPages = [
    {
      page_key: snapshot + '/00000000',
      snapshot_id: snapshot,
      page_number: 0,
      artifact_ref: evidence,
      observed_at: observed,
      received_count: 1,
      payload_hash: payload,
      evidence_hash: sha(body),
    },
  ];
  f.bodies[evidence] = JSON.stringify(envelope);
  f.bodies[archive] = stable({
    schema_version: '1',
    snapshot_id: snapshot,
    page_number: 0,
    observations: [{ synthetic: true, domain: projection.records[0] }],
  });
  for (const key of [evidence, archive]) {
    f.objects.push({
      key,
      size: Buffer.byteLength(f.bodies[key]),
      etag: 'cd'.repeat(16),
      last_modified: observed,
    });
    f.meta.artifacts.push({
      artifact_ref: key,
      source_id: s.source_id,
      run_id: run,
      observed_at: observed,
      expires_at: iso(Date.parse(observed) + 7 * DAY),
      state: 'retained',
      payload_hash: key === evidence ? payload : sha(f.bodies[key]),
      evidence_hash: key === evidence ? sha(body) : sha(f.bodies[key]),
    });
  }
  f.meta.artifacts.sort((a, b) => a.artifact_ref.localeCompare(b.artifact_ref));
  return {
    ...f,
    reviewedSources: sources,
    config: { ...config, ...reviewHashes(sources, { private: schema, public: schema }) },
    evidence,
    archive,
  };
}
const dummyEncryption = { recipient: 'age1' + 'a'.repeat(58), ageBinary: resolve('never-run-age') };
async function rejectCapture(f, pattern, overrides = {}) {
  const d = await dirs();
  await assert.rejects(
    () =>
      captureBackup(f.config ?? config, {
        client: f.client,
        reviewedSources: f.reviewedSources ?? sourceConfigs,
        outputRoot: d.output,
        stagingRoot: d.staging,
        ...dummyEncryption,
        now: () => NOW,
        ...overrides,
      }),
    pattern,
  );
  assert.deepEqual(await readdir(d.staging), [], 'failed downloads leave no plaintext staging');
  assert.ok(!(await readdir(d.output)).includes('.capture.lock'));
  return d;
}

test('capture approval window, exact source/schema bindings and byte caps are mandatory', () => {
  assert.equal(validateCaptureConfig(config, NOW), config);
  for (const change of [
    { window_end: iso(NOW) },
    { window_start: iso(NOW + 1) },
    { window_end: iso(NOW + 2 * 3600000) },
    { approval_ref: '' },
    { max_total_bytes: 0 },
    { export_hosts: ['example.com'] },
    { public_database_id: config.private_database_id },
    { source_config_sha256: {} },
  ])
    assert.throws(() => validateCaptureConfig({ ...config, ...change }, NOW), /invalid/);
});

test('R2 enumeration includes more than 1000 objects and refuses cursor loops, unknown sources and traversal', async () => {
  const item = (i) => ({
    key: 'evidence/ecb/' + i + '.json',
    size: 1,
    etag: 'ab',
    last_modified: iso(NOW),
  });
  const all = await inventory({
    objects: async (cursor) =>
      cursor
        ? { objects: [item(1000)], truncated: false }
        : {
            objects: Array.from({ length: 1000 }, (_, i) => item(i)),
            truncated: true,
            cursor: 'p2',
          },
  });
  assert.equal(all.length, 1001);
  await assert.rejects(
    () => inventory({ objects: async () => ({ objects: [], truncated: true, cursor: 'loop' }) }),
    /cursor/,
  );
  for (const key of [
    'evidence/unknown/a.json',
    'evidence/ecb/../a.json',
    'archive/models_dev//a.json',
  ])
    await assert.rejects(
      () =>
        inventory({ objects: async () => ({ objects: [{ ...item(0), key }], truncated: false }) }),
      /unreviewed/,
    );
});

test('no export starts after policy/schema drift, collection in progress, new GPU data or expired normalized records', async () => {
  for (const mutate of [
    (f) => {
      f.meta.sources[0].config_json = '{}';
    },
    (f) => {
      f.meta.schema[0].sql += ' -- changed';
    },
    (f) => {
      f.meta.active[0].n = 1;
    },
    (f) => {
      f.meta.gpu[0].n = 1;
    },
    (f) => {
      f.meta.observations[0].source_id = 'unreviewed';
    },
    (f) => {
      f.meta.observations[0].oldest = '2020-01-01T00:00:00.000Z';
    },
    (f) => {
      f.meta.policies[0].configuration_hash = '0'.repeat(64);
    },
  ]) {
    const f = fixture();
    f.meta.schema = structuredClone(schema);
    mutate(f);
    await rejectCapture(f, /changed|review|progress|cleanup|mismatch/);
    assert.equal(f.calls.filter((c) => c.kind === 'export').length, 0);
  }
});

test('unindexed and missing retained evidence block capture without silently claiming a complete inventory', async () => {
  const orphan = fixture();
  orphan.meta.artifacts.pop();
  await rejectCapture(orphan, /unindexed/);
  const missing = fixture();
  missing.objects.pop();
  await rejectCapture(missing, /retained_evidence_missing/);
});

test('changed object, untrusted envelope, truncated download and in-flight inventory changes fail with no completed bundle', async () => {
  for (const mutate of [
    (f) => {
      f.client.object = async () => new Response('bad', { headers: { etag: '"different"' } });
    },
    (f) => {
      const key = f.objects[0].key;
      const env = JSON.parse(f.bodies[key]);
      env.body = '<corrupted />';
      f.bodies[key] = JSON.stringify(env);
      f.objects[0].size = Buffer.byteLength(f.bodies[key]);
    },
    (f) => {
      f.client.object = async () =>
        new Response('x', { headers: { etag: '"' + 'ab'.repeat(16) + '"' } });
    },
    (f) => {
      const original = f.client.query;
      let n = 0;
      f.client.query = async (...args) => {
        const rows = await original(...args);
        if (args[1] === 'observations' && ++n === 2) rows[0].n++;
        return rows;
      };
    },
  ]) {
    const f = fixture();
    mutate(f);
    const d = await rejectCapture(f, /changed|provenance|integrity/);
    for (const child of await readdir(d.output))
      await assert.rejects(() => readFile(join(d.output, child, 'encrypted/complete.json')));
  }
});

test('only fixed SELECT/export requests carry the token; signed download has no credentials and no redirects', async () => {
  const requests = [];
  const token = 'synthetic_' + 'a'.repeat(32);
  const client = new CloudflareBackupClient(config, token, {
    now: () => NOW,
    pause: async () => {},
    fetcher: async (url, opt) => {
      requests.push({ url: String(url), opt });
      if (String(url).startsWith('https://synthetic.')) return new Response('SQL');
      if (String(url).endsWith('/query'))
        return Response.json({
          success: true,
          result: [{ success: true, meta: { changed_db: false, rows_written: 0 }, results: [] }],
        });
      return Response.json({
        success: true,
        result: {
          success: true,
          status: 'complete',
          at_bookmark: 'bookmark',
          result: {
            signed_url: 'https://synthetic.r2.cloudflarestorage.com/only.sql?signature=synthetic',
          },
        },
      });
    },
  });
  await client.query('private', 'sources');
  await client.exportDatabase('private');
  assert.equal(requests.length, 3);
  assert.equal(requests[0].opt.headers.Authorization, 'Bearer ' + token);
  assert.equal(requests[2].opt.headers, undefined);
  assert.ok(requests.every((r) => r.opt.redirect === 'error'));
  assert.equal(JSON.parse(requests[0].opt.body).sql, QUERIES.sources);
  await assert.rejects(() => client.query('private', 'DELETE FROM observations'), /not_allowed/);
  await assert.rejects(() => client.query('public', 'sources'), /not_allowed/);
});

test('export polling uses bookmarks and blocks unreviewed hosts, malformed status and excessive polling', async () => {
  for (const mode of ['redirect', 'error', 'endless']) {
    const calls = [];
    const client = new CloudflareBackupClient(config, 'a'.repeat(32), {
      now: () => NOW,
      pause: async () => {},
      fetcher: async (url, opt) => {
        calls.push(JSON.parse(opt.body));
        return Response.json({
          success: true,
          result:
            mode === 'endless'
              ? { success: true, status: 'active', at_bookmark: 'p' + calls.length }
              : mode === 'error'
                ? { success: true, status: 'error', error: 'SECRET_DO_NOT_PRINT' }
                : {
                    success: true,
                    status: 'complete',
                    at_bookmark: 'b',
                    result: { signed_url: 'https://attacker.example/collect' },
                  },
        });
      },
    });
    await assert.rejects(
      () => client.exportDatabase('public'),
      /export_host_not_reviewed|d1_export_failed|d1_export_poll_limit/,
    );
    if (mode === 'endless') {
      assert.equal(calls.length, 120);
      assert.equal(calls[1].current_bookmark, 'p1');
    }
  }
});

test('concurrent capture is locked before any source or export request', async () => {
  const f = fixture(),
    d = await dirs();
  await writeFile(join(d.output, '.capture.lock'), 'synthetic');
  await assert.rejects(
    () =>
      captureBackup(config, {
        client: f.client,
        reviewedSources: sourceConfigs,
        outputRoot: d.output,
        stagingRoot: d.staging,
        ...dummyEncryption,
        now: () => NOW,
      }),
    /locked/,
  );
  assert.equal(f.calls.length, 0);
  assert.equal(await readFile(join(d.output, '.capture.lock'), 'utf8'), 'synthetic');
});

test('PoC capture requires the exact approved source and indexed scope; unknown GPU sources remain blocked', async () => {
  for (const mutate of [
    (f) => {
      delete f.config.source_config_sha256.price_of_compute;
    },
    (f) => {
      f.meta.gpuSnapshots[0].source_id = 'lambda';
    },
    (f) => {
      f.meta.gpuSnapshots[0].scope_hash = '0'.repeat(64);
    },
    (f) => {
      f.meta.gpuSnapshots[0].partition_id = 'b200';
    },
    (f) => {
      f.meta.gpuPages[0].payload_hash = '0'.repeat(64);
    },
    (f) => {
      f.meta.gpuSnapshots[0].started_at = '2025-01-01T00:00:00.000Z';
    },
    (f) => {
      f.meta.artifacts = f.meta.artifacts.filter((a) => a.artifact_ref !== f.archive);
    },
    (f) => {
      f.meta.gpuPages = [];
    },
    (f) => {
      f.meta.gpuSnapshots[0].member_count = 2;
    },
    (f) => {
      f.meta.gpuSnapshots[0].received_count = 2;
    },
    (f) => {
      f.meta.public.push({
        source_id: 'price_of_compute',
        n: 1,
        oldest: iso(NOW),
        newest: iso(NOW),
      });
    },
  ]) {
    const f = pocFixture();
    mutate(f);
    await rejectCapture(f, /review|mismatch|cleanup|unindexed/);
    assert.equal(f.calls.filter((c) => c.kind === 'export').length, 0);
  }
});

test('PoC raw-shaped content and modified archives cannot become completed backups', async () => {
  for (const mutate of [
    (f) => {
      const e = JSON.parse(f.bodies[f.evidence]);
      e.format = 'raw_json';
      f.bodies[f.evidence] = JSON.stringify(e);
    },
    (f) => {
      const e = JSON.parse(f.bodies[f.evidence]);
      e.gpu_page.snapshot_id = sha('other');
      f.bodies[f.evidence] = JSON.stringify(e);
    },
    (f) => {
      f.bodies[f.archive] += ' ';
    },
  ]) {
    const f = pocFixture();
    mutate(f);
    for (const o of f.objects) o.size = Buffer.byteLength(f.bodies[o.key]);
    await rejectCapture(f, /review|mismatch|integrity/);
  }
});

test('PoC evidence and indexed archive survive real encryption without extending the original seven-day expiry', async () => {
  const f = pocFixture(),
    d = await dirs(),
    ageBinary = process.env.AGE_BINARY;
  assert.ok(ageBinary, 'A verified real age binary is required.');
  const identity = join(d.root, 'synthetic-poc.key');
  const keygen = spawnSync(
    join(dirname(ageBinary), process.platform === 'win32' ? 'age-keygen.exe' : 'age-keygen'),
    ['-o', identity],
    { windowsHide: true, stdio: 'pipe' },
  );
  assert.equal(keygen.status, 0);
  const recipient = keygen.stderr.toString().match(/age1[a-z0-9]{58}/)?.[0];
  const { result, directory } = await captureBackup(f.config, {
    client: f.client,
    reviewedSources: f.reviewedSources,
    outputRoot: d.output,
    stagingRoot: d.staging,
    recipient,
    ageBinary,
    now: () => NOW,
  });
  assert.equal(result.r2_copied, 4);
  assert.equal(result.delete_after, iso(NOW + DAY));
  assert.equal(result.offsite_verified, false);
  assert.equal(result.restore_verified, false);
  const restored = join(d.root, 'restored');
  await decryptBackup(join(directory, 'encrypted'), {
    outputDir: restored,
    identityFile: identity,
    ageBinary,
    now: NOW,
  });
  for (const key of [f.evidence, f.archive])
    assert.equal(await readFile(join(restored, key), 'utf8'), f.bodies[key]);
  const manifest = JSON.parse(await readFile(join(restored, 'manifest.json'), 'utf8'));
  assert.equal(manifest.files.find((x) => x.path === f.archive).delete_after, iso(NOW + DAY));
  assert.equal(
    manifest.files.find((x) => x.path === 'd1/private.sql').delete_after,
    iso(NOW + 30 * DAY),
  );
  assert.deepEqual(await readdir(d.staging), []);
});

test('expired PoC objects are excluded explicitly while unexpired normalized history remains in both DB exports', async () => {
  const f = pocFixture(8),
    d = await dirs(),
    ageBinary = process.env.AGE_BINARY;
  assert.ok(ageBinary);
  const identity = join(d.root, 'synthetic-expired.key');
  const keygen = spawnSync(
    join(dirname(ageBinary), process.platform === 'win32' ? 'age-keygen.exe' : 'age-keygen'),
    ['-o', identity],
    { windowsHide: true, stdio: 'pipe' },
  );
  assert.equal(keygen.status, 0);
  const recipient = keygen.stderr.toString().match(/age1[a-z0-9]{58}/)?.[0];
  const { result } = await captureBackup(f.config, {
    client: f.client,
    reviewedSources: f.reviewedSources,
    outputRoot: d.output,
    stagingRoot: d.staging,
    recipient,
    ageBinary,
    now: () => NOW,
  });
  assert.equal(result.r2_expired_excluded, 2);
  assert.equal(result.r2_copied, 2);
  assert.equal(f.calls.filter((c) => c.kind === 'export').length, 2);
  assert.equal(
    f.calls.filter((c) => c.kind === 'object' && c.key.includes('price_of_compute')).length,
    0,
  );
});

test('synthetic paged acquisition -> real age -> offline SQLite restore preserves values, hashes and immutable trigger', async () => {
  const ageBinary = process.env.AGE_BINARY;
  assert.ok(ageBinary, 'A verified real age binary is required; crypto is never mocked.');
  const f = fixture(),
    d = await dirs(),
    identity = join(d.root, 'synthetic-only.key');
  const keygen = spawnSync(
    join(dirname(ageBinary), process.platform === 'win32' ? 'age-keygen.exe' : 'age-keygen'),
    ['-o', identity],
    { windowsHide: true, stdio: 'pipe' },
  );
  assert.equal(keygen.status, 0);
  const recipient = keygen.stderr.toString().match(/age1[a-z0-9]{58}/)?.[0];
  assert.ok(recipient);
  const { result, directory } = await captureBackup(config, {
    client: f.client,
    reviewedSources: sourceConfigs,
    outputRoot: d.output,
    stagingRoot: d.staging,
    recipient,
    ageBinary,
    now: () => NOW,
  });
  assert.equal(result.status, 'local_encrypted_only');
  assert.equal(result.offsite_verified, false);
  assert.equal(result.restore_verified, false);
  assert.equal(result.plaintext_cleanup_required, false);
  assert.equal(result.r2_copied, 2);
  assert.deepEqual(await readdir(d.staging), []);
  const restored = join(d.root, 'restored');
  await decryptBackup(join(directory, 'encrypted'), {
    outputDir: restored,
    identityFile: identity,
    ageBinary,
    now: NOW,
  });
  for (const which of ['private', 'public']) {
    const sql = await readFile(join(restored, 'd1/' + which + '.sql'), 'utf8');
    assert.equal(sql, f.sql);
    const db = new DatabaseSync(':memory:');
    try {
      db.exec(sql);
      assert.equal(db.prepare('SELECT count(*) AS n FROM observations').get().n, 1);
      assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
      assert.throws(
        () => db.exec("UPDATE observations SET fingerprint='corrupted'"),
        /append-only/,
      );
    } finally {
      db.close();
    }
  }
  for (const [key, body] of Object.entries(f.bodies))
    assert.equal(await readFile(join(restored, key), 'utf8'), body);
  const manifest = JSON.parse(await readFile(join(restored, 'manifest.json'), 'utf8'));
  assert.equal(
    manifest.delete_after,
    iso(NOW + 2 * DAY),
    'copying never resets original evidence expiry',
  );
  const audit = JSON.parse(await readFile(join(directory, 'capture-audit.json'), 'utf8'));
  assert.equal(audit.cross_database_atomic, false);
  assert.equal(audit.r2_listed, 2);
  assert.equal(
    manifest.capture_audit_sha256,
    sha(await readFile(join(directory, 'capture-audit.json'))),
  );
});
