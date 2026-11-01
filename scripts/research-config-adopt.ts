import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import type { ResearchEnv } from '../src/research/pipeline';
import { runResearchConfigAdoption } from './research-config-adopt-core';

export const usage =
  'usage: node scripts/research-config-adopt.mjs CONFIG --expected-current-hash HASH [--dry-run | --apply]';

export async function main() {
  const args = process.argv.slice(2);
  if (
    (args.length !== 3 && args.length !== 4) ||
    args[0].startsWith('-') ||
    args[1] !== '--expected-current-hash' ||
    !/^[a-f0-9]{64}$/.test(args[2]) ||
    (args.length === 4 && !['--dry-run', '--apply'].includes(args[3]))
  )
    throw new Error(usage);
  // Same strict-JSON convention as preflight.mjs; never use process.env for gate flags.
  const collectorPath = resolve('wrangler.collector.jsonc');
  const collector = JSON.parse(readFileSync(collectorPath, 'utf8'));
  const database = collector.d1_databases?.find(
    (binding: { binding: string }) => binding.binding === 'PRIVATE_DB',
  );
  const bucket = collector.r2_buckets?.find(
    (binding: { binding: string }) => binding.binding === 'EVIDENCE',
  );
  if (
    collector.vars?.ENVIRONMENT !== 'production' ||
    database?.database_name !== 'ai-investment-private' ||
    !bucket?.bucket_name
  )
    throw new Error('adoption_private_bindings_unconfigured');
  const config = JSON.parse(readFileSync(args[0], 'utf8'));
  // Wrangler may log SQL on errors. Capture output, use a private temporary log,
  // suppress telemetry, and always remove it; never forward raw CLI errors.
  const scratch = mkdtempSync(join(tmpdir(), 'research-adopt-'));
  try {
    const call = (command: string[], maxBuffer = 2 * 1024 * 1024) =>
      execFileSync(
        process.execPath,
        [resolve('node_modules/wrangler/bin/wrangler.js'), ...command, '-c', collectorPath],
        {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 60000,
          maxBuffer,
          env: {
            ...process.env,
            CLOUDFLARE_ACCOUNT_ID: collector.account_id,
            WRANGLER_SEND_METRICS: 'false',
            WRANGLER_LOG_PATH: join(scratch, 'wrangler.log'),
            CI: 'true',
            NO_COLOR: '1',
          },
        },
      );
    const env = wranglerResearchEnv(
      database.database_name,
      bucket.bucket_name,
      collector.vars,
      call,
    );
    console.log(
      JSON.stringify(
        await runResearchConfigAdoption({
          env,
          config,
          expectedCurrentHash: args[2],
          apply: args[3] === '--apply',
        }),
        null,
        2,
      ),
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function wranglerResearchEnv(
  databaseName: string,
  bucketName: string,
  vars: Record<string, string>,
  call: (command: string[]) => string,
): ResearchEnv {
  const db = {
    prepare(sql: string) {
      return {
        bind(...bindings: unknown[]) {
          // No shell. Quote text as SQLite literals; source SQL alone supplies placeholders.
          let index = 0;
          const command = sql.replace(/\?/g, () => {
            const value = bindings[index++];
            if (typeof value !== 'string' || value.includes('\0'))
              throw new Error('invalid_adoption_binding');
            return "'" + value.replaceAll("'", "''") + "'";
          });
          if (index !== bindings.length) throw new Error('invalid_adoption_binding');
          const execute = () => {
            let output;
            try {
              output = JSON.parse(
                call(['d1', 'execute', databaseName, '--remote', '--json', '--command', command]),
              );
            } catch {
              throw new Error('adoption_d1_request_failed');
            }
            if (
              !Array.isArray(output) ||
              output.length !== 1 ||
              output[0]?.success !== true ||
              !Array.isArray(output[0].results)
            )
              throw new Error('adoption_d1_invalid_result');
            return output[0];
          };
          return {
            async first() {
              return execute().results[0] ?? null;
            },
            async run() {
              return execute();
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  const evidence = {
    async head(key: string) {
      if (!/^research-control\/revocations\/[a-z0-9_-]+\.json$/.test(key))
        throw new Error('unsupported_adoption_r2_key');
      try {
        // GET is the existing Wrangler equivalent of HEAD: only existence is used.
        // Never print, parse, or save the marker body. No R2 mutation commands exist here.
        call(['r2', 'object', 'get', bucketName + '/' + key, '--remote', '--pipe']);
        return {};
      } catch (error) {
        const failure = error as { status?: number; stderr?: string; error?: unknown };
        // Only Wrangler's explicit object-not-found is absence. Auth/network/timeout
        // failures and oversized bodies all fail closed.
        if (
          failure.status === 1 &&
          !failure.error &&
          String(failure.stderr).includes('The specified key does not exist.')
        ) {
          // Wrangler maps every HTTP 404 to "key does not exist", including a
          // missing/wrong bucket. Confirm that exact bucket before accepting absence.
          try {
            const info = JSON.parse(call(['r2', 'bucket', 'info', bucketName, '--json']));
            if (info?.name === bucketName) return null;
          } catch {
            // Missing bucket, permissions, invalid output and network errors all deny.
          }
        }
        throw new Error('adoption_r2_check_failed');
      }
    },
  } as unknown as R2Bucket;
  return {
    PRIVATE_DB: db,
    EVIDENCE: evidence,
    ENVIRONMENT: 'production',
    PRIVATE_GPU_RESEARCH_ENABLED: vars.PRIVATE_GPU_RESEARCH_ENABLED,
    DC_TRACKER_ENABLED: vars.DC_TRACKER_ENABLED,
  } satisfies ResearchEnv;
}
