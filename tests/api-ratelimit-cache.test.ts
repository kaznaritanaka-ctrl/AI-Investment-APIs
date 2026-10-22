import { afterEach, expect, it, vi } from 'vitest';
import { handle, type APIEnv } from '../src/api';

const db = {
  prepare: vi.fn(() => ({
    first: async () => null,
    bind: () => ({ all: async () => ({ results: [] }) }),
  })),
} as unknown as D1Database;
const allow = () => ({ limit: vi.fn(async () => ({ success: true })) });
const request = (path: string, ip = '192.0.2.1', method = 'GET') =>
  new Request('https://api.test' + path, { method, headers: ip ? { 'CF-Connecting-IP': ip } : {} });
afterEach(() => vi.unstubAllGlobals());

it('fails closed for missing or throwing required production limiters', async () => {
  for (const extra of [
    {},
    { RATE_LIMITER: allow() },
    {
      RATE_LIMITER: allow(),
      RATE_LIMITER_HEAVY: {
        limit: async () => {
          throw new Error('private');
        },
      },
    },
  ]) {
    const response = await handle(request('/v1/datasets'), {
      PUBLIC_DB: db,
      ENVIRONMENT: 'production',
      ...extra,
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: { code: 'rate_limiter_unavailable' } });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  }
  expect(
    (await handle(request('/openapi.json'), { PUBLIC_DB: db, ENVIRONMENT: 'test' })).status,
  ).toBe(200);
});
it('uses both buckets on heavy routes and a defensive heavy bucket without an IP', async () => {
  const general = allow();
  const heavy = { limit: vi.fn(async () => ({ success: false })) };
  const env = { PUBLIC_DB: db, RATE_LIMITER: general, RATE_LIMITER_HEAVY: heavy };
  expect((await handle(request('/openapi.json'), env)).status).toBe(200);
  expect(heavy.limit).not.toHaveBeenCalled();
  expect((await handle(request('/v1/datasets'), env)).status).toBe(429);
  expect(general.limit).toHaveBeenCalledTimes(2);
  expect((await handle(request('/openapi.json', ''), env)).status).toBe(429);
  expect(heavy.limit).toHaveBeenLastCalledWith({ key: 'noip' });
});
it('groups expanded, compressed and IPv4-mapped IPv6 addresses by /64', async () => {
  const general = allow();
  const env = { PUBLIC_DB: db, RATE_LIMITER: general };
  for (const ip of ['2001:0db8:0001:0002:0000:0000:0000:0001', '2001:db8:1:2::abcd']) {
    await handle(request('/openapi.json', ip), env);
    expect(general.limit).toHaveBeenLastCalledWith({ key: '2001:db8:1:2::/64' });
  }
  await handle(request('/openapi.json', '::ffff:192.0.2.1'), env);
  expect(general.limit).toHaveBeenLastCalledWith({ key: '0:0:0:0::/64' });
});
it('caches full GET URLs after limiting, skips HEAD and never caches errors', async () => {
  const entries = new Map<string, Response>();
  const match = vi.fn(async (key: Request) => entries.get(key.url)?.clone());
  const put = vi.fn(async (key: Request, response: Response) => {
    entries.set(key.url, response.clone());
  });
  vi.stubGlobal('caches', { default: { match, put } });
  const general = allow();
  const env: APIEnv = { PUBLIC_DB: db, RATE_LIMITER: general, RATE_LIMITER_HEAVY: allow() };
  for (const path of ['/openapi.json', '/llms.txt', '/v1/methodology/licenses']) {
    expect((await handle(request(path), env)).headers.get('Cache-Control')).toBe(
      'public, max-age=3600',
    );
  }
  expect((await handle(request('/v1/datasets'), env)).headers.get('Cache-Control')).toBe(
    'public, max-age=300',
  );
  const calls = put.mock.calls.length;
  await handle(request('/v1/datasets'), env);
  expect(put).toHaveBeenCalledTimes(calls);
  expect(general.limit).toHaveBeenCalledTimes(5);
  await handle(request('/v1/datasets?a=1'), env);
  expect(put).toHaveBeenCalledTimes(calls);
  await handle(request('/openapi.json', '192.0.2.1', 'HEAD'), env);
  expect(put).toHaveBeenCalledTimes(calls);
  general.limit.mockResolvedValue({ success: false });
  const response = await handle(request('/openapi.json'), env);
  expect(response.status).toBe(429);
  expect(response.headers.get('Retry-After')).toBe('60');
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(put).toHaveBeenCalledTimes(calls);
});

it('keeps health no-store externally while reusing a 60 second internal entry', async () => {
  let entry: Response | undefined;
  const put = vi.fn(async (_key: Request, response: Response) => {
    entry = response.clone();
  });
  vi.stubGlobal('caches', { default: { match: async () => entry?.clone(), put } });
  const env = { PUBLIC_DB: db };
  for (let i = 0; i < 2; i++) {
    const response = await handle(request('/health'), env);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  }
  expect(put).toHaveBeenCalledTimes(1);
  expect(entry?.headers.get('Cache-Control')).toBe('public, max-age=60');
});

it('applies the heavy limiter to every data family and preserves supply-chain error credit', async () => {
  const env = {
    PUBLIC_DB: db,
    RATE_LIMITER: allow(),
    RATE_LIMITER_HEAVY: { limit: async () => ({ success: false }) },
  };
  for (const path of [
    '/health',
    '/v1/datasets',
    '/v1/sources',
    '/v1/fx',
    '/v1/gpu/prices',
    '/v1/models/catalog',
    '/v1/supply-chain',
    '/v1/supply-chain/series',
  ]) {
    const response = await handle(request(path), env);
    expect(response.status).toBe(429);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    if (path.startsWith('/v1/supply-chain'))
      expect(await response.json()).toHaveProperty('api_credit');
  }
  const response = await handle(request('/v1/supply-chain/series'), {
    PUBLIC_DB: db,
    ENVIRONMENT: 'production',
  });
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({
    error: { code: 'rate_limiter_unavailable' },
    api_credit: expect.any(String),
  });
});
