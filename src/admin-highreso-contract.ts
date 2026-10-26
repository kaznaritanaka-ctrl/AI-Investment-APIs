import { z } from 'zod';

const timestamp = z.iso.datetime();
export const HighresoSource = z
  .object({
    source_id: z.literal('highreso_public'),
    source_url: z.string(),
    attribution_text: z.string(),
    license_url: z.string().nullable(),
    terms_url: z.string().nullable(),
  })
  .strict();
export const HighresoLimit = z.number().int().min(1).max(30).default(30);
export const HighresoRuns = z
  .object({
    schema_version: z.literal('highreso-admin-v1'),
    visibility: z.literal('private_only'),
    source: HighresoSource,
    runs: z
      .array(
        z
          .object({
            run_id: z.string(),
            run_date_jst: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
            scheduled_for: timestamp,
            state: z.enum(['success', 'partial', 'fail']),
            observation_count: z.number().int().nonnegative(),
            last_error: z.string().nullable(),
          })
          .strict(),
      )
      .max(30),
  })
  .strict();
export const HighresoLatestPrices = z
  .object({
    schema_version: z.literal('highreso-admin-v1'),
    visibility: z.literal('private_only'),
    source: HighresoSource,
    run_id: z.string().nullable(),
    observed_at: timestamp.nullable(),
    history_truncated: z.boolean(),
    prices: z
      .array(
        z
          .object({
            record_key: z.string(),
            gpu_model: z.string(),
            gpu_count: z.number().int().positive().nullable(),
            price_jpy: z.string().nullable(),
            unit: z.string(),
            tax_status: z.enum(['included', 'excluded', 'unknown']),
            first_seen: timestamp.nullable(),
            last_changed: timestamp.nullable(),
            instance_id: z.string().nullable().optional(),
            instance_id_changed_from: z.string().nullable().optional(),
            identity_change_label: z.literal('型番変更').nullable().optional(),
          })
          .strict(),
      )
      .max(192),
  })
  .strict();
export type HighresoRunsDTO = z.infer<typeof HighresoRuns>;
export type HighresoLatestPricesDTO = z.infer<typeof HighresoLatestPrices>;
export interface HighresoAdminRead {
  highresoRuns(limit?: number): Promise<HighresoRunsDTO>;
  highresoLatestPrices(): Promise<HighresoLatestPricesDTO>;
}
