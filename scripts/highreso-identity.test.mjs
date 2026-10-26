import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
const result = await build({
  entryPoints: ['src/research/highreso-identity.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
});
const { highresoKeys, highresoOS } = await import(
  'data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64')
);
const record = (instance, amount = '123', osUnit = 'node_hour') => ({
  record_key: 'old:' + instance,
  offer: {
    reported_product: 'Artificial A100 80GB',
    gpu_count: 1,
    unit: osUnit,
    amount_decimal: amount,
  },
  instance_id: instance,
  storage_gb: '500',
  identity: { vram_gb: '80' },
});
test('uses the specified content hash and excludes price and instance names', async () => {
  const a = record('fake-ubs22-a'),
    b = record('renamed-ubs22-b', '999');
  const expected = createHash('sha256')
    .update(
      '{"gpu_count":1,"os_family":"ubs22","reported_product":"Artificial A100 80GB","storage_gb":"500","unit":"node_hour","vram":"80"}',
    )
    .digest('hex');
  assert.equal((await highresoKeys([a])).get(a), `hr:v2:${expected}:1`);
  assert.equal((await highresoKeys([b])).get(b), `hr:v2:${expected}:1`);
});
test('assigns duplicate occurrences by instance order, retaining hourly/monthly multiplicity', async () => {
  const z = record('fake-ubs22-z'),
    a = record('fake-ubs22-a'),
    month = record('fake-ubs22-a', '456', 'month');
  const keys = await highresoKeys([z, month, a]);
  assert.match(keys.get(a), /:1$/);
  assert.match(keys.get(z), /:2$/);
  assert.notEqual(keys.get(month), keys.get(a));
  const reordered = await highresoKeys([a, z, month]);
  assert.deepEqual([...keys.entries()].sort(), [...reordered.entries()].sort());
  const duplicate = record('fake-ubs22-a');
  await assert.rejects(highresoKeys([a, duplicate]), /duplicate/);
});
test('keeps OS and storage changes separate and rejects unknown/ambiguous OS', async () => {
  const a = record('fake-ubs22-a'),
    b = record('fake-ubs24-a'),
    c = { ...a, storage_gb: '1000' };
  const keys = await highresoKeys([a, b, c]);
  assert.equal(new Set(keys.values()).size, 3);
  assert.equal(highresoOS('fake_ubs24_a'), 'ubs24');
  assert.throws(() => highresoOS('fake-no-os'), /unrecognized/);
  assert.throws(() => highresoOS('fake-ubs22-ubs24-a'), /unrecognized/);
});

test('stages v3 separately, preserving rights, scope, retention and the exact old config hash', async () => {
  const original = JSON.parse(
    readFileSync('config/proposals/research/highreso_public.json', 'utf8'),
  );
  const candidate = JSON.parse(readFileSync('config/proposals/highreso-stable-key.json', 'utf8'));
  const compiled = await build({
    entryPoints: ['src/canonical.ts'],
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
  });
  const { hash, stable } = await import(
    'data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64')
  );
  assert.equal(original.method_version, 'domestic-gpu-html-v2');
  assert.equal(candidate.method_version, 'domestic-gpu-html-v3');
  assert.equal(candidate.history_access.at(-1).config_hash, await hash(stable(original)));
  const copy = structuredClone(candidate);
  copy.method_version = original.method_version;
  copy.history_access = original.history_access;
  copy.wire_contract_review_ref = original.wire_contract_review_ref;
  copy.source.policy.version = original.source.policy.version;
  assert.deepEqual(copy, original);
});
