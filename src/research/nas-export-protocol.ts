import { z } from 'zod';
import { hash, stable } from '../util';

const bucket = z.string().regex(/^[a-z0-9][a-z0-9-]{2,62}$/);
export const NasExportBinding = z
  .object({
    version: z.literal('personal-nas-export-v1'),
    account_id: z.string().regex(/^[a-f0-9]{32}$/),
    private_database_id: z.uuid(),
    origin_bucket: bucket,
    export_bucket: bucket,
    health_bucket: bucket.nullable(),
    isolation_review_ref: z.string().trim().min(1).max(500),
  })
  .strict()
  .refine(
    (v) => new Set([v.origin_bucket, v.export_bucket, v.health_bucket]).size === 3,
    'nas_distinct_buckets_required',
  );
export type NasExportPin = z.infer<typeof NasExportBinding>;
export const exportSource = z.enum(['highreso_public', 'rebro_public']);
export const exportKind = z.enum(['initial', 'daily']);
export type ExportKind = z.infer<typeof exportKind>;
export const exportGateKey = (source: string, kind: ExportKind) =>
  'nas-export/' + exportKind.parse(kind) + '/' + exportSource.parse(source) + '/current.json';
export const NasExportGate = z
  .object({
    version: z.literal(1),
    generation: z.uuid(),
    transport_hash: z.string().regex(/^[a-f0-9]{64}$/),
    source_id: exportSource,
    kind: exportKind,
    checked_at: z.iso.datetime(),
    ready: z.boolean(),
  })
  .strict();

// This allowlist reduces accidental access. Bucket-scoped IAM is a separate release gate.
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

export async function checkExportGate(
  input: unknown,
  pin: NasExportPin,
  source: string,
  kind: ExportKind,
  at: string,
) {
  const gate = NasExportGate.parse(input);
  if (
    !gate.ready ||
    gate.source_id !== source ||
    gate.kind !== kind ||
    gate.transport_hash !== (await hash(stable(NasExportBinding.parse(pin)))) ||
    gate.checked_at > at ||
    Date.parse(at) - Date.parse(gate.checked_at) >= 48 * 3600000
  )
    throw new Error('nas_export_control_unavailable');
  return gate;
}
