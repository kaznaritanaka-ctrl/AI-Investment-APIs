# P0 runtime and three-year capacity review — 2026-10-01

## Staged rollout decision

The local release candidate is reviewed for an initial rollout of the five-provider / 17-field scope approved in [the owner decision](p0-owner-review.md). This decision is based on the current 154-model catalog, the measured storage profile, and the explicitly limited scenarios below. It does not certify that 500 models with 64 components each can be kept for three years. The 500-model intake guard, 25 models per invocation, 64-component guard, 16 MB response limit and 5,000 ms Collector CPU limit remain unchanged. No provider or approved field is removed to reduce resource usage.

The exact aggregate results are in [the measurement record](reviews/p0-capacity-20261001.json). They distinguish local live processing from synthetic tests and from Cloudflare production metrics. Production deployment, Cloudflare P0 CPU/isolate memory and the first natural expanded collection are still pending. The release remains subject to the separate migration/API/Collector approvals in [the enablement plan](models-enablement.md).

## Local live measurement

One GET to the fixed catalog endpoint on 2026-10-01 produced a 5,276,537-byte input and a 407,460-byte approved projection. No raw payload or private evidence body is included in this report or Git. The source was complete: anthropic 16, google 39, mistral 34, openai 53 and xai 12, totaling 154 catalog models and 583 price components (mean 3.79, maximum 16). Ten resumable local invocations completed with no second source request. This was an isolated local development database; no production observation was added.

There were 154 catalog observations and 154 price observations. Twenty-nine prices were quarantined under the existing rules, leaving 279 accepted catalog/price observations. Mode conditions outside the approved fields and missing price components were retained as issue codes. Ten models reported zero prices; zero remains unverified, not confirmed free. Issue categories overlap. Capture completeness is separate from price eligibility.

The indexed local SQLite footprint increased by 1,568,768 private bytes and 2,379,776 public bytes. A constant daily profile for 1,095 days yields private 1.718 GB and public 2.606 GB (decimal GB). This is an extrapolation of one day, not a fully populated three-year benchmark.

## Growth and capacity limits

Allowing all catalog/price rows to become publicly eligible adds a public-side factor of 308/279. Adding a 50% reserve for extra events, corrections, allocation variation and other overhead gives private 2.577 GB and public 4.315 GB for a constant model population. The reserve is an assumption, not a measured worst-case bound.

An illustrative 30% annual increase in models, applied daily over three years with that same reserve, gives private 3.917 GB and public 6.560 GB, with about 338 models at the end. Component distribution is assumed unchanged. Faster model/component growth requires another capacity review; a growth scenario is not a prediction or guarantee.

The actual 500-model / 64-component synthetic storage test contradicts any unconditional three-year claim: the largest measured daily growth extrapolates to private 15.712 GB and public 18.690 GB. [D1 Paid has a 10 GB limit per database](https://developers.cloudflare.com/d1/platform/limits/). Never silently shorten 1,095-day retention, truncate the selected providers, drop components, or mark a partial capture complete to fit that limit.

Operational review thresholds: reassess if either database's three-year projection exceeds 7 GB or actual storage exceeds 5 GB; treat actual storage at 8 GB as urgent capacity work before continued growth reaches the hard limit. Use actual database growth, model/component counts and projected retention volume in the review. These are documented thresholds; this change does not install an external monitor or claim that automatic capacity alerts are already active. Cloudflare's existing storage metrics and Billing Budget Alerts remain the operational interfaces. A larger storage design, if required later, needs its own review.

The 2026-12-26 policy review deadline remains in force independently of storage capacity. This candidate does not promise unattended operation beyond a rights-review deadline.

## Runtime evidence

The same pipeline completed three consecutive synthetic days of 500 models × 64 components with 23 invocations/day, 32,000 components/day, no quarantine and no foreign-key violations. Peak D1 calls were 263 for the first day and 338 on subsequent days; SQL statements peaked at 491. Each mocked daily catalog was fetched once. All 3,000 catalog/price rows were published in the isolated database. This test uses local workerd, not Cloudflare billed CPU.

A separate large-input test processed 15,604,498 input bytes (including 14 MiB of unselected padding) into 9,863,362 projection bytes for 500 models × 64 components. Capture was complete and the long decimal lexeme was preserved. Local elapsed time was about 1.21 seconds; it is not an isolate CPU or memory measurement. The standard runtime suite also covers 50/250/1000 models, GPU 1,051 listings, replay and public pagination; 1000 remains outside the candidate's daily scheduling budget.

The full database at three years has not been instantiated, and its query/retention latency remains unmeasured. Preserve the existing bounded continuations and retention tests; use production rows-read/written and CPU measurements after rollout to reassess those limits. Estimated storage alone does not validate long-history query performance.

## Cost basis

At the constant current profile with eligibility allowance and 50% reserve, combined D1 storage is about 6.89 GB at year three. With no other account usage, the end-state D1 storage overage is approximately USD 1.42/month above the included 5 GB; adding the already approved Workers USD 5/month base gives about USD 6.42/month before other usage. The illustrative model-growth scenario raises this storage-plus-base subtotal to approximately USD 9.11/month. These are end-state monthly subtotals, not total first-three-year invoices.

Current local R2 evidence/archive growth suggests well below 10 GB at the approved 90/365-day retention; no backup export storage was added. Synthetic max-component D1 writes and R2 operations are small relative to monthly included allowances, but public API traffic, account-wide usage, long-history query scans, retries, Workers CPU and Logs are separate. Actual P0 Cloudflare usage is pending. Prices checked on 2026-10-01: [Workers](https://developers.cloudflare.com/workers/platform/pricing/), [D1](https://developers.cloudflare.com/d1/platform/pricing/), [R2](https://developers.cloudflare.com/r2/pricing/).
