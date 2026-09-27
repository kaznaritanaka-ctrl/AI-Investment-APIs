import type { Source } from './schema';
import { canCollect } from './policy';
export type Attempt = {
  attempt: number;
  status: number | null;
  code: string;
  started_at: string;
  duration_ms: number;
};
export type NetworkOptions = {
  fetcher?: typeof fetch;
  now?: () => string;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  timeout_ms?: number;
  onAttempt?: (attempt: Attempt) => Promise<void>;
  validators?: { etag: string | null; last_modified: string | null };
};
export class FetchFailure extends Error {
  constructor(
    code: string,
    public retry_at: string | null = null,
  ) {
    super(code);
  }
}
const fixedEndpoints: Record<string, string> = {
  ecb: 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml',
  models_dev: 'https://models.dev/api.json?type=all',
  openrouter: 'https://openrouter.ai/api/v1/models',
};
async function untilAborted<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new FetchFailure('timeout');
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new FetchFailure('timeout'));
    signal.addEventListener('abort', abort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
export async function fetchSource(
  source: Source,
  opt: NetworkOptions = {},
): Promise<{ text: string; status: number; headers: Headers; observed_at: string }> {
  const now = opt.now ?? (() => new Date().toISOString());
  if (!canCollect(source, now())) throw new FetchFailure('policy_blocked');
  if (!source.endpoint || fixedEndpoints[source.adapter] !== source.endpoint)
    throw new FetchFailure('endpoint_not_allowed');
  if (source.authentication_required) throw new FetchFailure('authentication_not_configured');
  const fetcher = opt.fetcher ?? fetch,
    sleep = opt.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  for (let attempt = 1; attempt <= 3; attempt++) {
    const started = now(),
      clock = Date.now(),
      controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opt.timeout_ms ?? 20000);
    let status: number | null = null,
      retryDelay = 0;
    try {
      const headers = new Headers({
        accept: source.adapter === 'ecb' ? 'application/xml' : 'application/json',
      });
      if (opt.validators?.etag) headers.set('If-None-Match', opt.validators.etag);
      if (opt.validators?.last_modified)
        headers.set('If-Modified-Since', opt.validators.last_modified);
      const response = await untilAborted(
        fetcher(source.endpoint, { headers, signal: controller.signal, redirect: 'manual' }),
        controller.signal,
      );
      status = response.status;
      if (status === 304) {
        await opt.onAttempt?.({
          attempt,
          status,
          code: 'revalidated',
          started_at: started,
          duration_ms: Date.now() - clock,
        });
        return { text: '', status, headers: response.headers, observed_at: now() };
      }
      if (status === 429) {
        const h = response.headers.get('retry-after');
        retryDelay = h
          ? /^\d+$/.test(h)
            ? Number(h) * 1000
            : Math.max(0, Date.parse(h) - Date.parse(now()))
          : 1000 * 2 ** (attempt - 1);
        if (!Number.isFinite(retryDelay)) retryDelay = 2000;
        await response.body?.cancel();
        if (retryDelay > 30000)
          throw new FetchFailure(
            'rate_limited',
            new Date(Date.parse(now()) + retryDelay).toISOString(),
          );
        throw new FetchFailure('retryable_429');
      }
      if (status >= 300 && status < 400) {
        await response.body?.cancel();
        throw new FetchFailure('redirect_blocked');
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new FetchFailure(status >= 500 ? 'retryable_5xx' : 'http_' + status);
      }
      const length = Number(response.headers.get('content-length') ?? 0);
      if (length > source.max_bytes) {
        await response.body?.cancel();
        throw new FetchFailure('response_too_large');
      }
      const contentType = response.headers.get('content-type') ?? '';
      if (!(source.adapter === 'ecb' ? /xml/ : /json/).test(contentType)) {
        await response.body?.cancel();
        throw new FetchFailure('unexpected_content_type');
      }
      if (!response.body) throw new FetchFailure('empty_response');
      const reader = response.body.getReader(),
        decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
      let text = '',
        bytes = 0;
      try {
        while (true) {
          const r = await untilAborted(reader.read(), controller.signal);
          if (r.done) break;
          bytes += r.value.byteLength;
          if (bytes > source.max_bytes) throw new FetchFailure('response_too_large');
          text += decoder.decode(r.value, { stream: true });
        }
        text += decoder.decode();
      } finally {
        void reader.cancel().catch(() => {});
      }
      if (!text.trim()) throw new FetchFailure('empty_response');
      await opt.onAttempt?.({
        attempt,
        status,
        code: 'success',
        started_at: started,
        duration_ms: Date.now() - clock,
      });
      return { text, status, headers: response.headers, observed_at: now() };
    } catch (error) {
      const e =
        error instanceof FetchFailure
          ? error
          : new FetchFailure(controller.signal.aborted ? 'timeout' : 'network_error');
      await opt.onAttempt?.({
        attempt,
        status,
        code: e.message,
        started_at: started,
        duration_ms: Date.now() - clock,
      });
      if (
        attempt === 3 ||
        !['retryable_429', 'retryable_5xx', 'timeout', 'network_error'].includes(e.message)
      )
        throw e;
      clearTimeout(timer);
      await sleep(
        Math.max(retryDelay, 500 * 2 ** (attempt - 1)) +
          Math.floor((opt.random ?? Math.random)() * 250),
      );
    } finally {
      clearTimeout(timer);
    }
  }
  throw new FetchFailure('attempts_exhausted');
}
