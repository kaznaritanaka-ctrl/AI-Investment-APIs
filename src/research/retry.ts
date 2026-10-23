import { plusDays } from './retention';

export function gpuRetryAt(at: string, code: string, attempts: number): string {
  const retry = new Date(Date.parse(at) + 45 * 60000).toISOString();
  return ['timeout', 'network_error'].includes(code) &&
    attempts < 3 &&
    retry.slice(0, 10) === at.slice(0, 10)
    ? retry
    : plusDays(at, 1);
}
