import { afterEach, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL, URL as NodeURL } from 'node:url';

const preflight = fileURLToPath(new NodeURL('../scripts/preflight.mjs', import.meta.url));
const tempRoot = resolve('work/preflight-plan-tests');
const account = 'a'.repeat(32),
  zone = 'b'.repeat(32);
const publicID = '11111111-1111-1111-1111-111111111111';
const privateID = '22222222-2222-2222-2222-222222222222';
const evidence = 'Synthetic dashboard confirmation of Workers Free';
const paidSubscription = { rate_plan: { id: 'workers_paid' } };
const directories: string[] = [];

afterEach(() => {
  for (const dir of directories.splice(0)) {
    if (!resolve(dir).startsWith(tempRoot + sep)) throw new Error('Unsafe fixture cleanup');
    rmSync(dir, { recursive: true, force: true });
  }
});

function run(
  options: {
    plan?: string;
    evidence?: string | null;
    subscriptions?: unknown;
    subscriptionStatus?: number;
    publicR2?: boolean;
  } = {},
) {
  mkdirSync(tempRoot, { recursive: true });
  const dir = mkdtempSync(join(tempRoot, 'case-'));
  directories.push(dir);
  const deployment = {
    account_id: account,
    zone_id: zone,
    owned_domain: 'fixture.test',
    workers_plan: options.plan ?? 'free',
    workers_plan_evidence_ref: options.evidence === undefined ? evidence : options.evidence,
    d1_time_travel_days: 7,
    deployment_controller: 'manual_wrangler',
    stage: 'bootstrap',
    retention_review_ref: 'synthetic-retention-review',
    deployment_approval_ref: 'synthetic-approval',
    notification_destination_configured: true,
    external_monitor_evidence_ref: 'synthetic-monitor',
  };
  const publicDB = {
    binding: 'PUBLIC_DB',
    database_id: publicID,
    migrations_dir: 'migrations/public',
  };
  const collector = {
    name: 'fixture-collector',
    account_id: account,
    workers_dev: false,
    preview_urls: false,
    triggers: { crons: [] },
    vars: {
      COLLECTION_ENABLED: 'false',
      COLLECTION_CRON: '17 18 * * *',
      WATCHDOG_CRON: '47 18 * * *',
      GPU_RESUME_CRON: '*/5 18-23 * * *',
    },
    d1_databases: [
      { binding: 'PRIVATE_DB', database_id: privateID, migrations_dir: 'migrations/private' },
      publicDB,
    ],
    r2_buckets: [{ binding: 'EVIDENCE', bucket_name: 'fixture-evidence' }],
  };
  const api = {
    name: 'fixture-api',
    account_id: account,
    workers_dev: false,
    preview_urls: false,
    d1_databases: [publicDB],
  };
  for (const path of ['config/sources', 'migrations/private', 'migrations/public'])
    mkdirSync(join(dir, path), { recursive: true });
  for (const path of ['migrations/private', 'migrations/public'])
    writeFileSync(join(dir, path, '0001_fixture.sql'), '-- Synthetic filename only');
  for (const [path, data] of [
    ['config/deployment.json', deployment],
    ['wrangler.collector.jsonc', collector],
    ['wrangler.api.jsonc', api],
  ] as const)
    writeFileSync(join(dir, path), JSON.stringify(data));

  const base = '/accounts/' + account,
    bucket = base + '/r2/buckets/fixture-evidence';
  const responses: Record<string, unknown> = {
    [base]: { id: account },
    ['/zones/' + zone]: { account: { id: account }, name: 'fixture.test', status: 'active' },
    [bucket]: { name: 'fixture-evidence' },
    [bucket + '/domains/managed']: { enabled: options.publicR2 ?? false },
    [bucket + '/domains/custom']: { domains: [] },
    [bucket + '/lifecycle']: { rules: [] },
    [base + '/workers/scripts/fixture-api/settings']: {
      bindings: [{ type: 'd1', name: 'PUBLIC_DB', id: publicID }],
    },
    [base + '/workers/scripts/fixture-collector/secrets']: [],
    [base + '/subscriptions']: options.subscriptions ?? [],
  };
  for (const id of [privateID, publicID]) {
    responses[base + '/d1/database/' + id] = { uuid: id };
    responses[base + '/d1/database/' + id + '/query'] = [
      { results: [{ name: '0001_fixture.sql' }] },
    ];
  }
  for (const worker of ['fixture-collector', 'fixture-api']) {
    responses[base + '/workers/scripts/' + worker + '/schedules'] = { schedules: [] };
    responses[base + '/workers/scripts/' + worker + '/subdomain'] = {
      enabled: false,
      previews_enabled: false,
    };
  }
  // The real CLI runs against isolated files and a fetch stub; no Cloudflare requests occur.
  const preload = join(dir, 'mock.mjs');
  writeFileSync(
    preload,
    `
    const responses = ${JSON.stringify(responses)};
    globalThis.fetch = async (input, init) => {
      const url = new URL(input);
      if (url.origin !== 'https://api.cloudflare.com') throw new Error('Unexpected origin');
      const path = url.pathname.replace('/client/v4', '');
      if (!Object.hasOwn(responses, path)) throw new Error('Unexpected path');
      if (path.endsWith('/query') && (init.method !== 'POST' ||
          JSON.parse(init.body).sql !== 'SELECT name FROM d1_migrations ORDER BY name'))
        throw new Error('Unexpected database operation');
      if (!path.endsWith('/query') && init.method !== 'GET') throw new Error('Unexpected method');
      const status = path.endsWith('/subscriptions') ? ${options.subscriptionStatus ?? 200} : 200;
      return new Response(JSON.stringify({ success: status === 200, result: responses[path] }), {
        status, headers: { 'content-type': 'application/json' },
      });
    };
  `,
  );
  const result = spawnSync(
    process.execPath,
    ['--import', pathToFileURL(preload).href, preflight, '--cloudflare-read-only'],
    {
      cwd: dir,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15000,
      env: {
        ...process.env,
        CLOUDFLARE_API_TOKEN: 'synthetic-token',
        CLOUDFLARE_ACCOUNT_ID: account,
      },
    },
  );
  if (result.error) throw result.error;
  const report = JSON.parse(readFileSync(join(dir, 'work/preflight.json'), 'utf8'));
  expect(report.static_valid).toBe(true);
  return {
    status: result.status,
    report,
    check: report.cloud_checks.find((c: any) => c.check === 'workers_plan'),
  };
}

it.each([
  ['no subscriptions', []],
  ['an unrelated subscription', [{ rate_plan: { id: 'zone_pro' } }]],
])(
  'accepts evidenced Free with %s while explicitly identifying manual verification',
  (_name, subscriptions) => {
    const { status, report, check } = run({ subscriptions });
    expect(status).toBe(0);
    expect(report.ready).toBe(true);
    expect(report.blockers).toEqual([]);
    expect(check).toEqual({
      check: 'workers_plan',
      ok: true,
      verification_method: 'manual_evidence',
      evidence_ref: evidence,
      api_verifiable: false,
      subscription_api_role: 'check_for_conflicting_workers_subscription',
    });
  },
);

it.each([null, '', '   '])(
  'never infers Free from absent subscriptions without evidence (%j)',
  (evidence) => {
    const { status, report, check } = run({ evidence });
    expect(status).toBe(2);
    expect(report.blockers).toContain('workers_plan:mismatch_or_unconfirmed');
    expect(check).toMatchObject({ ok: false, evidence_ref: null, api_verifiable: false });
  },
);

it('keeps Paid verification through the subscription API', () => {
  const { status, report, check } = run({ plan: 'paid', subscriptions: [paidSubscription] });
  expect(status).toBe(0);
  expect(report.ready).toBe(true);
  expect(check).toEqual({
    check: 'workers_plan',
    ok: true,
    verification_method: 'subscription_api',
  });
});

it('does not substitute manual evidence for a missing Paid subscription', () => {
  const { status, report, check } = run({ plan: 'paid' });
  expect(status).toBe(2);
  expect(report.blockers).toContain('workers_plan:mismatch_or_unconfirmed');
  expect(check).toMatchObject({ ok: false, verification_method: 'subscription_api' });
});

it('blocks a Workers subscription that contradicts configured Free even with manual evidence', () => {
  const { status, report, check } = run({ subscriptions: [paidSubscription] });
  expect(status).toBe(2);
  expect(report.blockers).toContain('workers_plan:mismatch_or_unconfirmed');
  expect(check).toMatchObject({
    ok: false,
    verification_method: 'manual_evidence',
    api_verifiable: false,
  });
});

it.each(['free', 'paid'])('preserves API failure blockers for %s', (plan) => {
  const { status, report, check } = run({ plan, subscriptionStatus: 403 });
  expect(status).toBe(2);
  expect(report.blockers).toContain('workers_plan:not_verified');
  expect(check).toMatchObject({ ok: false, reason: 'http_403' });
});

it('does not accept a malformed subscription result as evidence of no Paid subscription', () => {
  const { status, report } = run({ subscriptions: { unexpected: true } });
  expect(status).toBe(2);
  expect(report.blockers).toContain('workers_plan:mismatch_or_unconfirmed');
});

it('keeps unrelated preflight blockers when Free evidence is accepted', () => {
  const { status, report, check } = run({ publicR2: true });
  expect(status).toBe(2);
  expect(report.ready).toBe(false);
  expect(report.blockers).toEqual(['r2_managed_domain_private:mismatch_or_unconfirmed']);
  expect(check).toMatchObject({ ok: true, verification_method: 'manual_evidence' });
});
