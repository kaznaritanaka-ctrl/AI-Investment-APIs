import { it, expect } from 'vitest';
import { mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { localEnv } from '../scripts/local-env';
import { readAdmin } from '../src/admin-read';
import { ReleaseRecord } from '../src/admin-contract';

it('prepares verified metadata, rejects mismatched evidence, and enforces append-only ledger inserts', async () => {
  const cli = await import(pathToFileURL(resolve('scripts/admin-release-record.mjs')).href);
  const dir = await mkdtemp(resolve('work/admin-release-test-'));
  const files = ['manifest.json', 'artifact.txt', 'evidence.json'].map((name) => join(dir, name));
  const local = await localEnv();
  try {
    const git = (ref: string) =>
      execFileSync('git', ['rev-parse', ref], { encoding: 'utf8', windowsHide: true }).trim();
    const proof = {
      worker: 'ai-investment-admin',
      version_id: '00000000-0000-4000-8000-000000000001',
      git_sha: git('HEAD'),
      event: 'verified',
      traffic_percent: 100,
      recorded_at: '2026-10-03T19:00:00.000Z',
      checks: { synthetic_runtime: 'passed' },
    };
    const artifact = 'synthetic artifact',
      evidence = JSON.stringify(proof);
    const record = ReleaseRecord.parse({
      ...proof,
      record_id: 'synthetic-release',
      tree_sha: git('HEAD^{tree}'),
      artifact_sha256: cli.digest(artifact),
      evidence_sha256: cli.digest(evidence),
      evidence_ref: 'synthetic/evidence.json',
      migration_names: ['0005_admin_release_ledger.sql'],
      github_url: null,
    });
    await writeFile(files[0], JSON.stringify(record));
    await writeFile(files[1], artifact);
    await writeFile(files[2], evidence);
    const options = {
      manifestPath: files[0],
      artifactPath: files[1],
      evidencePath: files[2],
      repository: process.cwd(),
    };
    const prepared = await cli.prepareRelease(options);
    const sql = prepared.sql.replace(/^--.*$/gm, '').split('\n')[1] || prepared.sql.split('\n')[1];
    await local.env.PRIVATE_DB.exec(sql);
    await local.env.PRIVATE_DB.exec(sql);
    const report = await readAdmin('releases', {}, local.env, proof.recorded_at);
    expect(report.releases!.records).toEqual([record]);
    await expect(
      local.env.PRIVATE_DB.prepare(
        "UPDATE admin_release_ledger SET worker='ai-investment-api'",
      ).run(),
    ).rejects.toThrow('append-only');
    await expect(
      local.env.PRIVATE_DB.prepare('DELETE FROM admin_release_ledger').run(),
    ).rejects.toThrow('append-only');
    await expect(
      local.env.PRIVATE_DB.prepare('INSERT OR IGNORE INTO admin_release_ledger VALUES (?,?,?,?,?)')
        .bind(record.record_id, record.worker, record.version_id, record.recorded_at, '{}')
        .run(),
    ).rejects.toThrow('release record conflict');
    await writeFile(files[1], 'wrong artifact');
    await expect(cli.prepareRelease(options)).rejects.toThrow('release_file_digest_mismatch');
  } finally {
    await local.mf.dispose();
    for (const file of files) await unlink(file).catch(() => {});
    await rmdir(dir);
  }
});
