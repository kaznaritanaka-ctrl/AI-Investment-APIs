import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkHealth, evaluateHealth, transition, HEALTH_URL } from './health-check.mjs';
import { validatePlan } from './backup-package.mjs';
const NOW = Date.parse('2026-10-05T01:00:00Z');
const healthy = () => ({
  status: 'public_data_available',
  collector: {
    collection_enabled: 1,
    last_collector_completed_at: '2026-10-04T18:20:00Z',
    monitor_connected: 0,
  },
  datasets: ['fx', 'ai_api_prices'].map((dataset) => ({
    dataset,
    count: 2,
    last_observed_at: '2026-10-04T18:17:00Z',
  })),
});

test('public reachability, stored collector metadata and observation freshness remain separate', () => {
  assert.equal(evaluateHealth(healthy(), NOW).severity, 'ok');
  assert.equal(evaluateHealth(healthy(), NOW).monitoring, 'not_verified');
  const body = healthy();
  body.datasets[1].last_observed_at = '2026-10-01T18:17:00Z';
  const result = evaluateHealth(body, NOW);
  assert.equal(result.collection, 'recent_record');
  assert.equal(result.publication, 'needs_attention');
  assert.deepEqual(result.reasons, ['ai_api_prices_publication_stale']);
  body.collector.collection_enabled = 0;
  assert.equal(evaluateHealth(body, NOW).collection, 'disabled_record');
});
test('missing, duplicate, future and empty observations are not healthy or zero substitutions', () => {
  for (const change of [
    (b) => b.datasets.pop(),
    (b) => b.datasets.push(b.datasets[0]),
    (b) => (b.datasets[0].count = 0),
    (b) => (b.datasets[0].last_observed_at = '2030-01-01T00:00:00Z'),
    (b) => (b.collector.last_collector_completed_at = null),
  ]) {
    const body = healthy();
    change(body);
    assert.notEqual(evaluateHealth(body, NOW).severity, 'ok');
  }
  assert.equal(evaluateHealth({}, NOW).collection, 'unknown');
});
test('fixed GET sends no secrets/cookies; 403 cannot establish collection failure', async () => {
  const result = await checkHealth({
    now: () => NOW,
    fetcher: async (url, options) => {
      assert.equal(url, HEALTH_URL);
      assert.equal(options.method, 'GET');
      assert.equal(options.redirect, 'manual');
      assert.equal(options.credentials, 'omit');
      assert.deepEqual(options.headers, { accept: 'application/json' });
      return new Response('private-sentinel', { status: 403 });
    },
  });
  assert.equal(result.reachability, 'access_blocked');
  assert.equal(result.collection, 'unknown');
  assert.equal(result.publication, 'unknown');
  assert.ok(!JSON.stringify(result).includes('private-sentinel'));
});
test('redirects, HTML, oversized stream and timeout remain bounded errors', async () => {
  for (const response of [
    new Response(null, { status: 302, headers: { location: 'https://other.test/' } }),
    new Response('<html>secret</html>'),
    new Response('x'.repeat(65537), { headers: { 'content-type': 'application/json' } }),
  ]) {
    const result = await checkHealth({ now: () => NOW, fetcher: async () => response });
    assert.equal(result.severity, 'error');
    assert.equal(result.publication, 'unknown');
  }
  const result = await checkHealth({
    now: () => NOW,
    timeoutMs: 5,
    fetcher: async () =>
      new Response(new ReadableStream({ start() {} }), {
        headers: { 'content-type': 'application/json' },
      }),
  });
  assert.equal(result.reachability, 'timeout');
});
test('two successive failures produce one incident; normal states do not notify', () => {
  const ok = evaluateHealth(healthy(), NOW),
    bad = evaluateHealth({}, NOW);
  assert.equal(transition(null, ok).notify, false);
  const first = transition(null, bad),
    second = transition(first, bad);
  assert.equal(first.notify, false);
  assert.equal(second.notify, true);
  assert.equal(transition(first, { ...bad, reasons: ['timeout'] }).notify, true);
  assert.equal(transition(second, bad).notify, false);
  assert.equal(transition(second, ok).event, 'recovered');
  assert.equal(transition(second, ok).notify, false);
  assert.equal(transition({ ...second, failures: 99 }, bad).failures, 3);
});
const plan = () => ({
  schema_version: 'backup-input-v1',
  snapshot_id: 'synthetic',
  captured_at: new Date(NOW).toISOString(),
  delete_after: new Date(NOW + 86400000).toISOString(),
  inventory_complete: true,
  files: ['d1/private.sql', 'd1/public.sql'].map((path) => ({
    path,
    bytes: 1,
    sha256: 'a'.repeat(64),
    delete_after: new Date(NOW + 86400000).toISOString(),
  })),
});
test('backup requires both DBs, exact inventory, source allowlist and non-extending retention', () => {
  assert.equal(validatePlan(plan(), NOW).files.length, 2);
  for (const change of [
    (p) => p.files.pop(),
    (p) => (p.inventory_complete = false),
    (p) => (p.files[0].path = '../secret'),
    (p) => (p.files[0].path = 'evidence/unapproved/x.json'),
    (p) => (p.files[0].delete_after = new Date(NOW - 1).toISOString()),
    (p) => (p.delete_after = new Date(NOW + 31 * 86400000).toISOString()),
    (p) => p.files.push(p.files[0]),
  ]) {
    const p = plan();
    change(p);
    assert.throws(() => validatePlan(p, NOW));
  }
});
