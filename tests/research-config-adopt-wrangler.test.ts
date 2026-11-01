import { describe, expect, it, vi } from 'vitest';
import { wranglerResearchEnv } from '../scripts/research-config-adopt.js';

const marker = 'research-control/revocations/highreso_public.json';
const envWith = (call: (command: string[]) => string) =>
  wranglerResearchEnv(
    'private-db',
    'private-bucket',
    { PRIVATE_GPU_RESEARCH_ENABLED: 'true' },
    call,
  );

describe('Wrangler adoption adapters', () => {
  it('passes quoted SQL as a single argument with no shell and preserves D1 results', async () => {
    const call = vi.fn(() =>
      JSON.stringify([{ success: true, results: [{ value: 'found' }], meta: { changes: 1 } }]),
    );
    const env = envWith(call);
    const value = "quote' $(touch /tmp/not-executed) `touch /tmp/not-executed` ?";
    const statement = env.PRIVATE_DB.prepare('UPDATE example SET value=? WHERE id=?').bind(
      value,
      'id',
    );
    const result = await statement.run();
    expect(call).toHaveBeenCalledWith([
      'd1',
      'execute',
      'private-db',
      '--remote',
      '--json',
      '--command',
      "UPDATE example SET value='quote'' $(touch /tmp/not-executed) `touch /tmp/not-executed` ?' WHERE id='id'",
    ]);
    expect(result.meta.changes).toBe(1);
    expect(await statement.first()).toEqual({ value: 'found' });
  });

  it('rejects malformed bindings without calling Wrangler', () => {
    const call = vi.fn();
    const env = envWith(call);
    expect(() => env.PRIVATE_DB.prepare('SELECT ?').bind('nul\0value')).toThrow(
      'invalid_adoption_binding',
    );
    expect(() => env.PRIVATE_DB.prepare('SELECT ?').bind()).toThrow('invalid_adoption_binding');
    expect(() => env.PRIVATE_DB.prepare('SELECT 1').bind('extra')).toThrow(
      'invalid_adoption_binding',
    );
    expect(call).not.toHaveBeenCalled();
  });

  it('sanitizes failed D1 calls and rejects invalid response shapes', async () => {
    const raw = envWith(() => {
      throw new Error('sensitive raw error');
    });
    await expect(raw.PRIVATE_DB.prepare('SELECT ?').bind('x').first()).rejects.toThrow(
      /^adoption_d1_request_failed$/,
    );
    const malformed = envWith(() => 'not JSON with sensitive content');
    await expect(malformed.PRIVATE_DB.prepare('SELECT 1').bind().first()).rejects.toThrow(
      /^adoption_d1_request_failed$/,
    );
    for (const response of [
      [],
      [{ success: false, results: [] }],
      [{ success: true }],
      [
        { success: true, results: [] },
        { success: true, results: [] },
      ],
    ]) {
      const env = envWith(() => JSON.stringify(response));
      await expect(env.PRIVATE_DB.prepare('SELECT 1').bind().run()).rejects.toThrow(
        /^adoption_d1_invalid_result$/,
      );
    }
  });

  it('uses only marker existence and recognizes the explicit object-not-found response', async () => {
    const call = vi.fn(() => 'private marker body');
    const env = envWith(call);
    expect(await env.EVIDENCE.head(marker)).toEqual({});
    expect(call).toHaveBeenCalledWith([
      'r2',
      'object',
      'get',
      `private-bucket/${marker}`,
      '--remote',
      '--pipe',
    ]);
    const missingCall = vi.fn((command: string[]) => {
      if (command[1] === 'object') throw { status: 1, stderr: 'The specified key does not exist.' };
      return JSON.stringify({ name: 'private-bucket' });
    });
    const missing = envWith(missingCall);
    expect(await missing.EVIDENCE.head(marker)).toBeNull();
    expect(missingCall).toHaveBeenCalledTimes(2);
    expect(missingCall).toHaveBeenNthCalledWith(2, [
      'r2',
      'bucket',
      'info',
      'private-bucket',
      '--json',
    ]);
  });

  it('rejects a missing key when the exact bucket cannot be confirmed', async () => {
    for (const result of [
      JSON.stringify({ name: 'wrong-bucket' }),
      JSON.stringify({}),
      'not JSON',
      new Error('bucket missing'),
      new Error('bucket access denied'),
    ]) {
      const call = vi.fn((command: string[]) => {
        if (command[1] === 'object')
          throw { status: 1, stderr: 'The specified key does not exist.' };
        if (result instanceof Error) throw result;
        return result;
      });
      await expect(envWith(call).EVIDENCE.head(marker)).rejects.toThrow(
        /^adoption_r2_check_failed$/,
      );
      expect(call).toHaveBeenNthCalledWith(2, ['r2', 'bucket', 'info', 'private-bucket', '--json']);
    }
  });

  it('fails closed on R2 authorization, timeout, oversize and ambiguous errors', async () => {
    for (const failure of [
      { status: 1, stderr: 'authentication failed' },
      { status: null, error: new Error('timeout') },
      {
        status: 1,
        stderr: 'The specified key does not exist.',
        error: new Error('maxBuffer exceeded'),
      },
      { status: 2, stderr: 'The specified key does not exist.' },
    ]) {
      const env = envWith(() => {
        throw failure;
      });
      await expect(env.EVIDENCE.head(marker)).rejects.toThrow(/^adoption_r2_check_failed$/);
    }
    const call = vi.fn();
    const env = envWith(call);
    await expect(env.EVIDENCE.head('research-control/deletions/other.json')).rejects.toThrow(
      'unsupported_adoption_r2_key',
    );
    expect(call).not.toHaveBeenCalled();
  });

  it('uses the supplied collector vars rather than process environment for feature flags', () => {
    vi.stubEnv('PRIVATE_GPU_RESEARCH_ENABLED', 'true');
    vi.stubEnv('DC_TRACKER_ENABLED', 'true');
    try {
      const env = wranglerResearchEnv(
        'private-db',
        'private-bucket',
        { PRIVATE_GPU_RESEARCH_ENABLED: 'false' },
        () => '',
      );
      expect(env.ENVIRONMENT).toBe('production');
      expect(env.PRIVATE_GPU_RESEARCH_ENABLED).toBe('false');
      expect(env.DC_TRACKER_ENABLED).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
