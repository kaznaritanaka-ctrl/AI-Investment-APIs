import type { NasExportPin } from '../src/research/nas-export-protocol';
export function exportFixture(health: string | null = null): NasExportPin {
  return {
    version: 'personal-nas-export-v1',
    account_id: 'a'.repeat(32),
    private_database_id: '00000000-0000-4000-8000-000000000001',
    origin_bucket: 'synthetic-personal-only',
    export_bucket: 'synthetic-export-only',
    health_bucket: health,
    isolation_review_ref: 'SYNTHETIC ONLY; no live IAM verification',
  };
}
