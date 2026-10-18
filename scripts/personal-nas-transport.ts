import { createHash, createHmac } from 'node:crypto';
import { cloudSource } from '../src/research/personal-cloud';
import { z } from 'zod';
import { NasReceipt } from '../src/research/daily-protocol';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const hmac = (key: string | Buffer, value: string) =>
  createHmac('sha256', key).update(value).digest();
const encode = (value: string) =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  );
export type NasReader = { get(key: string): Promise<Uint8Array | null> };
export class NasReadError extends Error {
  constructor(
    readonly code: string,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(code);
  }
}
export function personalObjectKey(key: string) {
  if (
    /^personal-daily\/(highreso_public|rebro_public)\/(catalog\.json|revoked\.json|catalog\/\d+\.json|authority\/[a-f0-9]{64}\.json|deleted\/[a-f0-9]{64}\.json|runs\/[a-f0-9]{64}\.json|exports\/[a-f0-9]{64}\/\d{4}-\d{2}-\d{2}\/part-[0-3]\.json)$/.test(
      key,
    )
  )
    return true;
  const native = key.match(
    /^personal-research\/control\/(highreso_public|rebro_public)\/research-control\/(.+)$/,
  );
  if (native) {
    const s = native[1],
      tail = native[2];
    return (
      tail === 'revocations/' + s + '.json' ||
      new RegExp('^deletions/' + s + '/[a-f0-9]{64}\\.json$').test(tail) ||
      new RegExp('^personal-heads/' + s + '/[a-z0-9][a-z0-9_-]{0,79}\\.json$').test(tail) ||
      new RegExp(
        '^personal-(?:reviews|backups)/' + s + '/[a-z0-9][a-z0-9_-]{0,79}/[a-f0-9]{64}\\.json$',
      ).test(tail)
    );
  }
  return (
    /^personal-research\/control\/(highreso_public|rebro_public)\/current\.json$/.test(key) ||
    /^personal-research\/backups\/(highreso_public|rebro_public)\/[a-f0-9]{64}\/\d{4}-\d{2}-\d{2}\/(manifest\.json|part-[0-3]\.json)$/.test(
      key,
    )
  );
}

// A SEPARATE health bucket/credential. No write capability for the data reader.
export function createNasReceiptWriter(
  config: { account_id: string; bucket: string; source_id: string; allow_network: boolean },
  credentials: { accessKeyId: string; secretAccessKey: string },
  fetcher: typeof fetch = fetch,
) {
  if (!/^[a-f0-9]{32}$/.test(config.account_id) || !/^[a-z0-9][a-z0-9-]{2,62}$/.test(config.bucket))
    throw new Error('nas_receipt_scope');
  cloudSource.parse(config.source_id);
  return async (envelope: unknown) => {
    if (!config.allow_network) throw new Error('nas_network_opt_in_required');
    const projected = z
      .object({
        receipt: NasReceipt,
        signature: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict()
      .parse(envelope);
    if (projected.receipt.source_id !== config.source_id) throw new Error('nas_receipt_scope');
    const body = JSON.stringify(projected);
    if (new TextEncoder().encode(body).length > 8192) throw new Error('nas_receipt_size');
    const host = config.account_id + '.r2.cloudflarestorage.com',
      path = '/' + config.bucket + '/daily/receipts/' + config.source_id + '.json';
    const stamp = new Date().toISOString().replace(/[:-]|\.\d{3}/g, ''),
      day = stamp.slice(0, 8),
      scope = day + '/auto/s3/aws4_request',
      names = 'host;x-amz-content-sha256;x-amz-date',
      digest = sha(body);
    const canonical =
      'PUT\n' +
      path +
      '\n\nhost:' +
      host +
      '\nx-amz-content-sha256:' +
      digest +
      '\nx-amz-date:' +
      stamp +
      '\n\n' +
      names +
      '\n' +
      digest;
    const signing = hmac(
      hmac(hmac(hmac('AWS4' + credentials.secretAccessKey, day), 'auto'), 's3'),
      'aws4_request',
    );
    const signature = createHmac('sha256', signing)
      .update('AWS4-HMAC-SHA256\n' + stamp + '\n' + scope + '\n' + sha(canonical))
      .digest('hex');
    try {
      const response = await fetcher('https://' + host + path, {
        method: 'PUT',
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
        body,
        headers: {
          'x-amz-date': stamp,
          'x-amz-content-sha256': digest,
          authorization:
            'AWS4-HMAC-SHA256 Credential=' +
            credentials.accessKeyId +
            '/' +
            scope +
            ', SignedHeaders=' +
            names +
            ', Signature=' +
            signature,
        },
      });
      await response.body?.cancel();
      if (!response.ok) throw new Error('nas_receipt_failed');
    } catch {
      throw new Error('nas_receipt_failed');
    }
  };
}
export function createPersonalR2Reader(
  config: { account_id: string; bucket: string; source_id: string; allow_network: boolean },
  credentials: { accessKeyId: string; secretAccessKey: string },
  fetcher: typeof fetch = fetch,
): NasReader {
  if (!/^[a-f0-9]{32}$/.test(config.account_id) || !/^[a-z0-9][a-z0-9-]{2,62}$/.test(config.bucket))
    throw new Error('nas_r2_scope_invalid');
  cloudSource.parse(config.source_id);
  const host = config.account_id + '.r2.cloudflarestorage.com';
  return {
    async get(key) {
      if (!config.allow_network) throw new NasReadError('nas_network_opt_in_required');
      if (!personalObjectKey(key) || !key.includes('/' + config.source_id + '/'))
        throw new NasReadError('nas_key_forbidden');
      const path = '/' + config.bucket + '/' + key.split('/').map(encode).join('/');
      const timestamp = new Date().toISOString().replace(/[:-]|\.\d{3}/g, ''),
        day = timestamp.slice(0, 8),
        empty = sha('');
      const scope = day + '/auto/s3/aws4_request',
        names = 'host;x-amz-content-sha256;x-amz-date';
      const canonical =
        'GET\n' +
        path +
        '\n\nhost:' +
        host +
        '\nx-amz-content-sha256:' +
        empty +
        '\nx-amz-date:' +
        timestamp +
        '\n\n' +
        names +
        '\n' +
        empty;
      const signing = hmac(
        hmac(hmac(hmac('AWS4' + credentials.secretAccessKey, day), 'auto'), 's3'),
        'aws4_request',
      );
      const signature = createHmac('sha256', signing)
        .update('AWS4-HMAC-SHA256\n' + timestamp + '\n' + scope + '\n' + sha(canonical))
        .digest('hex');
      try {
        const response = await fetcher('https://' + host + path, {
          method: 'GET',
          redirect: 'error',
          signal: AbortSignal.timeout(15000),
          headers: {
            'x-amz-date': timestamp,
            'x-amz-content-sha256': empty,
            authorization:
              'AWS4-HMAC-SHA256 Credential=' +
              credentials.accessKeyId +
              '/' +
              scope +
              ', SignedHeaders=' +
              names +
              ', Signature=' +
              signature,
          },
        });
        if (response.status === 404) {
          await response.body?.cancel();
          return null;
        }
        if (!response.ok) {
          const retry = response.headers.get('retry-after'),
            seconds = retry
              ? /^\d+$/.test(retry)
                ? Number(retry)
                : Math.ceil((Date.parse(retry) - Date.now()) / 1000)
              : null;
          await response.body?.cancel();
          throw new NasReadError(
            response.status === 429
              ? 'nas_rate_limited'
              : response.status === 401 || response.status === 403
                ? 'nas_auth_failed'
                : 'nas_r2_unavailable',
            seconds !== null && Number.isFinite(seconds) ? Math.max(1, seconds) : null,
          );
        }
        const reader = response.body?.getReader();
        if (!reader) throw new NasReadError('nas_empty_response');
        const parts: Uint8Array[] = [];
        let size = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > 131072) throw new NasReadError('nas_response_too_large');
            parts.push(value);
          }
        } finally {
          await reader.cancel();
        }
        const result = new Uint8Array(size);
        let offset = 0;
        for (const p of parts) {
          result.set(p, offset);
          offset += p.length;
        }
        return result;
      } catch (e) {
        if (e instanceof NasReadError) throw e;
        throw new NasReadError('nas_r2_unavailable');
      }
    },
  };
}
