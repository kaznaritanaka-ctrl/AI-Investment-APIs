import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ReleaseRecord } from '../src/admin-contract.ts';

export const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
// Produces a reviewable local SQL artifact. It never connects to Cloudflare or executes SQL.
export async function prepareRelease({ manifestPath, artifactPath, evidencePath, repository }) {
  const record = ReleaseRecord.parse(JSON.parse(await readFile(manifestPath, 'utf8')));
  const artifact = await readFile(artifactPath),
    evidence = await readFile(evidencePath);
  if (digest(artifact) !== record.artifact_sha256 || digest(evidence) !== record.evidence_sha256)
    throw new Error('release_file_digest_mismatch');
  const proof = JSON.parse(evidence.toString('utf8'));
  for (const key of ['worker', 'version_id', 'git_sha', 'event', 'traffic_percent', 'recorded_at'])
    if (proof[key] !== record[key]) throw new Error('release_evidence_mismatch');
  if (JSON.stringify(proof.checks) !== JSON.stringify(record.checks))
    throw new Error('release_checks_mismatch');
  const tree = execFileSync('git', ['rev-parse', record.git_sha + '^{tree}'], {
    cwd: repository,
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
  if (tree !== record.tree_sha) throw new Error('release_git_tree_mismatch');
  const quote = (s) => "'" + s.replaceAll("'", "''") + "'";
  const values = [
    record.record_id,
    record.worker,
    record.version_id,
    record.recorded_at,
    JSON.stringify(record),
  ].map(quote);
  // Exact duplicates are idempotent; differing data with the same ID is rejected by the trigger.
  const sql =
    '-- Owner review required before remote execution. Metadata only.\n' +
    'INSERT OR IGNORE INTO admin_release_ledger(record_id,worker,version_id,recorded_at,record_json) VALUES (' +
    values.join(',') +
    ');\n' +
    'SELECT record_id,worker,version_id,recorded_at FROM admin_release_ledger WHERE record_id=' +
    quote(record.record_id) +
    ';\n';
  return { record, sql };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [manifestPath, artifactPath, evidencePath, repository, outputPath] = process.argv.slice(2);
  if (!outputPath)
    throw new Error(
      'Usage: node scripts/admin-release-record.mjs manifest.json artifact evidence.json repository output.sql',
    );
  const prepared = await prepareRelease({ manifestPath, artifactPath, evidencePath, repository });
  await writeFile(outputPath, prepared.sql, { encoding: 'utf8', flag: 'wx' });
  console.log(
    JSON.stringify({ record_id: prepared.record.record_id, state: 'prepared_not_applied' }),
  );
}
