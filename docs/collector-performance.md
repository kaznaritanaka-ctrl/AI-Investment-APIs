# Collector performance — synthetic comparison, 2026-09-30

The reliability changes are **local only**. Production CPU after these changes is unmeasured. Do not interpret a successful local workerd run as Workers Free capacity approval.

## Production evidence

The read-only 2026-09-30 audit observed one successful daily invocation: **363.684 ms Cloudflare CPU**, **4.919485 s wall time**, about **56.15 MiB memory**. Watchdog CPU was 9.544 ms. This is historical production telemetry, not this benchmark and not proof future CPU overruns will be tolerated. Exact deployed Git SHA remains unproven.

## Method

`pnpm collector:benchmark before|after` is synthetic only, with no source network request or remote Cloudflare call. It uses 5 fresh Node v24.19.0 processes per case for independent probes, and one complete local workerd + D1/R2 snapshot per case. `pnpm collector:benchmark:summary` checks before/after normalized-domain digests and creates [machine-readable ranges and counts](collector-performance-results.json). Reports in `work/` contain synthetic measurements only. Set `AI_APIS_TEMP_DIR` to a short local temporary path on Windows.

Cases use 8 MiB of unselected synthetic descriptions, plus a synthetic catalog. A: 500 input models, 2 selected legacy Mistral models, 5 projected field groups. B: 250 P0 models, 17 approved fields. C: 500 P0 models (proposal maximum), 17 fields. Each selected model has 3 price components. B/C retain 25 models per invocation and all existing caps. A is not the real upstream catalog; the large padding stresses whole-body parsing. Model count is not a multiplier for production CPU.

Node `performance.now()` is elapsed time. `process.cpuUsage()` is a **local host-process CPU proxy**, with coarse Windows resolution: zero does not establish zero cost. The JSON contains minimum/median/maximum CPU proxies, heap deltas and process peak RSS. That RSS includes multiple probes/allocator high-water marks, **not Worker isolate memory**. Cold module startup CPU, workerd CPU and workerd isolate memory are unmeasured. The warm configuration probe revalidates 15 sources. The complete pipeline timing includes D1/R2 waits, and excludes scheduled summary, retention, notification and telemetry overhead. Independent overlapping probes must not be summed.

## Before / after

Small changes reuse a single UTF-8 encoding for payload hashing and byte checks, and construct the approved-field Set once per saved evidence validation. Legacy lossless numeric parsing and duplicate-key rejection, decimal precision, current rights gates, full integrity validation, immutable history and all safety limits remain intact. No large Free-specific redesign was made.

| Case | Input bytes | Selected / output observations | Evidence processing elapsed median, ms | Node CPU proxy median, ms | Whole local pipeline elapsed, ms |
|---|---:|---:|---:|---:|---:|
| A | 8,666,543 | 2 / 2 | 422.36 → 372.29 | 547 → 453 | 468 → 453 |
| B | 8,527,543 | 250 / 500 | 47.68 → 37.98 | 47 → 47 | 4,611 → 4,850 |
| C | 8,666,543 | 500 / 1,000 | 65.03 → 56.61 | 94 → 93 | 10,211 → 10,907 |

Evidence processing includes parse, selection, schema/decimal work, serialization and hash. A's parse-only median was 472.90 → 426.34 ms; it dominates despite selecting only two models. B/C already use P0's native source-aware numeric reviver; selection/schema/decimal median was 34.33 → 31.00 ms / 43.36 → 44.64 ms. Saved evidence validation was 23.21 → 21.60 ms / 35.87 → 35.40 ms and recurs on continuation. These reductions do **not** establish a causal speedup of every phase: parsing itself was unchanged, and noisy full pipeline B/C timings increased. Output domain digests and row counts match before/after.

| Case | Invocations / source fetches | D1 SQL (private / public) | Max SQL per invocation | D1 calls | Max batch | D1 rows read / written | R2 get / put / head |
|---|---:|---:|---:|---:|---:|---:|---:|
| A | 1 / 1 | 30 / 7 | 37 | 29 | 4 | 28 / 61 | 2 / 2 / 0 |
| B | 13 / 1 | 3,411 / 801 | 416 | 2,673 | 6 | 3,679 / 11,867 | 14 / 11 / 0 |
| C | 23 / 1 | 6,781 / 1,591 | 416 | 5,303 | 6 | 7,320 / 23,687 | 24 / 21 / 0 |

Counts were unchanged by the allocation changes. These are **new baseline snapshot** costs, not long-history or retention worst cases. Per binding the maximum is 337 SQL in B/C. Separately from statement counts, D1 API calls per invocation peak at **29 / 263 / 263** for A/B/C (a batch is one call). Thus B/C exceed Free's invocation budget even when counting batches as single calls. Bounded batches do not imply a bounded-enough invocation: local emulation did not enforce the Free per-invocation query limit. This is an additional reason not to approve P0 on Free. All cases use 3 price components/model; the allowed maximum of 64 components/model and long-history retention/revisions are not capacity-tested, and Paid does not automatically make those workloads safe.

## Free / Paid decision (official documentation checked 2026-09-30)

- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/): Free CPU 10 ms, 100,000 requests/day; memory 128 MB. One production success at 363.684 ms does not make this compliant. Paid still has 128 MB memory. Scheduled invocations with interval below one hour have 30 s CPU; intervals of at least an hour have 15 min. Our 5-minute continuation must fit the tighter limit.
- [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/): Paid starts at **USD 5/account/month**, includes 10 million requests and 30 million CPU ms/month; excess USD 0.30/million requests and USD 0.02/million CPU ms. Taxes/exchange rates are excluded; no contract change was executed.
- [D1 limits](https://developers.cloudflare.com/d1/platform/limits/): 50 queries per invocation on Free versus 1,000 on Paid, 500 MB versus 10 GB per database. B/C's 416 statements exceed Free. Re-measure the scheduled invocation including overhead and historical workloads before release.
- [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/): Free 5 million rows read/day, 100,000 rows written/day, 5 GB/account; Paid includes 25 billion reads/month, 50 million writes/month and 5 GB. Migration/retention/index costs are additional; storage retention can dominate.
- [R2 pricing](https://developers.cloudflare.com/r2/pricing/): its own storage and operation quotas/billing remain separate. Workers Paid does not remove R2 limits or charges.

Existing Cron configuration produces 72 continuation + 1 collection + 1 watchdog = **74 invocations/day**, or 2,220 in 30 days, regardless of whether continuation is idle. Current A takes one processing invocation; B/C need 12/22 subsequent steps, fitting the existing 72 opportunities only if dependencies, retention, retries and outages permit. No Cron changes are proposed here. Whole-account API/Admin/other Workers traffic is additional.

For a planning envelope, assigning **1,000 ms CPU to each of 2,220 monthly collector invocations** gives 2.22 million CPU ms; a **5,000 ms envelope** gives 11.1 million. These are explicit budget assumptions, not measured Cloudflare CPU forecasts. Both fit Paid's included CPU before other Workers. Requests also fit the included amount at this collector-only volume. Existing observed daily CPU × 30 would cover only that daily event and must not be quoted as a whole-account monthly forecast.

At one new snapshot/day, the synthetic D1 operation counts imply B: 110,370 reads / 356,010 writes in 30 days; C: 219,600 reads / 710,610 writes. Current A: 840 / 1,830. These exclude ECB, API reads, summary/retention/retries, migration and long-history effects. R2 A/B/C get+put totals are 120 / 750 / 1,350 per 30 days, excluding cleanup and other traffic. No local storage measurement establishes long-term D1/R2 size.

**Recommendation:** the modest allocation improvement is useful, but does not justify a Free-capacity claim. Obtain approval for Paid and a bounded CPU setting, then validate actual production CPU/memory/queries at rollout. Remaining on Free means accepting an unresolved reliability risk for existing collection and blocking P0 enablement; this task does not stop existing collection. Do not reduce rights checks or change semantics to fit Free.

Only after explicit approval: owner selects the verified account and changes the Workers plan in Dashboard; verify the Paid subscription read-only; update deployment plan evidence, then propose `limits.cpu_ms = 5000` in the collector Wrangler config (see [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)). The budget must be tested against real metrics; it is not set by this task. D1 Time Travel policy remains 7 days until separately reviewed, even if Paid supports 30. Re-run preflight, then release as described in the reliability release plan. Account-wide pricing, D1, R2 and logs must be monitored independently.
