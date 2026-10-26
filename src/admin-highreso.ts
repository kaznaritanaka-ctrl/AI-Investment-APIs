import highreso from '../config/proposals/research/highreso_public.json';
import { HighresoLimit, HighresoRuns, HighresoLatestPrices } from './admin-highreso-contract';
import { ResearchConfigSchema, type ResearchConfig } from './research/schema';
import { readAdminGpuSnapshots, readResearchRun, type ResearchEnv } from './research/pipeline';
import { PublicGpuRecordSchema } from './research/public-gpu-html';

import { safeLogCode } from './telemetry';

// Collector-only projection. No PUBLIC_DB, HTTP, or write operations.
export function highresoReader(
  env: ResearchEnv,
  config: ResearchConfig = ResearchConfigSchema.parse(highreso),
  now = new Date().toISOString(),
) {
  const source = {
    source_id: 'highreso_public' as const,
    source_url: config.source.source_url,
    attribution_text: config.source.attribution_text,
    license_url: config.source.license_url,
    terms_url: config.source.terms_url,
  };
  const opt = { current_terms_version: config.terms.version, now: () => now };
  async function runs(limit: number, completeOnly = false) {
    // Apply current rights and external revocation markers even for an empty list.
    await readResearchRun(env, config, '', opt);
    return (
      await env.PRIVATE_DB.prepare(
        `SELECT run_id,scheduled_for,state,observation_count,last_error FROM research_runs WHERE source_id=? AND synthetic=0 ${completeOnly ? "AND state='complete'" : ''} ORDER BY scheduled_for DESC,run_id DESC LIMIT ?`,
      )
        .bind('highreso_public', limit)
        .all<{
          run_id: string;
          scheduled_for: string;
          state: string;
          observation_count: number;
          last_error: string | null;
        }>()
    ).results;
  }
  return {
    async highresoRuns(limit?: number) {
      const rows = await runs(HighresoLimit.parse(limit));
      return HighresoRuns.parse({
        schema_version: 'highreso-admin-v1',
        visibility: 'private_only',
        source,
        runs: rows.map((r) => ({
          run_id: r.run_id,
          scheduled_for: r.scheduled_for,
          run_date_jst: new Date(Date.parse(r.scheduled_for) + 9 * 3600000)
            .toISOString()
            .slice(0, 10),
          state:
            r.state === 'complete'
              ? 'success'
              : r.state === 'partial' || r.state === 'collecting'
                ? 'partial'
                : 'fail',
          observation_count: r.observation_count,
          last_error: r.last_error === null ? null : safeLogCode(r.last_error),
        })),
      });
    },
    async highresoLatestPrices() {
      const { snapshots, truncated } = await readAdminGpuSnapshots(env, config, opt);
      const latest = snapshots[0];
      const prices = (latest?.rows ?? [])
        .filter((r) => r.change_kind !== 'not_seen')
        .map((row) => {
          const record = PublicGpuRecordSchema.parse(JSON.parse(String(row.domain_json)));
          const history = snapshots
            .flatMap((s) => s.rows)
            .filter((r) => r.record_key === row.record_key);
          const lastChange = history.find(
            (r) => r.change_kind === 'first_seen' || r.change_kind === 'revised',
          );
          const changedFrom = lastChange
            ? (PublicGpuRecordSchema.parse(JSON.parse(lastChange.domain_json))
                .instance_id_changed_from ?? null)
            : null;
          return {
            record_key: record.record_key,
            gpu_model: record.offer.reported_product,
            ...(changedFrom
              ? {
                  instance_id: record.instance_id,
                  instance_id_changed_from: changedFrom,
                  identity_change_label: '型番変更' as const,
                }
              : {}),
            gpu_count: record.offer.gpu_count,
            price_jpy: record.offer.currency === 'JPY' ? record.offer.amount_decimal : null,
            unit: record.offer.unit,
            tax_status: record.offer.tax_status,
            first_seen: history.find((r) => r.change_kind === 'first_seen')?.observed_at ?? null,
            last_changed: lastChange?.observed_at ?? null,
          };
        });
      return HighresoLatestPrices.parse({
        schema_version: 'highreso-admin-v1',
        visibility: 'private_only',
        source,
        run_id: latest?.run.run_id ?? null,
        observed_at: latest?.rows[0]?.observed_at ?? null,
        history_truncated: truncated,
        prices,
      });
    },
  };
}
