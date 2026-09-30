import { expect, it } from 'vitest';
import { evidenceFromBody } from '../src/adapters';
import { modelEvidence, projectModelCatalog } from '../src/models';
import { hash, hashBytes } from '../src/util';
import { source, time } from './helpers';
import { catalog, expandedSource } from './models-helpers';

it('reuses UTF-8 bytes without changing payload digests, size limits or retained fields', async () => {
  const s = expandedSource();
  const body = catalog();
  body.unselected = '日本語🙂';
  const text = JSON.stringify(body),
    bytes = new TextEncoder().encode(text);
  const e = await modelEvidence(s, text, time, true);
  expect(e.payload_hash).toBe(await hash(text));
  expect(e.payload_hash).toBe(await hashBytes(bytes));
  expect(e.bytes).toBe(bytes.byteLength);
  expect(e.bytes).toBeGreaterThan(text.length);
  expect(e.body).not.toContain('日本語');
  s.max_bytes = bytes.byteLength - 1;
  await expect(modelEvidence(s, text, time, true)).rejects.toThrow('response_too_large');
  await expect(projectModelCatalog(text, s)).rejects.toThrow('response_too_large');
  const legacy = await evidenceFromBody(source('models_dev'), text, time, 200, new Headers(), true);
  expect(legacy.payload_hash).toBe(e.payload_hash);
  expect(legacy.bytes).toBe(e.bytes);
});
it('keeps the legacy duplicate-key rejection and exact decimal projection', async () => {
  const s = source('models_dev');
  s.selection = ['mistral/synthetic'];
  const text =
    '{"mistral":{"models":{"synthetic":{"cost":{"input":0.123456789012345678901,"output":0},"limit":{"context":9007199254740993}}}}}';
  const e = await evidenceFromBody(s, text, time, 200, new Headers(), true);
  expect(e.body).toContain('0.123456789012345678901');
  expect(e.body).toContain('9007199254740993');
  expect(e.body).toContain('"output":"0"');
  await expect(evidenceFromBody(s, '{"mistral":{},"mistral":{}}', time)).rejects.toThrow();
});
