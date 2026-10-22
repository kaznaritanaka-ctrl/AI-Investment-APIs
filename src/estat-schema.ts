import { z } from 'zod';
export const ESTAT_API = 'https://api.e-stat.go.jp/rest/3.0/app/json/';
export const ESTAT_CREDIT =
  'このサービスは、政府統計総合窓口(e-Stat)のAPI機能を使用していますが、サービスの内容は国によって保証されたものではありません。';
export const EstatConfigSchema = z
  .object({
    owner_approval_ref: z.string().min(1),
    stats_code: z.enum(['00550200', '00550300']),
    release_kind: z.enum(['annual', 'iip_monthly']),
    table_groups: z.array(z.string().min(1)).min(1).max(4),
    months_utc: z.array(z.number().int().min(1).max(12)).min(1).max(12),
    day_utc: z.literal(1),
    max_list_pages: z.number().int().min(1).max(4),
    max_data_pages: z.number().int().min(1).max(5),
    page_size: z.number().int().min(1).max(10000),
    normalized_days: z.number().int().positive().max(3650),
    // New code systems are never joined automatically, including the 2026 redesign.
    reviewed_schema_signatures: z.array(z.string().regex(/^[0-9a-f]{64}$/)).max(16),
  })
  .strict();
