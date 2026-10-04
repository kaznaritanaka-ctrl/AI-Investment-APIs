import { readFileSync, readdirSync, existsSync } from 'node:fs';
import assert from 'node:assert/strict';
const read = (p) => readFileSync(p, 'utf8'),
  api = JSON.parse(read('wrangler.api.jsonc')),
  collector = JSON.parse(read('wrangler.collector.jsonc'));
assert.deepEqual(
  api.d1_databases.map((x) => x.binding),
  ['PUBLIC_DB'],
);
assert(!api.r2_buckets?.length && !api.services?.length);
assert.equal(api.workers_dev, false);
assert.equal(collector.workers_dev, false);
assert.equal(api.preview_urls, false);
assert.equal(collector.preview_urls, false);
assert.equal(collector.vars.AGENT_ENABLED, 'false');
for (const name of readdirSync('config/sources').filter((x) => x.endsWith('.json'))) {
  const s = JSON.parse(read('config/sources/' + name));
  assert.equal(Object.keys(s.policy.rights).length, 9);
  if (s.enabled)
    for (const key of ['automated_collection', 'private_storage', 'internal_analysis'])
      assert.equal(s.policy.rights[key], 'allowed');
  if (s.source_id === 'openrouter' || s.adapter === 'candidate') assert.equal(s.enabled, false);
  assert(s.policy.evidence_refs.length > 0);
  assert(s.policy.fields.length > 0);
}
assert(!/tests\/fixtures|fixtures\/|synthetic\.json/.test(read('src/collector.ts')));
assert(!/tests\/fixtures|fixtures\/|synthetic\.json/.test(read('src/collector-handlers.ts')));
assert(/work\//.test(read('.gitignore')));
assert(/\.dev\.vars/.test(read('.gitignore')));
assert(JSON.parse(read('config/source.schema.json')).properties.policy);
assert.equal(JSON.parse(read('openapi.json')).openapi, '3.1.0');
assert(existsSync('pnpm-lock.yaml'));
console.log(
  'Boundary/config checks passed: public DB only, source grants, no fixture import, no automatic deployment.',
);

if (JSON.parse(read('config/deployment.json')).stage === 'bootstrap') {
  assert.deepEqual(collector.triggers.crons, []);
  assert.equal(collector.vars.COLLECTION_ENABLED, 'false');
}
assert(!collector.routes?.length);
assert(!Object.keys(api.vars ?? {}).some((k) => /SECRET|TOKEN|KEY|PRIVATE/.test(k)));
assert(read('scripts/run.mjs').includes('--dry-run'));
assert(!read('.github/workflows/ci.yml').includes('deploy --'));
