import { hash, stable } from '../src/canonical';
import { assertResearchConfigExecution } from '../src/research/execution';
import type { ResearchEnv } from '../src/research/pipeline';
import { adoptReviewedResearchConfig, assertNotRevoked } from '../src/research/retention';
import { assertResearchAllowed, ResearchConfigSchema } from '../src/research/schema';

export const CURRENT_SQL =
  'SELECT config_hash,policy_version,suspended FROM research_sources WHERE source_id=?';
const INSERT_SQL =
  'INSERT OR IGNORE INTO research_config_versions(config_hash,source_id,policy_version,registered_at,config_json) VALUES (?,?,?,?,?)';
const VERSION_SQL =
  'SELECT config_hash FROM research_config_versions WHERE source_id=? AND policy_version=?';
const UPDATE_SQL =
  'UPDATE research_sources SET policy_version=?,config_hash=? WHERE source_id=? AND config_hash=? AND suspended=0';
type Current = { config_hash: string; policy_version: string; suspended: number };

// Execute the real adoption function. Only its two writes are simulated in dry-run;
// all reads, including version collisions and history scope, still use the supplied DB.
export async function runResearchConfigAdoption({
  env,
  config: input,
  expectedCurrentHash,
  apply = false,
  now = new Date().toISOString(),
}: {
  env: ResearchEnv;
  config: unknown;
  expectedCurrentHash: string;
  apply?: boolean;
  now?: string;
}) {
  if (!/^[a-f0-9]{64}$/.test(expectedCurrentHash)) throw new Error('invalid_expected_hash');
  const config = ResearchConfigSchema.parse(input);
  assertResearchConfigExecution(env, config);
  if (config.source.enabled) assertResearchAllowed(config, now, config.terms.version);
  await assertNotRevoked(env, config.source.source_id);
  const digest = await hash(stable(config));
  const current = await env.PRIVATE_DB.prepare(CURRENT_SQL)
    .bind(config.source.source_id)
    .first<Current>();
  const statements: { sql: string; bindings: unknown[] }[] = [];
  if (
    current?.config_hash === digest &&
    current.policy_version === config.source.policy.version &&
    current.suspended === 0
  )
    return { status: 'already adopted', new_hash: digest, current, statements };

  let pendingVersion = false;
  const db = {
    prepare(sql: string) {
      return {
        bind(...bindings: unknown[]) {
          const original = () => env.PRIVATE_DB.prepare(sql).bind(...bindings);
          return {
            async first() {
              const row = await original().first();
              if (!row && !apply && pendingVersion && sql === VERSION_SQL)
                return { config_hash: digest };
              return row;
            },
            async run() {
              if (sql !== INSERT_SQL && sql !== UPDATE_SQL)
                throw new Error('unsupported_adoption_write');
              // Exact parameterized SQL; never expose the stored config body.
              statements.push({
                sql,
                bindings: bindings.map((value, index) =>
                  sql === INSERT_SQL && index === 4 ? { config_json_hash: digest } : value,
                ),
              });
              if (apply) return original().run();
              if (sql === INSERT_SQL) {
                pendingVersion = true;
                return { meta: { changes: 0 } };
              }
              const latest = await env.PRIVATE_DB.prepare(CURRENT_SQL)
                .bind(config.source.source_id)
                .first<Current>();
              return {
                meta: {
                  changes:
                    latest?.config_hash === expectedCurrentHash && latest.suspended === 0 ? 1 : 0,
                },
              };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  await adoptReviewedResearchConfig(
    { ...env, PRIVATE_DB: db },
    config,
    expectedCurrentHash,
    now,
    config.terms.version,
  );
  return { status: apply ? 'adopted' : 'dry-run', new_hash: digest, current, statements };
}
