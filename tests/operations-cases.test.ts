import { expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { enqueueOperationsCases } from '../scripts/operations-case-store';
import { Run } from '../src/admin-contract';

const slot = '2026-10-08T18:17:00.000Z',
  now = '2026-10-08T18:22:00.000Z';
function report(at = now) {
  return {
    schema_version: 'admin-read-v1',
    resource: 'runs',
    fetched_at: at,
    as_of: at,
    state: 'ready',
    issues: [],
    next_cursor: null,
    runs: [
      Run.parse({
        run_id: 'a'.repeat(64),
        canonical_run_id: 'a'.repeat(64),
        source_id: 'price_of_compute',
        logical_slot: slot,
        scheduled_for: slot,
        state: 'complete',
        started_at: slot,
        finished_at: slot,
        last_progress_at: slot,
        observation_count: 14,
        accepted_count: 13,
        quarantined_count: 1,
        error_code: null,
        recovery_count: 0,
        next_attempt_at: null,
        publication: {
          state: 'not_applicable',
          original_count: 0,
          derived_count: 0,
          visible_count: 0,
          completed_at: null,
        },
        checkpoints: [],
        attempts: [],
        invocations: [],
        details_truncated: false,
      }),
    ],
  };
}
async function root() {
  await mkdir('work/operations-case-tests', { recursive: true });
  return mkdtemp(resolve('work/operations-case-tests/synthetic-'));
}
it('deduplicates unchanged incident polling across as_of times without claiming an investigation or recovery', async () => {
  const dir = await root();
  const first = await enqueueOperationsCases(report(), slot, dir, now);
  expect(first).toMatchObject({
    state: 'recorded',
    agent_invoked: false,
    admin_write_performed: false,
    source_payload_included: false,
    production_deploy_allowed: false,
    publication_allowed: false,
  });
  expect(first.cases[0].state).toBe('recorded');
  const nextTime = '2026-10-08T18:23:00.000Z';
  const repeated = await enqueueOperationsCases(report(nextTime), slot, dir, nextTime);
  expect(repeated.cases[0]).toEqual({ ...first.cases[0], state: 'already_recorded' });
  const file = join(dir, first.cases[0].incident_key, first.cases[0].revision + '.json');
  const saved = JSON.parse(await readFile(file, 'utf8'));
  expect(saved).toMatchObject({
    first_seen_at: now,
    state: 'awaiting_authorized_runner',
    regression_result: 'not_reported',
    reparse_result: 'not_reported',
    metadata: { error_code: null },
  });
});

it('records changed diagnoses as immutable revisions and sanitizes arbitrary errors', async () => {
  const dir = await root();
  const initial = await enqueueOperationsCases(report(), slot, dir, now);
  const changed = report();
  changed.runs[0].error_code = 'private-sentinel-token';
  const result = await enqueueOperationsCases(changed, slot, dir, now);
  expect(result.cases[0].incident_key).toBe(initial.cases[0].incident_key);
  expect(result.cases[0].revision).not.toBe(initial.cases[0].revision);
  const folder = join(dir, result.cases[0].incident_key);
  const files = await readdir(folder);
  expect(files).toHaveLength(2);
  for (const file of files)
    expect(await readFile(join(folder, file), 'utf8')).not.toContain('private-sentinel');
});

it('leaves incomplete or stale reports unqueued and preserves pagination coverage', async () => {
  const dir = await root();
  expect(
    await enqueueOperationsCases({ ...report(), state: 'partial' }, slot, dir, now),
  ).toMatchObject({ state: 'refresh_required', cases: [] });
  expect(
    await enqueueOperationsCases(report('2026-10-08T18:00:00.000Z'), slot, dir, now),
  ).toMatchObject({ state: 'refresh_required', cases: [] });
  expect(await readdir(dir)).toEqual([]);
  expect(
    await enqueueOperationsCases({ ...report(), next_cursor: 'more' }, slot, dir, now),
  ).toMatchObject({ more_pages: true, coverage: 'provided_runs_only' });
});

it('bounds noisy revisions per source and slot and rejects changed existing records', async () => {
  const dir = await root();
  let last;
  for (let i = 0; i < 9; i++) {
    const input = report();
    input.runs[0].run_id = i.toString(16).repeat(64);
    last = await enqueueOperationsCases(input, slot, dir, now);
    expect(last.cases[0].state).toBe(i === 8 ? 'intake_limit' : 'recorded');
  }
  expect(last!.state).toBe('limited');
  const folder = join(dir, last!.cases[0].incident_key);
  const files = await readdir(folder);
  expect(files).toHaveLength(8);
  const f = join(folder, files[0]);
  const saved = JSON.parse(await readFile(f, 'utf8'));
  const originalId = saved.metadata.run_id;
  saved.metadata.collection_status = 'invented';
  await writeFile(f, JSON.stringify(saved));
  const input = report();
  input.runs[0].run_id = originalId;
  await expect(enqueueOperationsCases(input, slot, dir, now)).rejects.toThrow(
    'case_record_invalid',
  );
});

it('does not steal a runner lock or accept unknown files in the case store', async () => {
  const dir = await root();
  await writeFile(join(dir, '.intake.lock'), 'synthetic-owner');
  await expect(enqueueOperationsCases(report(), slot, dir, now)).rejects.toThrow('intake_locked');
  expect(await readFile(join(dir, '.intake.lock'), 'utf8')).toBe('synthetic-owner');
  const other = await root();
  await writeFile(join(other, 'unrelated'), 'keep');
  await expect(enqueueOperationsCases(report(), slot, other, now)).rejects.toThrow(
    'requires_review',
  );
  expect(await readFile(join(other, 'unrelated'), 'utf8')).toBe('keep');
});
