import { createHash, createHmac } from 'node:crypto';
import { XMLParser, XMLValidator } from 'fast-xml-parser';

const hash = (v) => createHash('sha256').update(v).digest('hex');
const hmac = (k, v) => createHmac('sha256', k).update(v).digest();
export class R2ReadError extends Error {}
const fail = (code) => {
  throw new R2ReadError(code);
};
const encode = (v) =>
  encodeURIComponent(v).replace(
    /[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  );
const keyAllowed = (key) =>
  typeof key === 'string' &&
  key.length <= 512 &&
  /^(evidence|archive)\/(ecb|models_dev|price_of_compute)\/[a-zA-Z0-9_./-]+\.json$/.test(key) &&
  !key.split('/').some((p) => !p || p === '.' || p === '..');

// Pure signer. The only network caller below exposes fixed-bucket LIST and GET.
export function signS3Get({
  host,
  path,
  query = [],
  accessKeyId,
  secretAccessKey,
  now,
  region = 'auto',
  extraHeaders = {},
}) {
  const date = new Date(now).toISOString().replace(/[:-]|\.\d{3}/g, '');
  const scope = date.slice(0, 8) + '/' + region + '/s3/aws4_request';
  const queryText = query
    .map(([k, v]) => [encode(k), encode(v)])
    .sort(([ak, av], [bk, bv]) => (ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
    .map(([k, v]) => k + '=' + v)
    .join('&');
  const headers = { host, ...extraHeaders, 'x-amz-content-sha256': hash(''), 'x-amz-date': date };
  const keys = Object.keys(headers).sort();
  const signed = keys.join(';');
  const canonical = [
    'GET',
    path,
    queryText,
    keys.map((k) => k + ':' + headers[k].trim() + '\n').join(''),
    signed,
    hash(''),
  ].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', date, scope, hash(canonical)].join('\n');
  const signingKey = hmac(
    hmac(hmac(hmac('AWS4' + secretAccessKey, date.slice(0, 8)), region), 's3'),
    'aws4_request',
  );
  return {
    queryText,
    headers: {
      ...headers,
      Authorization:
        'AWS4-HMAC-SHA256 Credential=' +
        accessKeyId +
        '/' +
        scope +
        ', SignedHeaders=' +
        signed +
        ', Signature=' +
        hmac(signingKey, toSign).toString('hex'),
    },
  };
}

export function parseS3List(xml, bucket) {
  if (
    typeof xml !== 'string' ||
    Buffer.byteLength(xml) > 8 * 1024 * 1024 ||
    /<!/i.test(xml) ||
    XMLValidator.validate(xml) !== true
  )
    fail('r2_list_contract_invalid');
  let root;
  try {
    root = new XMLParser({
      ignoreAttributes: true,
      parseTagValue: false,
      trimValues: false,
      isArray: (_name, path) => path === 'ListBucketResult.Contents',
    }).parse(xml).ListBucketResult;
  } catch {
    fail('r2_list_contract_invalid');
  }
  const rows = root?.Contents ?? [];
  if (
    root?.Name !== bucket ||
    !['true', 'false'].includes(root.IsTruncated) ||
    root.EncodingType !== 'url' ||
    !Array.isArray(rows) ||
    rows.length > 1000 ||
    !/^\d+$/.test(root.KeyCount ?? '') ||
    Number(root.KeyCount) !== rows.length ||
    (root.IsTruncated === 'true' &&
      (typeof root.NextContinuationToken !== 'string' ||
        !root.NextContinuationToken ||
        root.NextContinuationToken.length > 4096))
  )
    fail('r2_list_contract_invalid');
  const objects = rows.map((r) => {
    let key;
    try {
      key = decodeURIComponent(r.Key);
    } catch {
      fail('r2_list_contract_invalid');
    }
    if (
      !keyAllowed(key) ||
      typeof r.ETag !== 'string' ||
      !/^"[a-fA-F0-9-]{1,80}"$/.test(r.ETag) ||
      !/^\d+$/.test(r.Size ?? '') ||
      !Number.isSafeInteger(Number(r.Size)) ||
      typeof r.LastModified !== 'string' ||
      !Number.isFinite(Date.parse(r.LastModified))
    )
      fail('r2_list_contract_invalid');
    return { key, size: Number(r.Size), etag: r.ETag.slice(1, -1), last_modified: r.LastModified };
  });
  return { objects, truncated: root.IsTruncated === 'true', cursor: root.NextContinuationToken };
}

export class R2ReadOnlyClient {
  #credentials;
  #config;
  #fetcher;
  #now;
  constructor(config, credentials, { fetcher = fetch, now = Date.now } = {}) {
    if (
      !/^[a-f0-9]{32}$/.test(config.account_id ?? '') ||
      !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(config.bucket ?? '') ||
      config.r2_api !== 's3' ||
      config.schema_version !== 'nas-capture-v2' ||
      !/^[a-f0-9]{32}$/.test(credentials?.access_key_id ?? '') ||
      !/^[a-f0-9]{64}$/.test(credentials?.secret_access_key ?? '')
    )
      fail('r2_scoped_credentials_or_config_invalid');
    this.#config = structuredClone(config);
    this.#credentials = { ...credentials };
    this.#fetcher = fetcher;
    this.#now = now;
  }
  async #get(key, query) {
    const c = this.#config,
      now = this.#now();
    const start = Date.parse(c.window_start),
      end = Date.parse(c.window_end);
    if (
      !Number.isFinite(now) ||
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start > now ||
      end <= now ||
      end - start > 3600000
    )
      fail('r2_approval_window_invalid');
    const host = c.account_id + '.r2.cloudflarestorage.com';
    const path = '/' + c.bucket + (key ? '/' + key.split('/').map(encode).join('/') : '');
    const signed = signS3Get({
      host,
      path,
      query,
      now,
      accessKeyId: this.#credentials.access_key_id,
      secretAccessKey: this.#credentials.secret_access_key,
    });
    let response;
    try {
      response = await this.#fetcher(
        'https://' + host + path + (signed.queryText ? '?' + signed.queryText : ''),
        {
          method: 'GET',
          headers: signed.headers,
          redirect: 'error',
          signal: AbortSignal.timeout(Math.min(end - now, key ? 20 * 60000 : 60000)),
        },
      );
    } catch {
      fail('r2_unreachable');
    }
    if (!response.ok)
      fail([401, 403].includes(response.status) ? 'r2_authentication_failed' : 'r2_request_failed');
    return response;
  }
  async objects(cursor) {
    if (cursor !== undefined && (typeof cursor !== 'string' || !cursor || cursor.length > 4096))
      fail('r2_cursor_invalid');
    const response = await this.#get(null, [
      ['list-type', '2'],
      ['max-keys', '1000'],
      ['encoding-type', 'url'],
      ...(cursor ? [['continuation-token', cursor]] : []),
    ]);
    const parts = [];
    let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > 8 * 1024 * 1024) fail('r2_list_limit');
      parts.push(Buffer.from(chunk));
    }
    return parseS3List(Buffer.concat(parts).toString('utf8'), this.#config.bucket);
  }
  async object(key) {
    if (!keyAllowed(key)) fail('r2_key_not_allowed');
    return this.#get(key, []);
  }
}
