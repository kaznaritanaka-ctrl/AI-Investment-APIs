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
    // A list follows table_groups order; a map must name every group exactly once.
    search_words: z
      .union([
        z.array(z.string().trim().min(1).max(200)).min(1).max(4),
        z.record(z.string(), z.string().trim().min(1).max(200)),
      ])
      .optional(),
    implied_measures: z
      .record(
        z.string(),
        z.enum([
          'production_qty',
          'production_value',
          'sales_qty',
          'sales_value',
          'shipments_qty',
          'shipments_value',
          'inventory',
          'inventory_index_sa',
          'inventory_ratio_index_sa',
        ]),
      )
      .optional(),
    item_codes: z
      .array(z.string().regex(/^\d{1,12}$/))
      .min(1)
      .max(50)
      .optional(),
    months_utc: z.array(z.number().int().min(1).max(12)).min(1).max(12),
    day_utc: z.literal(1),
    max_list_pages: z.number().int().min(1).max(4),
    max_data_pages: z.number().int().min(1).max(5),
    page_size: z.number().int().min(1).max(10000),
    normalized_days: z.number().int().positive().max(3650),
    // New code systems are never joined automatically, including the 2026 redesign.
    reviewed_schema_signatures: z.array(z.string().regex(/^[0-9a-f]{64}$/)).max(16),
  })
  .strict()
  .superRefine((config, ctx) => {
    const words = config.search_words;
    if (
      words &&
      (Array.isArray(words)
        ? words.length !== config.table_groups.length
        : Object.keys(words).length !== config.table_groups.length ||
          config.table_groups.some((group) => !Object.hasOwn(words, group)))
    )
      ctx.addIssue({
        code: 'custom',
        path: ['search_words'],
        message: 'Search words must match table_groups',
      });
    if (
      config.implied_measures &&
      Object.keys(config.implied_measures).some((group) => !config.table_groups.includes(group))
    )
      ctx.addIssue({ code: 'custom', path: ['implied_measures'], message: 'Unknown table group' });
  });
