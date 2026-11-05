import { describe, expect, it } from 'vitest';
import { hash, stable } from '../src/canonical';
import { ResearchConfigSchema } from '../src/research/schema';
import type { ResearchEnv } from '../src/research/pipeline';
import { runResearchConfigAdoption } from '../scripts/research-config-adopt-core';
import oldConfig from '../config/history/highreso_public.v4.json';
import newConfig from '../config/proposals/research/highreso_public.json';
import identityConfig from '../config/proposals/highreso-stable-key.json';
import { dcResearchConfigs } from '../src/research/dc-sources';

const now = '2026-11-01T03:50:00.000Z';
type Version = {
  config_hash: string;
  source_id: string;
  policy_version: string;
  config_json: string;
};

async function fake(input: unknown = oldConfig) {
  const old = ResearchConfigSchema.parse(input);
  const oldHash = await hash(stable(old));
  const state = {
    current: { config_hash: oldHash, policy_version: old.source.policy.version, suspended: 0 },
    versions: [
      {
        config_hash: oldHash,
        source_id: old.source.source_id,
        policy_version: old.source.policy.version,
        config_json: stable(old),
      },
    ] as Version[],
    writes: 0,
    marker: false,
    headError: false,
    heads: [] as string[],
  };
  const db = {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          return {
            async first() {
              if (sql.startsWith('SELECT config_hash,policy_version,suspended'))
                return { ...state.current };
              if (sql.startsWith('SELECT source_id,config_json')) {
                const version = state.versions.find((item) => item.config_hash === values[0]);
                return version
                  ? { source_id: version.source_id, config_json: version.config_json }
                  : null;
              }
              if (sql.startsWith('SELECT config_hash FROM research_config_versions')) {
                const version = state.versions.find(
                  (item) => item.source_id === values[0] && item.policy_version === values[1],
                );
                return version ? { config_hash: version.config_hash } : null;
              }
              throw new Error(`unexpected read: ${sql}`);
            },
            async run() {
              state.writes++;
              if (sql.startsWith('INSERT OR IGNORE INTO research_config_versions')) {
                const [config_hash, source_id, policy_version, , config_json] = values as string[];
                if (
                  !state.versions.some(
                    (item) =>
                      item.config_hash === config_hash ||
                      (item.source_id === source_id && item.policy_version === policy_version),
                  )
                )
                  state.versions.push({ config_hash, source_id, policy_version, config_json });
                return { meta: { changes: 1 } };
              }
              if (sql.startsWith('UPDATE research_sources SET policy_version')) {
                const [policy_version, config_hash, , expected] = values as string[];
                if (state.current.config_hash !== expected || state.current.suspended)
                  return { meta: { changes: 0 } };
                state.current = { config_hash, policy_version, suspended: 0 };
                return { meta: { changes: 1 } };
              }
              throw new Error(`unexpected write: ${sql}`);
            },
          };
        },
      };
    },
  };
  const env = {
    ENVIRONMENT: 'production',
    PRIVATE_GPU_RESEARCH_ENABLED: 'true',
    PRIVATE_DB: db,
    EVIDENCE: {
      head: async (key: string) => {
        state.heads.push(key);
        if (state.headError) throw new Error('head_failed');
        return state.marker ? {} : null;
      },
    },
  } as unknown as ResearchEnv;
  return { state, env, oldHash };
}

describe('reviewed research config adoption runner', () => {
  it.each(dcResearchConfigs.map((config) => [config.source.source_id, config] as const))(
    'supports %s in production dry-run with the independent DC flag',
    async (_id, config) => {
      const old = structuredClone(config);
      // Model an already registered, earlier policy without granting historical access.
      old.source.policy.version += '-synthetic-prior';
      const { env, state, oldHash } = await fake(old);
      env.PRIVATE_GPU_RESEARCH_ENABLED = 'false';
      env.DC_TRACKER_ENABLED = 'true';
      const result = await runResearchConfigAdoption({
        env,
        config,
        expectedCurrentHash: oldHash,
        now,
      });
      expect(result.status).toBe('dry-run');
      expect(result.new_hash).toBe(await hash(stable(ResearchConfigSchema.parse(config))));
      expect(result.statements).toHaveLength(2);
      expect(result.statements[1].bindings).toEqual([
        config.source.policy.version,
        result.new_hash,
        config.source.source_id,
        oldHash,
      ]);
      expect(state.heads).toContain(`research-control/revocations/${config.source.source_id}.json`);
      expect(state.writes).toBe(0);
      expect(state.current.config_hash).toBe(oldHash);
    },
  );
  it('runs the gates and reports exact parameterized writes without changing the database', async () => {
    const { env, state, oldHash } = await fake();
    const result = await runResearchConfigAdoption({
      env,
      config: newConfig,
      expectedCurrentHash: oldHash,
      now,
    });
    const digest = await hash(stable(ResearchConfigSchema.parse(newConfig)));
    expect(result).toMatchObject({
      status: 'dry-run',
      new_hash: digest,
      current: {
        config_hash: oldHash,
        policy_version: oldConfig.source.policy.version,
        suspended: 0,
      },
    });
    expect(state.heads).toContain('research-control/revocations/highreso_public.json');
    expect(state.writes).toBe(0);
    expect(state.current.config_hash).toBe(oldHash);
    expect(result.statements).toEqual([
      {
        sql: 'INSERT OR IGNORE INTO research_config_versions(config_hash,source_id,policy_version,registered_at,config_json) VALUES (?,?,?,?,?)',
        bindings: [
          digest,
          'highreso_public',
          newConfig.source.policy.version,
          now,
          { config_json_hash: digest },
        ],
      },
      {
        sql: 'UPDATE research_sources SET policy_version=?,config_hash=? WHERE source_id=? AND config_hash=? AND suspended=0',
        bindings: [newConfig.source.policy.version, digest, 'highreso_public', oldHash],
      },
    ]);
    expect(JSON.stringify(result)).not.toContain('known_limitations');
  });
  it('applies once and reports an idempotent second adoption even with the old expected hash', async () => {
    const { env, state, oldHash } = await fake();
    const args = { env, config: newConfig, expectedCurrentHash: oldHash, now, apply: true };
    const first = await runResearchConfigAdoption(args);
    expect(first.status).toBe('adopted');
    expect(state.current).toEqual({
      config_hash: first.new_hash,
      policy_version: newConfig.source.policy.version,
      suspended: 0,
    });
    expect(state.writes).toBe(2);
    const again = await runResearchConfigAdoption(args);
    expect(again.status).toBe('already adopted');
    expect(again.statements).toEqual([]);
    expect(state.writes).toBe(2);
  });
  it('refuses a mismatched expected hash without writing', async () => {
    const { env, state } = await fake();
    await expect(
      runResearchConfigAdoption({
        env,
        config: newConfig,
        expectedCurrentHash: '0'.repeat(64),
        now,
        apply: true,
      }),
    ).rejects.toThrow('research_policy_changed');
    expect(state.writes).toBe(0);
  });
  it('fails closed for a revoked marker, a failed marker read, or a disabled production flag', async () => {
    const { env, state, oldHash } = await fake();
    const args = { env, config: newConfig, expectedCurrentHash: oldHash, now, apply: true };
    state.marker = true;
    await expect(runResearchConfigAdoption(args)).rejects.toThrow('research_source_revoked');
    state.marker = false;
    state.headError = true;
    await expect(runResearchConfigAdoption(args)).rejects.toThrow('head_failed');
    state.headError = false;
    env.PRIVATE_GPU_RESEARCH_ENABLED = 'false';
    await expect(runResearchConfigAdoption(args)).rejects.toThrow(
      'research_production_not_integrated',
    );
    expect(state.writes).toBe(0);
  });
  it('rejects a policy version already assigned to another hash during dry-run', async () => {
    const { env, state, oldHash } = await fake();
    state.versions.push({
      config_hash: 'f'.repeat(64),
      source_id: 'highreso_public',
      policy_version: newConfig.source.policy.version,
      config_json: '{}',
    });
    await expect(
      runResearchConfigAdoption({ env, config: newConfig, expectedCurrentHash: oldHash, now }),
    ).rejects.toThrow('research_policy_version_reused');
    expect(state.writes).toBe(0);
  });
  it('checks approved historical config for the identity upgrade and rejects a missing history record', async () => {
    const { env, state, oldHash } = await fake();
    const args = { env, config: identityConfig, expectedCurrentHash: oldHash, now };
    const result = await runResearchConfigAdoption(args);
    expect(result.status).toBe('dry-run');
    expect(state.writes).toBe(0);
    state.versions = [];
    await expect(runResearchConfigAdoption(args)).rejects.toThrow(
      'research_history_scope_unreviewed',
    );
    expect(state.writes).toBe(0);
  });
});
