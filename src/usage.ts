import type { APIEnv } from './api';

// Fixed router/OpenAPI allowlist; never emit any caller-supplied path segment.
const routes = new Set([
  '/health',
  '/openapi.json',
  '/llms.txt',
  '/v1/datasets',
  '/v1/sources',
  '/v1/observations',
  '/v1/latest',
  '/v1/changes',
  '/v1/fx',
  '/v1/models/coverage',
  '/v1/models/events',
  '/v1/gpu/coverage',
  '/v1/gpu/metrics',
  '/v1/gpu/comparisons',
  '/v1/gpu/catalog',
  '/v1/supply-chain/series',
]);
const INCLUDE_COLO = false;

export function routeTemplate(pathname: string): string {
  if (routes.has(pathname)) return pathname;
  if (/^\/v1\/methodology\/[^/]+$/.test(pathname)) return '/v1/methodology/:id';
  const series =
    /^\/v1\/supply-chain\/series\/[A-Za-z0-9_-]{1,160}\/(observations|revisions)$/.exec(pathname);
  if (series) return `/v1/supply-chain/series/:id/${series[1]}`;
  return 'other';
}

export function statusClass(status: number): string {
  if (status === 429) return '429';
  if (status >= 500) return '5xx';
  if (status >= 400) return '4xx';
  if (status >= 300) return '3xx';
  return '2xx';
}

export function recordUsage(
  env: Pick<APIEnv, 'USAGE'>,
  request: Request,
  response: Response,
  startedAt: number,
): void {
  try {
    if (!env.USAGE) return;
    const template = routeTemplate(new URL(request.url).pathname);
    const rawCountry = request.cf?.country;
    const country =
      typeof rawCountry === 'string' && /^(?:[A-Z]{2}|T1)$/.test(rawCountry) ? rawCountry : 'XX';
    const method = [
      'GET',
      'HEAD',
      'POST',
      'PUT',
      'PATCH',
      'DELETE',
      'OPTIONS',
      'CONNECT',
      'TRACE',
    ].includes(request.method)
      ? request.method
      : 'other';
    const colo = INCLUDE_COLO && typeof request.cf?.colo === 'string' ? request.cf.colo : '';
    env.USAGE.writeDataPoint({
      indexes: [template],
      blobs: [template, country, statusClass(response.status), method, 'none', colo],
      doubles: [1, response.status, Math.max(0, performance.now() - startedAt)],
    });
  } catch {
    // Best effort only: never log request data or change API behavior on failure.
  }
}
