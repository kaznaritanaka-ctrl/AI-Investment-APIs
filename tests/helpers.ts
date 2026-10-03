import { URL as NodeURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { sources } from '../src/sources';
import legacyModels from '../config/history/models_dev.v2.json';
import { SourceSchema, type Source } from '../src/schema';
export const time = '2026-10-03T18:17:00.000Z';
export const fixture = (name: string) =>
  readFileSync(new NodeURL('./fixtures/' + name, import.meta.url), 'utf8');
export const source = (id: string): Source =>
  structuredClone(
    id === 'models_dev'
      ? SourceSchema.parse(legacyModels)
      : sources.find((s) => s.source_id === id)!,
  );
export function modelSource() {
  const s = source('models_dev');
  s.selection = ['lab/model-a'];
  s.max_records = 4;
  return s;
}
export function responder(body: string, type = 'application/json', status = 200): typeof fetch {
  return (async () =>
    new Response(body, {
      status,
      headers: { 'content-type': type, etag: '"synthetic-etag"' },
    })) as typeof fetch;
}
export const fxFetch = () => responder(fixture('ecb.synthetic.xml'), 'application/xml');
export const aiFetch = () => responder(fixture('models.synthetic.json'));
