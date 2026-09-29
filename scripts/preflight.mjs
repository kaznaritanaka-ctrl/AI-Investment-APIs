import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { inspectPreflight } from './preflight-core.ts';
const read = (p) => JSON.parse(readFileSync(p, 'utf8'));
const d = read('config/deployment.json'),
  c = read('wrangler.collector.jsonc'),
  a = read('wrangler.api.jsonc'),
  sources = readdirSync('config/sources')
    .filter((x) => x.endsWith('.json'))
    .map((x) => read('config/sources/' + x));
const args = process.argv.slice(2);
const proposalIndex = args.indexOf('--proposal');
if (proposalIndex >= 0) {
  if (args.includes('--cloudflare-read-only'))
    throw new Error('proposal_preflight_is_offline_only');
  const proposal = read(args[proposalIndex + 1]);
  const index = sources.findIndex((s) => s.source_id === proposal.source_id);
  if (index < 0) throw new Error('proposal_source_not_registered');
  sources[index] = { ...proposal, enabled: true }; // Hypothetical activation only; never writes source settings.
}
const report = inspectPreflight(d, c, a, sources, process.env);
if (proposalIndex >= 0) report.proposal_evaluation = true;
if (args.includes('--cloudflare-read-only')) {
  report.mode = 'cloudflare_read_only';
  if (
    !/^[a-f0-9]{32}$/i.test(d.account_id ?? '') ||
    /^0+$/.test(d.account_id) ||
    !process.env.CLOUDFLARE_API_TOKEN
  )
    report.blockers.push('cloudflare_target_or_token_unconfigured');
  else if (report.errors.length) report.blockers.push('resolve_static_errors_before_cloud_check');
  else {
    report.network_performed = true;
    const checks = [];
    async function get(path, label, validate, sql) {
      try {
        const r = await fetch('https://api.cloudflare.com/client/v4' + path, {
          method: sql ? 'POST' : 'GET',
          headers: {
            Authorization: 'Bearer ' + process.env.CLOUDFLARE_API_TOKEN,
            ...(sql ? { 'content-type': 'application/json' } : {}),
          },
          ...(sql ? { body: JSON.stringify({ sql }) } : {}),
          signal: AbortSignal.timeout(15000),
          redirect: 'error',
        });
        const body = await r.json();
        if (!r.ok || body.success !== true) throw new Error('http_' + r.status);
        const ok = validate(body.result);
        checks.push({ check: label, ok });
        if (!ok) report.blockers.push(label + ':mismatch_or_unconfirmed');
      } catch (e) {
        checks.push({
          check: label,
          ok: false,
          reason: /^http_\d+$/.test(e.message) ? e.message : 'request_failed',
        });
        report.blockers.push(label + ':not_verified');
      }
    }
    const base = '/accounts/' + d.account_id;
    await get(base, 'account_identity', (r) => r.id === d.account_id);
    if (checks[0]?.ok) {
      if (d.zone_id)
        await get(
          '/zones/' + d.zone_id,
          'zone_ownership',
          (r) =>
            r.account?.id === d.account_id && r.name === d.owned_domain && r.status === 'active',
        );
      for (const b of c.d1_databases) {
        await get(
          base + '/d1/database/' + b.database_id,
          'd1_' + b.binding,
          (r) => r.uuid === b.database_id,
        );
        const expected = readdirSync(b.migrations_dir)
          .filter((n) => n.endsWith('.sql'))
          .sort();
        await get(
          base + '/d1/database/' + b.database_id + '/query',
          'migration_' + b.binding,
          (r) =>
            Array.isArray(r) &&
            expected.every((name) => r[0]?.results?.some((row) => row.name === name)),
          'SELECT name FROM d1_migrations ORDER BY name',
        );
      }
      const bucket = c.r2_buckets[0].bucket_name,
        path = base + '/r2/buckets/' + encodeURIComponent(bucket);
      await get(path, 'r2_bucket', (r) => r.name === bucket);
      await get(path + '/domains/managed', 'r2_managed_domain_private', (r) => r.enabled === false);
      await get(
        path + '/domains/custom',
        'r2_custom_domains_private',
        (r) => Array.isArray(r.domains) && r.domains.every((x) => x.enabled === false),
      );
      await get(path + '/lifecycle', 'source_retention_lifecycle', (r) =>
        sources
          .filter((s) => s.enabled)
          .every((s) =>
            ['evidence/', 'archive/'].every((prefix) =>
              r.rules?.some(
                (rule) =>
                  rule.enabled &&
                  (rule.conditions?.prefix === prefix + s.source_id + '/' ||
                    (!s.gpu && prefix === 'archive/' && rule.conditions?.prefix === 'archive/')) &&
                  rule.deleteObjectsTransition?.condition?.type === 'Age' &&
                  rule.deleteObjectsTransition.condition.maxAge <=
                    86400 *
                      (s.gpu?.retention[
                        prefix === 'evidence/' ? 'evidence_days' : 'archive_days'
                      ] ??
                        s.models?.retention[
                          prefix === 'evidence/' ? 'evidence_days' : 'archive_days'
                        ] ??
                        d.legacy_retention?.[s.source_id]?.[
                          prefix === 'evidence/' ? 'evidence_days' : 'archive_days'
                        ] ??
                        s.policy.retention_days),
              ),
            ),
          ),
      );
      for (const worker of [c, a]) {
        await get(
          base + '/workers/scripts/' + worker.name + '/schedules',
          worker.name + ':cron',
          (r) =>
            JSON.stringify(r.schedules?.map((x) => x.cron).sort()) ===
            JSON.stringify([...(worker.triggers?.crons ?? [])].sort()),
        );
        await get(
          base + '/workers/scripts/' + worker.name + '/subdomain',
          worker.name + ':public_subdomain',
          (r) => r.enabled === false && r.previews_enabled === false,
        );
      }
      await get(base + '/workers/scripts/' + a.name + '/settings', 'public_bindings', (r) =>
        r.bindings?.every(
          (b) =>
            (b.type === 'd1' && b.name === 'PUBLIC_DB' && b.id === a.d1_databases[0].database_id) ||
            (b.type === 'ratelimit' && b.name === 'RATE_LIMITER') ||
            (b.type === 'plain_text' && b.name === 'ENVIRONMENT'),
        ),
      );
      const secretNames = sources
        .filter((s) => s.enabled && s.gpu)
        .flatMap(
          (s) =>
            ({
              lambda: ['LAMBDA_API_KEY'],
              sakura_dok: ['SAKURA_ACCESS_TOKEN', 'SAKURA_ACCESS_SECRET'],
              ebay_browse: ['EBAY_CLIENT_ID', 'EBAY_CLIENT_SECRET'],
              price_of_compute: [],
            })[s.adapter] ?? [],
        );
      await get(
        base + '/workers/scripts/' + c.name + '/secrets',
        'collector_required_secret_names',
        (r) => Array.isArray(r) && secretNames.every((name) => r.some((x) => x.name === name)),
      );
      const manualFreeEvidence =
        d.workers_plan === 'free' &&
        typeof d.workers_plan_evidence_ref === 'string' &&
        d.workers_plan_evidence_ref.trim().length > 0;
      await get(
        base + '/subscriptions',
        'workers_plan',
        (r) =>
          Array.isArray(r) &&
          (r.some((x) => /workers/i.test(x.rate_plan?.id ?? ''))
            ? d.workers_plan === 'paid'
            : manualFreeEvidence),
      );
      const planCheck = checks.at(-1);
      if (d.workers_plan === 'free')
        Object.assign(planCheck, {
          verification_method: 'manual_evidence',
          evidence_ref: manualFreeEvidence ? d.workers_plan_evidence_ref : null,
          api_verifiable: false,
          subscription_api_role: 'check_for_conflicting_workers_subscription',
        });
      else if (d.workers_plan === 'paid') planCheck.verification_method = 'subscription_api';
      // No Workers subscription is only a consistency check, never evidence of Free by itself.
    }
    report.cloud_checks = checks;
  }
}
report.ready = report.static_valid && report.blockers.length === 0;
if (args.includes('--plan'))
  report.deployment_plan = {
    executable: false,
    stage: d.stage,
    steps: [
      'Confirm target account, existing resources, source grants and all retention classes.',
      'Run reviewed forward migrations on private/public D1 after backup verification.',
      d.stage === 'bootstrap'
        ? 'Deploy collector with COLLECTION_ENABLED=false and crons=[]; no route.'
        : 'Preserve the existing stage, COLLECTION_ENABLED, Cron, routes and owner approvals; do not reapply bootstrap settings.',
      'Deploy API only after separate public-domain approval; PUBLIC_DB binding only.',
      'Verify health, canary and external monitor.',
      d.stage === 'enabled'
        ? 'Keep the currently approved Cron unchanged. Expansion grants require separate review before source activation.'
        : 'After explicit Cron approval, update this same Wrangler collector config and deploy once.',
    ],
    commands: [
      'pnpm check',
      'pnpm test',
      'pnpm test:runtime',
      'pnpm build',
      'pnpm preflight:cloudflare',
    ],
    note: 'This command never executes a deployment or mutation.',
  };
mkdirSync('work', { recursive: true });
writeFileSync('work/preflight.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
if (report.errors.length || (!report.ready && !args.includes('--allow-unconfigured')))
  process.exitCode = 2;
