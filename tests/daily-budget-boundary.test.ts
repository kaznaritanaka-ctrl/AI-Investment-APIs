import { expect, it } from 'vitest';
import { expandedDaily } from './daily-series-helpers';
import { SourceSchema } from '../src/schema';
import { assertResearchAllowed, ResearchConfigSchema } from '../src/research/schema';
import { PersonalCloudSchema } from '../src/research/personal-contract';
import { cloudFixture } from './personal-cloud-fixture';
import { gpuTime } from './public-gpu-helpers';
import { readFile } from 'node:fs/promises';
import { PersonalDailySchema } from '../src/research/personal-contract';
import { hash, stable } from '../src/util';
import { DailyCapture } from '../src/research/daily-checkpoint';
import { parsePublicGpu } from '../src/research/public-gpu-html';
import { rentalHtml } from './daily-series-helpers';

it('keeps the expanded budget exclusive to daily checkpoint contracts, not shared or initial research', async () => {
  const { c } = await expandedDaily();
  expect(ResearchConfigSchema.safeParse(c.config).success).toBe(true);
  expect(SourceSchema.safeParse(c.config.source).success).toBe(false);
  expect(() => assertResearchAllowed(c.config, gpuTime, c.config.terms.version)).toThrow(
    'public_gpu_daily_checkpoint_required',
  );
  const { contract: initial } = await cloudFixture();
  expect(PersonalCloudSchema.safeParse(initial).success).toBe(true);
  const rejected = PersonalCloudSchema.safeParse({ ...initial, config: c.config });
  expect(rejected.success).toBe(false);
  if (!rejected.success)
    expect(rejected.error.issues.some((i) => i.message === 'personal_initial_capture_budget')).toBe(
      true,
    );
  const oversized = structuredClone(c.config);
  oversized.limits.capture_record_limit = 129;
  oversized.source.max_records = 129;
  expect(ResearchConfigSchema.safeParse(oversized).success).toBe(false);
});

it('rejects partial or inconsistent saved capture coverage before planning disappearance events', async () => {
  const { c, pin } = await expandedDaily();
  const page = await parsePublicGpu(c.config, rentalHtml(1), gpuTime, true);
  const value = {
    version: 'daily-projection-v2',
    contract_hash: pin.contract_hash,
    run_id: 'a'.repeat(64),
    observed_at: gpuTime,
    payload_hash: 'b'.repeat(64),
    page,
  };
  expect(DailyCapture.safeParse(value).success).toBe(true);
  expect(DailyCapture.safeParse({ ...value, page: { ...page, coverage: 'partial' } }).success).toBe(
    false,
  );
  expect(DailyCapture.safeParse({ ...value, page: { ...page, reported_total: 99 } }).success).toBe(
    false,
  );
  expect(
    DailyCapture.safeParse({
      ...value,
      page: { ...page, selection: { ...page.selection, input_rows: 99 } },
    }).success,
  ).toBe(false);
});

it.each(['highreso_public', 'rebro_public'])(
  'ships the %s expanded daily proposal disabled and non-executable',
  async (source) => {
    const draft = JSON.parse(
      await readFile(
        'docs/personal-execution-20261018/' + source + '.daily-checkpoint-draft.json',
        'utf8',
      ),
    );
    expect(draft.config_sha256).toBe(await hash(stable(draft.config)));
    expect(ResearchConfigSchema.safeParse(draft.config).success).toBe(true);
    expect(PersonalDailySchema.safeParse(draft).success).toBe(false);
    expect(draft.config.source.enabled).toBe(false);
    expect(draft.config.limits).toMatchObject({
      page_size: 48,
      capture_record_limit: 128,
      max_pages: 1,
      max_input_rows: 256,
    });
    expect(draft.config.source.policy.rights.automated_collection).toBe('review_required');
    expect(draft.decision.provider_permission).toBe('unconfirmed');
    expect(draft.cloud.account_id).toBeNull();
    expect(draft.daily.approval_ref).toBeNull();
  },
);
