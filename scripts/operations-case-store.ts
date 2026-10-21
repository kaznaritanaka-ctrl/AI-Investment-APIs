import { lstat, mkdir, open, readFile, readdir, realpath, unlink } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { operationsHandoff } from '../src/operations-handoff';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (code: string): never => {
  throw new Error(code);
};
async function privateDirectory(path: string) {
  const stat = await lstat(path);
  if (
    !isAbsolute(path) ||
    resolve(path) !== path ||
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (await realpath(path)) !== path ||
    (process.platform !== 'win32' && stat.mode & 0o077)
  )
    fail('private_canonical_directory_required');
}

// Offline intake, not an agent runner. One root is shared by cooperating local
// readers. Immutable revisions deduplicate repeated polling; no leases are stolen.
export async function enqueueOperationsCases(
  input: unknown,
  slot: string,
  root: string,
  now: string,
) {
  const handoff = await operationsHandoff(input, slot, now);
  const base = {
    schema_version: 'operations-cases-v1',
    generated_at: now,
    coverage: handoff.coverage,
    more_pages: handoff.more_pages,
    agent_invoked: false,
    production_deploy_allowed: false,
    publication_allowed: false,
    network_used: false,
    source_payload_included: false,
    admin_write_performed: false,
  };
  if (handoff.state !== 'ready') return { ...base, state: 'refresh_required', cases: [] };
  if (handoff.items.length > 100) fail('case_input_limit');
  await privateDirectory(root);
  let lock;
  try {
    lock = await open(join(root, '.intake.lock'), 'wx', 0o600);
  } catch {
    fail('intake_locked');
  }
  try {
    const existing = (await readdir(root)).filter((n) => n !== '.intake.lock');
    if (existing.length > 1000 || existing.some((n) => !/^[a-f0-9]{64}$/.test(n)))
      fail('case_store_requires_review');
    const cases = [];
    let added = 0;
    for (const item of handoff.items) {
      // as_of changes at every poll. It must not create another investigation of
      // an otherwise identical canonical run, diagnosis and evidence identity.
      const { admin_path: _link, ...metadata } = item;
      metadata.diagnostic_codes = [...new Set(metadata.diagnostic_codes)].sort();
      const revision = digest(metadata);
      const directory = join(root, item.incident_key);
      if (!existing.includes(item.incident_key)) {
        if (existing.length >= 1000) fail('case_store_capacity');
        await mkdir(directory, { mode: 0o700 });
        existing.push(item.incident_key);
      }
      await privateDirectory(directory);
      const files = await readdir(directory);
      if (files.some((n) => !/^[a-f0-9]{64}\.json$/.test(n))) fail('case_store_requires_review');
      const path = join(directory, revision + '.json');
      if (files.includes(revision + '.json')) {
        const stat = await lstat(path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 32768)
          fail('case_record_invalid');
        const saved = JSON.parse(await readFile(path, 'utf8'));
        if (
          saved.schema_version !== 'operations-case-revision-v1' ||
          saved.revision !== revision ||
          saved.logical_slot !== slot ||
          digest(saved.metadata) !== revision
        )
          fail('case_record_invalid');
        cases.push({ incident_key: item.incident_key, revision, state: 'already_recorded' });
        continue;
      }
      // Bounded intake per call and per source/slot. Saturation is visible and is
      // not treated as a successful investigation or silently overwritten.
      if (added >= 10 || files.length >= 8) {
        cases.push({ incident_key: item.incident_key, revision, state: 'intake_limit' });
        continue;
      }
      const record = {
        schema_version: 'operations-case-revision-v1',
        revision,
        first_seen_at: now,
        logical_slot: slot,
        metadata,
        as_of: handoff.as_of,
        admin_path: item.admin_path,
        state: 'awaiting_authorized_runner',
        agent_invoked: false,
        production_deploy_allowed: false,
        publication_allowed: false,
        regression_result: 'not_reported',
        reparse_result: 'not_reported',
      };
      const file = await open(path, 'wx', 0o600);
      try {
        await file.writeFile(JSON.stringify(record));
        await file.sync();
      } finally {
        await file.close();
      }
      added++;
      cases.push({ incident_key: item.incident_key, revision, state: 'recorded' });
    }
    return {
      ...base,
      state: cases.some((c) => c.state === 'intake_limit') ? 'limited' : 'recorded',
      cases,
    };
  } finally {
    await lock!.close();
    await unlink(join(root, '.intake.lock'));
  }
}
