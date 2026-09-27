import { describe, it, expect, vi } from 'vitest';
import { fetchSource } from '../src/network';
import { source, time, responder } from './helpers';
describe('bounded HTTP (all mocked)', () => {
  it('prohibited sources and arbitrary endpoints cause zero HTTP', async () => {
    const fetcher = vi.fn();
    await expect(fetchSource(source('openrouter'), { fetcher, now: () => time })).rejects.toThrow(
      'policy_blocked',
    );
    const s = source('ecb');
    s.endpoint = 'http://169.254.169.254';
    await expect(fetchSource(s, { fetcher, now: () => time })).rejects.toThrow(
      'endpoint_not_allowed',
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('403 and redirects have no retry or fallback', async () => {
    for (const status of [403, 302]) {
      const f = vi.fn(
        async () => new Response(null, { status, headers: { location: 'https://evil.invalid' } }),
      );
      await expect(
        fetchSource(source('ecb'), { fetcher: f as typeof fetch, now: () => time }),
      ).rejects.toThrow(status === 403 ? 'http_403' : 'redirect_blocked');
      expect(f).toHaveBeenCalledTimes(1);
    }
  });
  it('honors Retry-After with maximum three attempts', async () => {
    const waits: number[] = [],
      f = vi.fn(async () => new Response(null, { status: 429, headers: { 'retry-after': '2' } }));
    await expect(
      fetchSource(source('ecb'), {
        fetcher: f as typeof fetch,
        now: () => time,
        sleep: async (n) => {
          waits.push(n);
        },
        random: () => 0,
      }),
    ).rejects.toThrow('retryable_429');
    expect(f).toHaveBeenCalledTimes(3);
    expect(waits).toEqual([2000, 2000]);
    const long = vi.fn(
      async () => new Response(null, { status: 429, headers: { 'retry-after': '3600' } }),
    );
    await expect(
      fetchSource(source('ecb'), { fetcher: long as typeof fetch, now: () => time }),
    ).rejects.toMatchObject({ message: 'rate_limited', retry_at: '2026-10-03T19:17:00.000Z' });
    expect(long).toHaveBeenCalledTimes(1);
  });
  it('bounds timeouts and attempts', async () => {
    const f = vi.fn(
      (_u: unknown, init?: RequestInit) =>
        new Promise<Response>((_r, reject) =>
          init!.signal!.addEventListener('abort', () => reject(new Error('aborted'))),
        ),
    );
    await expect(
      fetchSource(source('ecb'), {
        fetcher: f as typeof fetch,
        now: () => time,
        timeout_ms: 5,
        sleep: async () => {},
      }),
    ).rejects.toThrow('timeout');
    expect(f).toHaveBeenCalledTimes(3);
  });
  it('rejects oversized, empty and disguised success responses', async () => {
    const s = source('ecb');
    s.max_bytes = 10;
    await expect(
      fetchSource(s, { now: () => time, fetcher: responder('longer-than-ten', 'application/xml') }),
    ).rejects.toThrow('response_too_large');
    await expect(
      fetchSource(s, { now: () => time, fetcher: responder('', 'application/xml') }),
    ).rejects.toThrow('empty_response');
    await expect(
      fetchSource(s, { now: () => time, fetcher: responder('<html>error</html>', 'text/html') }),
    ).rejects.toThrow('unexpected_content_type');
  });

  it('times out a stalled response body even if headers arrived successfully', async () => {
    const fetcher = vi.fn(
      (async () =>
        new Response(new ReadableStream<Uint8Array>({ start() {} }), {
          headers: { 'content-type': 'application/xml' },
        })) as typeof fetch,
    );
    await expect(
      fetchSource(source('ecb'), {
        fetcher,
        now: () => time,
        timeout_ms: 10,
        sleep: async () => {},
        random: () => 0,
      }),
    ).rejects.toThrow('timeout');
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});
