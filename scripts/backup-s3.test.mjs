import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signS3Get, parseS3List, R2ReadOnlyClient } from './backup-s3.mjs';
import { CloudflareBackupClient, reviewHashes } from './backup-capture.mjs';

const NOW = Date.parse('2026-10-11T00:30:00.000Z');
const config = {
  schema_version: 'nas-capture-v2',
  r2_api: 's3',
  account_id: 'a'.repeat(32),
  bucket: 'synthetic-only',
  window_start: new Date(NOW - 1000).toISOString(),
  window_end: new Date(NOW + 60000).toISOString(),
};
const credentials = { access_key_id: 'b'.repeat(32), secret_access_key: 'c'.repeat(64) };
const xml = (key = 'evidence%2Fecb%2Fsynthetic.json', truncated = false) =>
  '<?xml version="1.0"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' +
  '<Name>synthetic-only</Name><EncodingType>url</EncodingType><KeyCount>1</KeyCount>' +
  '<IsTruncated>' +
  truncated +
  '</IsTruncated>' +
  (truncated ? '<NextContinuationToken>cursor+with/slash=</NextContinuationToken>' : '') +
  '<Contents><Key>' +
  key +
  '</Key><LastModified>2026-10-11T00:00:00.000Z</LastModified>' +
  '<ETag>&quot;abcdef1234&quot;</ETag><Size>42</Size></Contents></ListBucketResult>';

test('SigV4 matches the official AWS GET reference vector exactly', () => {
  // Public dummy credentials and expected signature from the AWS documentation.
  const result = signS3Get({
    host: 'examplebucket.s3.amazonaws.com',
    path: '/test.txt',
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    now: Date.parse('2013-05-24T00:00:00Z'),
    region: 'us-east-1',
    extraHeaders: { range: 'bytes=0-9' },
  });
  assert.ok(
    result.headers.Authorization.endsWith(
      'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    ),
  );
});

test('fixed bucket LIST and allowlisted GET only, no bearer or redirects; cursors are encoded once', async () => {
  const requests = [];
  const client = new R2ReadOnlyClient(config, credentials, {
    now: () => NOW,
    fetcher: async (url, options) => {
      requests.push({ url, options });
      return new Response(url.includes('?') ? xml() : '{}');
    },
  });
  await client.objects('cursor+with/slash=');
  await client.object('archive/models_dev/synthetic.json');
  assert.equal(requests.length, 2);
  assert.ok(requests[0].url.includes('continuation-token=cursor%2Bwith%2Fslash%3D'));
  for (const r of requests) {
    assert.equal(new URL(r.url).hostname, 'a'.repeat(32) + '.r2.cloudflarestorage.com');
    assert.ok(new URL(r.url).pathname.startsWith('/synthetic-only'));
    assert.equal(r.options.method, 'GET');
    assert.equal(r.options.redirect, 'error');
    assert.ok(r.options.headers.Authorization.startsWith('AWS4-HMAC-SHA256 '));
    assert.ok(!JSON.stringify(r).includes(credentials.secret_access_key));
  }
  for (const key of [
    'evidence/ecb/../secret.json',
    'evidence/lambda/raw.json',
    'https://other.example/raw',
    'secrets/token',
  ])
    await assert.rejects(() => client.object(key), /not_allowed/);
  assert.equal(requests.length, 2);
});

test('S3 list parser rejects malicious XML, new sources, mismatched bucket, array/field/count drift', () => {
  assert.equal(parseS3List(xml(), config.bucket).objects[0].key, 'evidence/ecb/synthetic.json');
  assert.equal(parseS3List(xml(undefined, true), config.bucket).cursor, 'cursor+with/slash=');
  for (const value of [
    xml('evidence%2Flambda%2Fx.json'),
    xml('evidence%2Fecb%2F..%2Fx.json'),
    '<!DOCTYPE x [<!ENTITY raw SYSTEM "file:///secret">]>' + xml(),
    xml().replace('synthetic-only', 'different-bucket'),
    xml().replace('<KeyCount>1', '<KeyCount>2'),
    xml().replace('<Size>42', '<Size>NaN'),
    xml().replace('</Contents>', '</Contents><Contents>drift</Contents>'),
    xml().replace('<IsTruncated>false', '<IsTruncated>unknown'),
  ])
    assert.throws(() => parseS3List(value, config.bucket), /contract/);
});

test('S3 authorization, HTTP failure, oversized body and expired approval are separate failures', async () => {
  for (const status of [403, 429, 500]) {
    const c = new R2ReadOnlyClient(config, credentials, {
      now: () => NOW,
      fetcher: async () => new Response('SECRET_UNTRUSTED_BODY', { status }),
    });
    await assert.rejects(
      () => c.objects(),
      status === 403 ? /authentication_failed/ : /request_failed/,
    );
  }
  let requests = 0;
  const c = new R2ReadOnlyClient(config, credentials, {
    now: () => NOW + 60001,
    fetcher: async () => {
      requests++;
      return new Response(xml());
    },
  });
  await assert.rejects(() => c.objects(), /approval_window/);
  assert.equal(requests, 0);
  const huge = new R2ReadOnlyClient(config, credentials, {
    now: () => NOW,
    fetcher: async () => new Response('x'.repeat(8 * 1024 * 1024 + 1)),
  });
  await assert.rejects(() => huge.objects(), /list_limit/);
});

test('v2 Cloudflare client cannot silently fall back to account-wide R2 REST credentials', async () => {
  const c = {
    ...config,
    approval_ref: 'synthetic',
    max_total_bytes: 1000,
    max_file_bytes: 1000,
    private_database_id: '11111111-1111-1111-1111-111111111111',
    public_database_id: '22222222-2222-2222-2222-222222222222',
    export_hosts: ['synthetic.r2.cloudflarestorage.com'],
    ...reviewHashes([{ source_id: 'ecb' }, { source_id: 'models_dev' }], {
      private: [],
      public: [],
    }),
  };
  let requests = 0;
  const client = new CloudflareBackupClient(c, 'synthetic_bearer_token_12345678', {
    now: () => NOW,
    fetcher: async () => {
      requests++;
      return Response.json({});
    },
  });
  await assert.rejects(() => client.objects(), /scoped_client_required/);
  await assert.rejects(() => client.object('evidence/ecb/a.json'), /scoped_client_required/);
  assert.equal(requests, 0);
});
