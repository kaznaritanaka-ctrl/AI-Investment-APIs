import { expect, it, vi } from 'vitest';
import api from '../src/api';

it('rejects unsupported methods, oversized URLs and throttled requests before any D1 query', async () => {
  const prepare = vi.fn(() => {
    throw new Error('unexpected_database_access');
  });
  const db = { prepare } as unknown as D1Database;
  const blocked = { PUBLIC_DB: db, RATE_LIMITER: { limit: async () => ({ success: false }) } };
  expect(
    (await api.fetch(new Request('https://api.test/v1/latest', { method: 'POST' }), blocked))
      .status,
  ).toBe(405);
  expect(
    (await api.fetch(new Request('https://api.test/v1/latest?source=' + 'x'.repeat(8192)), blocked))
      .status,
  ).toBe(400);
  for (const method of ['GET', 'HEAD']) {
    const response = await api.fetch(
      new Request('https://api.test/v1/latest', { method }),
      blocked,
    );
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('60');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    if (method === 'HEAD') expect(await response.text()).toBe('');
  }
  expect(prepare).not.toHaveBeenCalled();
});
