import { expect, it, vi } from 'vitest';
import api, { type APIEnv } from '../src/api';
import { recordUsage, routeTemplate, statusClass } from '../src/usage';
import openapi from '../openapi.json';

const db = {} as D1Database;
function binding() {
  const writeDataPoint = vi.fn();
  return { writeDataPoint, USAGE: { writeDataPoint } as unknown as AnalyticsEngineDataset };
}
function context() {
  const tasks: Promise<unknown>[] = [];
  return {
    tasks,
    ctx: { waitUntil: (task: Promise<unknown>) => tasks.push(task) } as unknown as ExecutionContext,
  };
}

it('maps every OpenAPI path to a fixed template and collapses ID segments', () => {
  for (const path of Object.keys(openapi.paths)) {
    expect(routeTemplate(path.replace('{id}', 'synthetic-id'))).toBe(path.replace('{id}', ':id'));
  }
  for (const id of ['first-id', 'second_id']) {
    expect(routeTemplate(`/v1/supply-chain/series/${id}/observations`)).toBe(
      '/v1/supply-chain/series/:id/observations',
    );
    expect(routeTemplate(`/v1/methodology/${id}`)).toBe('/v1/methodology/:id');
  }
  for (const path of [
    '/secret-probe',
    '/v1/models/unknown',
    '/v1/gpu/probe/catalog',
    '/v1/methodology/a/b',
  ])
    expect(routeTemplate(path)).toBe('other');
});

it.each([
  [200, '2xx'],
  [204, '2xx'],
  [301, '3xx'],
  [304, '3xx'],
  [400, '4xx'],
  [404, '4xx'],
  [429, '429'],
  [500, '5xx'],
  [503, '5xx'],
])('classifies status %i as %s', (status, expected) => {
  expect(statusClass(status)).toBe(expected);
});

it.each(['JP', 'T1', undefined, 'invalid-country'])(
  'records only safe fields (country %s)',
  (country) => {
    const { USAGE, writeDataPoint } = binding();
    for (const path of ['/v1/methodology/private-id', '/probing-private-path']) {
      const request = new Request(`https://api.test${path}?secret=query-secret`, {
        headers: { 'CF-Connecting-IP': '192.0.2.123', 'User-Agent': 'private-user-agent' },
      });
      Object.defineProperty(request, 'cf', { value: { country, colo: 'NRT' } });
      recordUsage({ USAGE }, request, new Response('private-body'), performance.now() - 10);
      const point = writeDataPoint.mock.calls.at(-1)![0];
      expect(point).toEqual({
        indexes: [path.includes('methodology') ? '/v1/methodology/:id' : 'other'],
        blobs: [
          path.includes('methodology') ? '/v1/methodology/:id' : 'other',
          country === 'JP' || country === 'T1' ? country : 'XX',
          '2xx',
          'GET',
          'none',
          '',
        ],
        doubles: [1, 200, expect.any(Number)],
      });
      expect(point.doubles[2]).toBeGreaterThanOrEqual(10);
      for (const secret of [
        '192.0.2.123',
        'query-secret',
        'private-user-agent',
        'private-id',
        'probing-private-path',
        'NRT',
        'private-body',
      ])
        expect(JSON.stringify(point)).not.toContain(secret);
    }
  },
);

it('is a no-op without a binding, without even reading the request', () => {
  const request = new Proxy({} as Request, {
    get() {
      throw new Error('must not read');
    },
  });
  expect(() => recordUsage({}, request, new Response(), 0)).not.toThrow();
});

it('records limiter 429 and 503 responses through the outer wrapper', async () => {
  for (const status of [429, 503]) {
    const { USAGE, writeDataPoint } = binding();
    const { ctx, tasks } = context();
    const env: APIEnv = {
      PUBLIC_DB: db,
      USAGE,
      ENVIRONMENT: 'production',
      ...(status === 429 ? { RATE_LIMITER: { limit: async () => ({ success: false }) } } : {}),
    };
    const response = await api.fetch(
      new Request('https://api.test/openapi.json', {
        headers: { 'CF-Connecting-IP': '192.0.2.1' },
      }),
      env,
      ctx,
    );
    expect(response.status).toBe(status);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    if (status === 429) expect(response.headers.get('Retry-After')).toBe('60');
    expect(tasks).toHaveLength(1);
    await Promise.all(tasks);
    expect(writeDataPoint).toHaveBeenCalledTimes(1);
    expect(writeDataPoint.mock.calls[0][0].blobs[2]).toBe(status === 429 ? '429' : '5xx');
  }
});

it('preserves responses and HEAD semantics when writeDataPoint throws', async () => {
  const { USAGE, writeDataPoint } = binding();
  writeDataPoint.mockImplementation(() => {
    throw new Error('write failed');
  });
  for (const method of ['GET', 'HEAD']) {
    const { ctx, tasks } = context();
    const response = await api.fetch(
      new Request('https://api.test/llms.txt', { method }),
      { PUBLIC_DB: db, USAGE },
      ctx,
    );
    await expect(Promise.all(tasks)).resolves.toBeDefined();
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(await response.text()).toEqual(
      method === 'HEAD' ? '' : expect.stringContaining('AI-Investment-APIs'),
    );
  }
});

it('preserves the response when waitUntil scheduling throws', async () => {
  const ctx = {
    waitUntil() {
      throw new Error('schedule failed');
    },
  } as unknown as ExecutionContext;
  expect(
    (await api.fetch(new Request('https://api.test/llms.txt'), { PUBLIC_DB: db }, ctx)).status,
  ).toBe(200);
});
