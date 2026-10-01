import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { expect, it } from 'vitest';
import deployment from '../config/deployment.json';
import { inspectPreflight } from '../scripts/preflight-core';

const collectorConfig = JSON.parse(
  readFileSync(new NodeURL('../wrangler.collector.jsonc', import.meta.url), 'utf8'),
);
const apiConfig = JSON.parse(
  readFileSync(new NodeURL('../wrangler.api.jsonc', import.meta.url), 'utf8'),
);
const schedules = ['17 18 * * *', '47 18 * * *', '*/5 18-23 * * *'];

function fixture(stage: 'bootstrap' | 'enabled') {
  const collector = structuredClone(collectorConfig),
    api = structuredClone(apiConfig);
  // Stage, activation flag, routes and schedules must not follow production rollout state.
  collector.vars = {
    ...collector.vars,
    COLLECTION_CRON: schedules[0],
    WATCHDOG_CRON: schedules[1],
    GPU_RESUME_CRON: schedules[2],
    COLLECTION_ENABLED: stage === 'enabled' ? 'true' : 'false',
  };
  collector.triggers = { crons: stage === 'enabled' ? [...schedules] : [] };
  api.routes =
    stage === 'enabled' ? [{ pattern: 'api.' + deployment.owned_domain, custom_domain: true }] : [];
  return { deployment: { ...deployment, stage }, collector, api };
}

function errors(config: ReturnType<typeof fixture>) {
  // Source rights are covered separately; these tests isolate deployment scheduling.
  return inspectPreflight(config.deployment, config.collector, config.api, []).errors;
}

it('accepts bootstrap with stopped Crons, disabled collection and no public routes', () => {
  expect(errors(fixture('bootstrap'))).toEqual([]);
});

it('rejects active bootstrap Crons while collection and public routes remain disabled', () => {
  const config = fixture('bootstrap');
  config.collector.triggers.crons = [schedules[0]];
  expect(errors(config)).toEqual(['bootstrap_cron_not_stopped']);
});

it('rejects enabled collection during bootstrap even with no Crons', () => {
  const config = fixture('bootstrap');
  config.collector.vars.COLLECTION_ENABLED = 'true';
  expect(errors(config)).toEqual(['bootstrap_cron_not_stopped']);
});

it('accepts the three enabled Crons regardless of order', () => {
  const config = fixture('enabled');
  config.collector.triggers.crons.reverse();
  expect(errors(config)).toEqual([]);
});

it.each(schedules)('rejects enabled configuration missing Cron %s', (missing) => {
  const config = fixture('enabled');
  config.collector.triggers.crons = schedules.filter((cron) => cron !== missing);
  expect(errors(config)).toEqual(['enabled_schedule_mismatch']);
});

it('rejects enabled configuration with an extra Cron', () => {
  const config = fixture('enabled');
  config.collector.triggers.crons.push('0 0 * * *');
  expect(errors(config)).toEqual(['enabled_schedule_mismatch']);
});

it('rejects disabled collection with all three enabled Crons configured', () => {
  const config = fixture('enabled');
  config.collector.vars.COLLECTION_ENABLED = 'false';
  expect(errors(config)).toEqual(['enabled_schedule_mismatch']);
});
