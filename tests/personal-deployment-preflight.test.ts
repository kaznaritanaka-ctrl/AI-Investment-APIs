import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { inspectPreflight } from '../scripts/preflight-core';
import deployment from '../config/deployment.json';
import { sources } from '../src/sources';

const collector = JSON.parse(readFileSync('wrangler.collector.jsonc', 'utf8'));
const api = JSON.parse(readFileSync('wrangler.api.jsonc', 'utf8'));
function fixture() {
  const c = structuredClone(collector);
  c.r2_buckets.push({ binding: 'NAS_EXPORT', bucket_name: 'synthetic-export-only' });
  const initial = {
    account_id: deployment.account_id,
    private_database_id: c.d1_databases.find((b: { binding: string }) => b.binding === 'PRIVATE_DB')
      .database_id,
    bucket: c.r2_buckets.find((b: { binding: string }) => b.binding === 'EVIDENCE').bucket_name,
    contracts: [{ source_id: 'highreso_public', contract_hash: 'a'.repeat(64) }],
  };
  const transport = {
    version: 'personal-nas-export-v1',
    account_id: initial.account_id,
    private_database_id: initial.private_database_id,
    origin_bucket: initial.bucket,
    export_bucket: 'synthetic-export-only',
    health_bucket: null as string | null,
    isolation_review_ref: 'SYNTHETIC ONLY; no real approval',
  };
  c.vars.PERSONAL_MAINTENANCE_ENABLED = 'true';
  c.vars.PERSONAL_INITIAL_COLLECTION_ENABLED = 'false';
  const inspect = () => {
    c.vars.PERSONAL_CLOUD_PINS = JSON.stringify(initial);
    c.vars.PERSONAL_EXPORT_PINS = JSON.stringify(transport);
    return inspectPreflight(deployment, c, api, sources);
  };
  return { c, initial, transport, inspect };
}

describe('personal Cloud preparation is separate from production preflight', () => {
  it('keeps the shipped disabled configuration ready without asserting personal readiness', () => {
    const r = inspectPreflight(deployment, collector, api, sources);
    expect(r.ready).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.pending.some((p) => p.startsWith('personal_'))).toBe(false);
    expect(r.network_performed).toBe(false);
  });
  it('accepts consistent synthetic pins but leaves contracts and real resources explicitly unverified', () => {
    const r = fixture().inspect();
    expect(r.errors).toEqual([]);
    expect(r.pending).toContain(
      'personal_contracts_resources_iam_and_execution_window_not_verified',
    );
    expect(r.network_performed).toBe(false);
  });
  it.each([
    'bucket_alias',
    'wrong_account',
    'wrong_db',
    'wrong_export',
    'missing_review',
    'duplicate_source',
    'missing_hash',
  ])('blocks %s without reflecting arbitrary pin content', (kind) => {
    const f = fixture();
    if (kind === 'bucket_alias') {
      f.c.r2_buckets[1].bucket_name = f.initial.bucket;
      f.transport.export_bucket = f.initial.bucket;
    }
    if (kind === 'wrong_account') f.initial.account_id = 'b'.repeat(32);
    if (kind === 'wrong_db')
      f.initial.private_database_id = f.c.d1_databases.find(
        (b: { binding: string }) => b.binding === 'PUBLIC_DB',
      ).database_id;
    if (kind === 'wrong_export') f.transport.export_bucket = 'unbound-bucket';
    if (kind === 'missing_review') f.transport.isolation_review_ref = '';
    if (kind === 'duplicate_source') f.initial.contracts.push(f.initial.contracts[0]);
    if (kind === 'missing_hash')
      f.initial.contracts[0].contract_hash = 'SYNTHETIC_SECRET_DO_NOT_ECHO';
    const r = f.inspect();
    expect(r.ready).toBe(false);
    expect(r.errors.some((x) => x.startsWith('personal_'))).toBe(true);
    expect(JSON.stringify(r)).not.toContain('SYNTHETIC_SECRET_DO_NOT_ECHO');
  });
  it('blocks malformed pins, acquisition without maintenance and private variables on the API', () => {
    const f = fixture();
    f.inspect();
    f.c.vars.PERSONAL_CLOUD_PINS = '{invalid';
    f.c.vars.PERSONAL_MAINTENANCE_ENABLED = 'false';
    f.c.vars.PERSONAL_INITIAL_COLLECTION_ENABLED = 'true';
    const r = inspectPreflight(
      deployment,
      f.c,
      { ...api, vars: { ...api.vars, PERSONAL_CLOUD_PINS: 'untrusted' } },
      sources,
    );
    expect(r.errors).toEqual(
      expect.arrayContaining([
        'personal_initial_pins_invalid',
        'personal_collection_requires_maintenance',
        'personal_public_variables_forbidden',
      ]),
    );
  });
  it('requires the daily health bucket and matches it to the transport pin', () => {
    const f = fixture();
    f.c.vars.PERSONAL_DAILY_MAINTENANCE_ENABLED = 'true';
    f.c.vars.PERSONAL_DAILY_PINS = JSON.stringify(f.initial);
    expect(f.inspect().errors).toContain('personal_daily_health_binding_missing');
    f.c.r2_buckets.push({ binding: 'NAS_HEALTH', bucket_name: 'synthetic-health-only' });
    expect(f.inspect().errors).toContain('personal_export_pins_invalid');
    f.transport.health_bucket = 'synthetic-health-only';
    expect(f.inspect().errors).toEqual([]);
  });
});
