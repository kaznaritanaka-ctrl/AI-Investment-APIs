import { describe, it, expect, vi } from 'vitest';
import {
  captureModelFields,
  captureECB,
  classifyFailure,
  recoveryRights,
  recoveryPolicyHash,
} from '../src/schema-drift';
import { validateQuarantine, IncidentSchema } from '../src/recovery-evidence';
import { repairPacket, reparseWrapperCandidate, repairGate } from '../src/repair';
import { overnightSource, attachRepairResult } from '../src/overnight';
import { projectModelCatalog } from '../src/models';
import { fetchSource } from '../src/network';
import { sources } from '../src/sources';
import { stable, hash } from '../src/util';
import policy from '../config/recovery-policy.json';
import { expandedSource, catalog } from './models-helpers';
import { time, responder, fixture, source } from './helpers';

async function evidence(text = JSON.stringify({ data: catalog() }), s = expandedSource()) {
  const capture = captureModelFields(text, s);
  return validateQuarantine(
    s,
    {
      format: 'quarantine_evidence_v1',
      source_id: s.source_id,
      run_id: await hash(s.source_id + '|' + time),
      policy_version: s.policy.version,
      policy_hash: await recoveryPolicyHash(s),
      observed_at: time,
      expires_at: new Date(Date.parse(time) + s.policy.retention_days * 86400000).toISOString(),
      synthetic: true,
      purpose: 'recovery_only_never_public',
      raw_response: false,
      source_payload_hash: await hash(text),
      body: capture.body,
      body_hash: await hash(capture.body ?? ''),
      wrapper: capture.wrapper,
      complete_projection: capture.complete,
      record_count: capture.record_count,
      diagnostics: capture.diagnostics,
    },
    time,
    'test',
  );
}

describe('rights-bound schema capture (synthetic)', () => {
  it('inherits exact active grants and denies every unapproved source without broadening retention', () => {
    const ecb = recoveryRights(source('ecb'), time),
      models = recoveryRights(expandedSource(), time);
    expect(ecb).toMatchObject({
      raw_response: true,
      minimal_projection: true,
      retention_days: 365,
      external_llm_processing: false,
      quarantine_public_redistribution: false,
    });
    expect(models).toMatchObject({
      raw_response: false,
      minimal_projection: true,
      retention_days: 90,
      external_llm_processing: false,
      quarantine_public_redistribution: false,
    });
    expect(models.field_whitelist).toEqual(expandedSource().models!.fields);
    for (const s of sources.filter((s) => !s.enabled))
      expect(recoveryRights(s, time)).toMatchObject({
        raw_response: false,
        minimal_projection: false,
        retention_days: null,
      });
    const denied = expandedSource();
    denied.policy.rights.private_storage = 'review_required';
    expect(recoveryRights(denied, time).minimal_projection).toBe(false);
  });
  it('captures only approved fields before projection, preserving exact decimal tokens and original wrapper', async () => {
    const text = JSON.stringify({ data: catalog() }).replace(
      '"input":1',
      '"input":1.234567890123456789',
    );
    const e = await evidence(text);
    expect(e.diagnostics).toEqual([
      {
        code: 'wrapper_changed',
        path: '$',
        expected: 'provider_map',
        actual: 'data',
        severity: 'block',
      },
    ]);
    expect(e.body).toContain('1.234567890123456789');
    expect(e.body).not.toMatch(/Authorization|description|credential|unapproved/);
    expect(e).toMatchObject({ complete_projection: true, record_count: 5, observed_at: time });
    expect(JSON.stringify(repairPacket(expandedSource(), e))).not.toMatch(
      /synthetic-model-\d|1\.234|Authorization/,
    );
    expect(repairPacket(expandedSource(), e)).toMatchObject({
      source_payload_included: false,
      external_llm_processing_authorized: false,
      production_deploy_allowed: false,
    });
  });
  it.each([
    ['array root', '[]', 'json_shape'],
    ['malformed JSON', '{"data":', 'json_shape'],
    ['missing provider', JSON.stringify({ openai: catalog().openai }), 'required_field_missing'],
    [
      'provider models array',
      JSON.stringify({ ...catalog(), openai: { id: 'openai', models: [] } }),
      'identifier_or_shape_changed',
    ],
    [
      'pagination',
      JSON.stringify({ ...catalog(), pagination: { next: 'https://forbidden.invalid/secret' } }),
      'pagination_contract',
    ],
  ])('detects %s without retaining forbidden response text', (_name, text, code) => {
    const c = captureModelFields(text, expandedSource());
    expect(c.diagnostics.map((d) => d.code)).toContain(code);
    expect(JSON.stringify(c)).not.toContain('https://forbidden');
  });
  it.each(['currency', 'unit', 'price_basis', 'contract_type', 'region', 'sku'])(
    'blocks %s changes without storing an unapproved value',
    (field) => {
      const body = catalog();
      body.openai.models['synthetic-model-0'][field] = 'SYNTHETIC_FORBIDDEN_VALUE';
      const c = captureModelFields(JSON.stringify(body), expandedSource());
      expect(c.diagnostics.map((d) => d.code)).toContain('semantics_changed');
      expect(JSON.stringify(c)).not.toContain('SYNTHETIC_FORBIDDEN_VALUE');
    },
  );
  it('detects enum, ID, unknown price, mode condition and count changes; optional additions remain harmless', () => {
    const normal = catalog();
    normal.openai.models['synthetic-model-0'].new_description = 'SYNTHETIC_UNAPPROVED';
    expect(captureModelFields(JSON.stringify(normal), expandedSource()).diagnostics).toEqual([]);
    const changed = catalog();
    const m = changed.openai.models['synthetic-model-0'];
    m.status = 'generally_available';
    m.cost.per_minute = 100;
    m.experimental = { modes: { fast: { cost: { input: 1, output: 2 }, new_contract: 'secret' } } };
    const c = captureModelFields(JSON.stringify(changed), expandedSource(), 100);
    expect(c.complete).toBe(false);
    expect(c.diagnostics.map((d) => d.code)).toEqual(
      expect.arrayContaining([
        'field_type_or_enum',
        'unknown_pricing_field',
        'pricing_basis_changed',
        'record_scope_changed',
      ]),
    );
    expect(JSON.stringify(c)).not.toMatch(/generally_available|per_minute|new_contract|secret/);
    m.id = 'other-identity';
    expect(
      captureModelFields(JSON.stringify(changed), expandedSource()).diagnostics.map((d) => d.code),
    ).toContain('identifier_changed');
  });
  it('does not bless a captured response with a modified hash, rights, retained field, diagnostic or expiry', async () => {
    const s = expandedSource(),
      e = await evidence();
    for (const extra of [
      { body_hash: '0'.repeat(64) },
      { expires_at: '2030-01-01T00:00:00.000Z' },
      { diagnostics: [{ ...e.diagnostics[0], code: 'secret_encoded_here' }] },
      { run_id: 'bad' },
    ])
      await expect(validateQuarantine(s, { ...e, ...extra }, time, 'test')).rejects.toThrow(
        /quarantine/,
      );
    const body = JSON.parse(e.body!);
    body.data.openai.models['synthetic-model-0'].description = 'UNAPPROVED';
    const text = stable(body);
    await expect(
      validateQuarantine(s, { ...e, body: text, body_hash: await hash(text) }, time, 'test'),
    ).rejects.toThrow('quarantine_field_scope_mismatch');
    s.policy.rights.private_storage = 'denied';
    await expect(validateQuarantine(s, e, time, 'test')).rejects.toThrow(/quarantine/);
    await expect(validateQuarantine(expandedSource(), e, e.expires_at, 'test')).rejects.toThrow(
      'quarantine_policy_or_time_blocked',
    );
    await expect(validateQuarantine(expandedSource(), e, time, 'production')).rejects.toThrow(
      'synthetic_data_blocked',
    );
  });
  it('keeps approved ECB XML and blocks newly explicit basis metadata', () => {
    const xml = fixture('ecb.synthetic.xml');
    expect(captureECB(xml).body).toBe(xml);
    expect(captureECB(xml).diagnostics).toEqual([]);
    expect(captureECB(xml.replace('<Cube>', '<Cube base="USD">')).diagnostics[0].code).toBe(
      'semantics_changed',
    );
  });
});

describe('failure boundaries and local repair gates', () => {
  it.each([
    ['http_403', 'authentication'],
    ['retryable_429', 'rate_limit'],
    ['timeout', 'transport'],
    ['retryable_5xx', 'transport'],
    ['unexpected_content_type', 'response_contract'],
    ['schema_drift_detected', 'schema_drift'],
    ['attempt_log_failed', 'storage_or_publication'],
  ])('classifies %s independently from schema drift', (code, expected) => {
    expect(classifyFailure(code, 'http')).toBe(expected);
  });
  it('captures a complete body before attempt logging, and never refetches on a local persistence error', async () => {
    const order: string[] = [],
      fetcher = vi.fn(responder(JSON.stringify(catalog())));
    await expect(
      fetchSource(expandedSource(), {
        fetcher,
        now: () => time,
        onBody: async (b) => {
          expect(b.text).toContain('openai');
          order.push('saved');
        },
        onAttempt: async () => {
          order.push('log');
          throw new Error('SYNTHETIC_SECRET_ERROR');
        },
      }),
    ).rejects.toThrow('attempt_log_failed');
    expect(order).toEqual(['saved', 'log']);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(
      fetchSource(expandedSource(), {
        fetcher,
        now: () => time,
        onBody: async () => {
          throw new Error('SYNTHETIC_SECRET_ERROR');
        },
      }),
    ).rejects.toThrow('recovery_capture_failed');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('does not capture HTTP errors or content-type failures', async () => {
    const onBody = vi.fn();
    await expect(
      fetchSource(expandedSource(), {
        now: () => time,
        fetcher: responder('SECRET', 'text/html', 403),
        onBody,
      }),
    ).rejects.toThrow('http_403');
    await expect(
      fetchSource(expandedSource(), {
        now: () => time,
        fetcher: responder('SECRET', 'text/html'),
        onBody,
      }),
    ).rejects.toThrow('unexpected_content_type');
    expect(onBody).not.toHaveBeenCalled();
  });
  it('reparses a saved wrapper with identical identities and semantics; does not fake test or publication success', async () => {
    const s = expandedSource(),
      e = await evidence();
    const plan = await reparseWrapperCandidate(
      s,
      e,
      time,
      await projectModelCatalog(JSON.stringify(catalog()), s),
    );
    expect(plan).toMatchObject({
      reparse_result: 'passed',
      record_count: 5,
      accepted_price_count: 5,
      quarantined_price_count: 0,
      observed_at: time,
      regression_result: 'not_run',
      missing_observation_count: null,
      publication_result: 'not_attempted',
    });
    expect(plan.checks).toMatchObject({
      identity_preserved: true,
      currency_unit_basis_preserved: true,
      parser_version_changed: null,
      regression_pass: null,
      upstream_semantics_confirmed: null,
    });
    expect(plan.gate.candidate_eligible).toBe(false);
    expect(
      (await reparseWrapperCandidate(s, e, time)).checks.currency_unit_basis_preserved,
    ).toBeNull();
    const changed = catalog();
    changed.openai.models['synthetic-model-0'].cost.currency = 'EUR';
    await expect(
      reparseWrapperCandidate(s, await evidence(JSON.stringify({ data: changed })), time),
    ).rejects.toThrow('repair_requires_semantic_or_evidence_review');
  });
  it('requires every true proof and documented semantics; production remains disabled even on success', () => {
    const passing = Object.fromEntries(policy.required_checks.map((k) => [k, true]));
    expect(repairGate(passing)).toMatchObject({
      candidate_eligible: true,
      production_deploy_allowed: false,
      publication_allowed: false,
    });
    for (const key of policy.required_checks)
      for (const value of [false, null])
        expect(repairGate({ ...passing, [key]: value }).candidate_eligible).toBe(false);
    expect(repairGate(passing, ['unit'])).toMatchObject({
      candidate_eligible: false,
      remaining_human_action: 'confirm_source_semantics',
    });
  });
  it('keeps patch/test/reparse facts distinct from collection, publication and missing counts', async () => {
    const e = await evidence(),
      incident = IncidentSchema.parse({
        schema_version: 1,
        source_id: e.source_id,
        run_id: e.run_id,
        detected_at: time,
        observed_at: time,
        stage: 'projection',
        classification: 'schema_drift',
        schema_drift: true,
        evidence_state: 'preserved',
        evidence_ref: 'evidence/models_dev/' + e.run_id + '.quarantine.json',
        evidence_hash: e.body_hash,
        expires_at: e.expires_at,
        diagnostic_codes: ['wrapper_changed'],
        repair_status: 'not_started',
      });
    const status = {
      source_id: e.source_id,
      run_id: e.run_id,
      collection: 'failed',
      publication: 'awaiting_collection',
      observation_count: null,
      accepted_count: null,
    };
    const morning = overnightSource(status, JSON.stringify({ recovery: incident }), 1);
    const patch = '1'.repeat(64),
      report = {
        source_id: e.source_id,
        run_id: e.run_id,
        evidence_hash: e.body_hash,
        patch_sha256: patch,
        synthetic: true,
        regression_result: 'passed',
        reparse_result: 'passed_with_patched_parser',
        public_data_written: false,
        external_llm_called: false,
        checks: Object.fromEntries(policy.required_checks.map((k) => [k, true])),
        receipts: ['check', 'regression', 'runtime', 'build', 'preflight'].map((name) => ({
          name,
          exit_code: 0,
          started_at: time,
          finished_at: time,
          patch_sha256: patch,
          evidence_hash: e.body_hash,
        })),
      };
    const brief = attachRepairResult(morning, report, time, true);
    expect(brief).toMatchObject({
      regression_result: 'passed',
      repair_patch: 'generated',
      collection_status: 'failed',
      publication_status: 'awaiting_collection',
      missing_observation: null,
      missing_observation_count: null,
      remaining_human_action: 'review_gate_and_approve_deploy',
    });
    expect(attachRepairResult(morning, report, time).repair_evidence).toBe('mismatched_or_expired');
    expect(
      attachRepairResult(morning, { ...report, evidence_hash: '2'.repeat(64) }, time, true)
        .repair_evidence,
    ).toBe('mismatched_or_expired');
    expect(
      attachRepairResult(morning, { ...report, receipts: [] }, time, true).regression_result,
    ).toBe('failed_or_unverified');
    expect(
      overnightSource({ ...status, collection: 'complete', publication: 'failed' }),
    ).toMatchObject({
      missing_observation: false,
      missing_observation_count: 0,
      severity: 'action_required',
    });
    expect(
      overnightSource({ ...status, collection: 'unknown', publication: 'unknown' }),
    ).toMatchObject({
      schema_drift: 'not_reported',
      missing_observation: null,
      severity: 'unknown',
    });
    expect(overnightSource({ ...status, collection: 'missing' }).missing_observation).toBe(true);
    expect(
      overnightSource({
        ...status,
        collection: 'complete',
        publication: 'complete',
        observation_count: 10,
        accepted_count: 8,
        signals: [{ key: 'models_dev:quality', condition: 'alert', code: 'quarantine_changed' }],
      }),
    ).toMatchObject({
      severity: 'action_required',
      remaining_human_action: 'review_operational_alerts',
      quarantined_observation_count: 2,
    });
    expect(
      overnightSource({ ...status, collection: 'complete', snapshot: 'incomplete' })
        .missing_observation_count,
    ).toBeNull();
  });
});
