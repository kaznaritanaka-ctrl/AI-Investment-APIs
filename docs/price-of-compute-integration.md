# Price of Compute: bounded private-only integration (2026-10-05)

This is a reviewed code/test candidate in [Draft PR #8](https://github.com/kaznaritanaka-ctrl/AI-Investment-APIs/pull/8), with local and GitHub CI verification recorded below. It does not enable a source, grant rights, change retention, change Cron, migrate a remote database, deploy, or publish data. `config/sources/price_of_compute.json` remains byte-for-byte disabled with all nine rights `review_required`. Dependencies, Wrangler configuration, all migrations and the ECB/Models configuration are unchanged.

## Baseline and remaining branch reconciliation

The attachment was prepared on a byte-verified source snapshot of `codex/schema-drift-recovery-20261005` at `32f85f3e2eff60d0a3f8a0d5fb70c25d7d829c4e`. This workspace applied it to the subsequent upstream head `b50edd39396b9fd7288cd2f22bbc706328808e84`, added the strict-root regression fix, and verified code commit `0d00e7f7062bb8e310623864be00281eaecf60a7`. Production Collector `a534ff06` remains an ancestor. The attachment's local snapshot commits are not substituted for upstream history. PR #8 targets [PR #7's branch](https://github.com/kaznaritanaka-ctrl/AI-Investment-APIs/pull/7), keeping the PoC review separate from the parent operational changes; neither PR is merged.

The separate `codex/gpu-energy-expansion` at `a0196dc24348cb7185a37e6762ecd9a7c136c288` contains GPU/energy work and is not included here. Its source and a read-only merge simulation were inspected during this integration; the reconciliation results below identify what must be retained when that branch is composed later. No new EIA or JEPX collector is included in this patch.

## Source contract and projection

The pure parser uses `lossless-json` token objects and preserves exact decimal strings. A numeric identifier is not coerced to a label, and an ordinary object imitating a numeric token is rejected. It bounds response bytes and provider rows; validates the requested/source SKU; rejects unsupported pagination, unreviewed root fields, new provider conditions, unknown pricing types, duplicates, invalid/future source timestamps and invalid prices. Only the known root fields `sku`, `day`, `prices`, `providers`, `updated_at` and `attribution` are accepted. Source aggregate medians and supplied attribution text are discarded. Unknown fields are rejected before evidence persistence, including fields that might redefine currency, unit, basis or market scope.

`gpu_projection_v1` remains the envelope format. New evidence has an explicit `price_of_compute` metadata object, also present as an optional source-scoped field in each `GPURental` domain. Legacy Lambda/Sakura/eBay records do not acquire this field, so their record keys, cohort objects and default parser version remain unchanged.

- Native record key: JSON tuple `[requested SKU, provider label, source pricing type, native region]`
- `on_demand` and `spot` map to those contract types; `community` stays a distinct native condition with normalized contract `unknown`
- `source_day` becomes observation `source_date` as the catalog day; `source_updated_at` remains the explicitly named source update clock. `source_published_at` stays null because no distinct publication timestamp is established
- Provider `source_observed_at` remains separately recorded; our envelope/observation `observed_at` is retrieval time
- No source day is converted to a fabricated midnight timestamp; `source_effective_at` stays null
- Region is source-reported and accompanied by an evidence pointer; country is not inferred
- Availability, guarantees, sharing, node composition, price scope and unresolved product details remain unknown
- Secondary provenance and null native `origin_offer_id` remain explicit; the local `offer_id` is the requested SKU, not a verified provider offer
- Zero retains the `zero_price_reported` warning and never means confirmed free; missing provider time retains its warning

Source-scoped parser version `gpu-price-of-compute-20261005.2` is used in snapshot scope, observations, telemetry and correction checks. The incoming `.1` parser was advanced for the stricter root contract. Other GPU sources remain `gpu-20260927.1`. PoC adds no SQL migration: the fields fit existing immutable metadata/domain JSON, with ordinary indexed key/cohort columns recomputed for PoC only. Local D1 persistence and foreign-key/immutable-trigger checks cover this path. The parent operational candidate still contains its separately unapplied private 0006; this does not authorize applying it or the independent energy 0004.

Reviewed corrections preserve the evidence-level source metadata. The prospective corrected projection is semantically validated before any correction snapshot/run/evidence is written, so an invalid future provider time cannot poison an immutable revision key.

## Cache/retry safety

Successful same-slot evidence is immutable and replays without HTTP. Before a fresh PoC request, the collector checks other active source run leases, then existing source HTTP 2xx attempt metadata. Before every actual HTTP attempt it also persists and read-verifies a run reservation lasting one hour plus the full bounded request timeout. If reservation persistence/verification fails, no request is sent. If both post-response attempt logging and failure-state writes fail, the pre-request reservation still protects same-slot and cross-slot retries after the short lease expires. Reservation timestamps are attempt-local and the SQL update is monotonic, so a late write from a timed-out attempt cannot shorten a newer budget. It defers new HTTP for at least one hour after the recorded request completion, including HTTP 200 responses that fail schema/content validation. The shared fetcher has a PoC-only rule forbidding an internal retry after any HTTP 2xx body failure; other adapters retain their existing retry behavior. If the HTTP 2xx attempt-log write fails, the durable run retry deadline also acts as a source-wide backoff across slots. A projection failure sets retry time immediately; malformed payloads are never stored as a cache. Only existing allowlisted attempt metadata is used.

The guard is deliberately **source-wide**, stricter than per-SKU caching: multiple SKU partitions advance no faster than hourly. This is compatible with the separate initial proposal of one H100 SKU per day; review capture-window/continuation behavior before enabling multiple partitions. This local guard is not a claim about production scheduling or source activation.

## Private display and attribution

Canonical attribution is `Data: Price of Compute` with `https://www.priceofcompute.com/`. It is fixed in projected evidence and the private Admin Data DTO. The Admin allowlist exposes native pricing type and all source/retrieval clocks as selected scalar fields, including null provider time. It does not forward arbitrary nested objects, artifact paths, unknown fields or supplied attribution text.

Future approved runtime source metadata must also use this canonical attribution; this patch intentionally does not mutate the inactive source configuration or its policy hash. Terms evidence remains the official [API documentation](https://www.priceofcompute.com/api) and [press guidance](https://www.priceofcompute.com/press). No live response was fetched for this integration; all fixtures are invented.

## Explicit activation/release blockers

1. Keep this PoC-only candidate separate from the `a0196dc` GPU/energy composition; if composing them later, resolve the documented conflicts and re-run aggregate checks on that combined tree
2. Approve the exact private-only field/SKU scope, attribution, retention/backup behavior and owner review as a new policy version; the separate inactive retention proposal is not runtime approval
3. Extend the operational-status/overnight path with reviewed GPU snapshot/deadline/quality semantics. It currently explicitly selects only ECB and Models.dev. **PoC is not monitored there by this patch**
4. Make owner-facing freshness labels distinguish retrieval/collection health from provider/source-price freshness. The existing generic GPU Source status uses retrieval age; no source-price staleness threshold was invented here. The Admin Data clocks are visible, but a generic healthy retrieval label is not a fresh-price claim
5. Approve the precise release and source activation separately, with a controlled first collection and real capacity validation. Synthetic D1/R2 tests are not production or Free-plan capacity evidence

Public prices, public metrics and public coverage remain absent with a private-only policy. The offline preflight reports the existing configuration ready with PoC disabled; it does not establish readiness to enable PoC.

## Local verification

- Pure/adapter contract suite: 25 tests, including native condition/identity contracts, unknown root-field rejection and the HTTP-2xx internal-retry regression
- Synthetic integration suite: 29 tests using real local Miniflare D1/R2, native pricing/region record survival, immutable replay, no-refetch recovery, public isolation, fail-closed no-payload persistence, metadata-safe Admin fields, source parser identity, corrections, HTTP-200 retry cooldown, cross-slot cooldown, overlapping-run protection and transient 2xx attempt-log-write failures, simultaneous post-response database write failures, fail-closed reservation writes/readbacks, and root pagination/currency/basis rejection
- Existing GPU/Admin/telemetry tests, formatting, strict TypeScript, boundary checks, generated-schema consistency, offline preflight and dry-run build are rechecked with the patch
- `config/source.schema.json` has no generated diff; `openapi.json` only gains optional PoC domain metadata, without a new endpoint or a public rights grant

The incoming attachment contained 24 contract and 26 integration tests and reported 244 aggregate tests. Those reported results are not substituted for this workspace's verification. The local integration adds one contract test and three persistence cases (54 focused tests total); the fixed-state aggregate/runtime results below are independent complete runs. No live price API request, remote migration, main merge, deployment, source activation or notification is part of this integration.

## Integration review in the current workspace

Input: `price-of-compute-private-readiness-20261005.zip`, SHA-256 `0068c28d83981194153ad9321c0b30dc5dddabbfe8e462fd721407ef19443054`. Patch SHA-256 `70e9238d9edd67b1403baa6d9fe535b12c35832f59dbf104a7a9fc1e8f6056d8`, 96,007 bytes. Applying it to upstream `b50edd39396b9fd7288cd2f22bbc706328808e84` produced exactly the attachment's declared tree `9cecf560279e3419ce3ad935dc49bf04760beed2`. The attachment's local snapshot commits are not grafted into the upstream history. The integration branch retains production `a534ff06` and all current upstream fixes.

Review found a concrete contract hole: top-level `next_cursor`/`pagination` or a new currency/unit/basis/scope field could be ignored while the provider records were accepted as a complete response. A new regression failed against the original patch (`Missing expected exception`), then passed with a strict root whitelist. The existing untrusted-attribution assertion remains, and unknown root text is now rejected rather than persisted. Three additional D1/R2 cases prove that root pagination, currency and basis changes leave no observation, raw artifact or public price/metric/coverage. The parser version advances to `.2`; other adapters and their parser versions are unchanged.

The official [API documentation](https://www.priceofcompute.com/api) and [attribution guidance](https://www.priceofcompute.com/press) were rechecked as documentation only. The response shown in `live-schema-summary.json` was fetched by the attachment producer; this integration does not claim a new live acquisition or live adapter validation. Current Workers best practices and Workers types `5.20261004.1` were consulted without changing installed dependencies, compatibility dates or bindings.

### Independent GPU/energy branch reconciliation

The five shared implementation files were compared against `24768e9..a0196dc`. No duplicate PoC implementation was found. The other branch's changes serve different sources:

| Shared file | PoC change here | Preserve from the independent branch in a future composition |
|---|---|---|
| `gpu-adapters.ts` | Native pricing type/region/clocks and strict PoC projection | Lambda plan/capacity selection and Sakura plan catalog/individual pricing |
| `gpu.ts` | Optional source-scoped PoC metadata and identity/cohort keys | Optional `rental_details`; never add these fields to unrelated source keys implicitly |
| `gpu-pipeline.ts` | PoC-only request reservation and source parser | Rental scope in snapshot identity |
| `gpu-store.ts` | `gpuParser(source)` with a PoC-only parser version | Reviewed rental conversions and the independent branch's generic GPU parser update |
| `network.ts` | Suppress internal retries after PoC 2xx body failures | JEPX byte counting/Shift_JIS handling and Sakura's second, bounded catalog request; retain current recovery `onBody` behavior too |

`git merge-tree` on a temporary candidate commit and `a0196dc` reported eight conflicts: `README.md`, `docs/operations.md`, `docs/rights-policy.md`, `src/collector.ts`, `src/gpu-store.ts`, `src/network.ts`, `src/pipeline.ts`, `src/telemetry.ts`. It modified no checkout, index or branch head. This is conflict discovery, not validation of a combined GPU/energy release. The independent checkout stays at `a0196dc`, and energy 0004 is not copied into this branch. A combined release must resolve the existing Collector/Admin/recovery/energy dispatch and regenerated contracts together, rather than choosing one side wholesale.

### Remaining activation decisions

The attachment's private policy file is a proposal, not a Source configuration or a grant. Its H100-only starting scope and evidence/archive/normalized/backup proposal of 7/7/180/30 days are not applied. No private rights are inferred from the owner's request to integrate code. `config/sources/price_of_compute.json` retains its disabled state and nine `review_required` rights byte-for-byte.

The implementation limits each network invocation to three attempts and enforces the successful-response cooldown across source runs. It does **not** implement the proposal's separate three-attempts-per-SKU-per-day quota; retries across invocations require a separately reviewed durable daily budget before that proposal can be called enforced. Multi-SKU use also needs an explicit capture-window review because the cooldown is source-wide.

PoC is still outside the ECB/Models-only operational checker/overnight aggregation. Generic GPU freshness reflects retrieval age, not guaranteed upstream quote freshness; the Data DTO exposes the four clocks but no price-freshness threshold is assumed. Monitoring and owner-facing freshness labels must be completed before unattended activation. PoC schema failures before its allowlisted projection preserve safe run/attempt metadata but not the rejected body; ECB/Models quarantine recovery does not implicitly authorize retaining PoC raw responses. Consequently, those rejected historical responses cannot be claimed reparsable from saved evidence.

## Fixed-state verification and GitHub review

Validated code: `0d00e7f7062bb8e310623864be00281eaecf60a7`, tree `77a8b1fa968ba2b0da65d612e84376f30a57e4d1`. The checkout was clean before and after every validation stage. No source, test or configuration was edited while validation ran. This final record changes documentation only; code results are attributed to the validated commit, and subsequent CI status is linked from PR #8.

| Execution | Result |
|---|---|
| Initial local aggregate, 2026-10-05 10:36–10:46 JST | 247 passed / 1 failed. Existing `admin-rpc.test.ts` failed when esbuild was denied access to an ancestor directory by the execution sandbox. This is retained as a failed run, not counted as a pass |
| Same Admin RPC test under normal user permissions, 10:48 JST | Passed without changing code, test inputs, assertions or the explicit 30-second test timeout |
| Complete local re-execution, 10:49:37–11:00:54 JST | **24 files / 248 tests passed**. Formatting, strict TypeScript, boundaries, workerd runtime, both Worker dry-run builds, offline preflight/checker, regeneration, generated-file diff and whitespace checks all passed |
| [GitHub CI 37252486501](https://github.com/kaznaritanaka-ctrl/AI-Investment-APIs/actions/runs/37252486501), PR head `0d00e7f` | **24 files / 248 tests passed**, plus the repository's unchanged CI check, preflight, runtime, build, generation and diff steps. Completed 10:47 JST |

Local environment: Windows, Node `24.19.0`, pnpm `11.19.0` lockfile, Vitest `5.0.2`, Wrangler `4.140.0`, Miniflare `4.20260730.0`, esbuild `0.28.1`. Dependencies and the lockfile were not changed. Local Vitest used `--configLoader=native --no-cache --pool=threads --fileParallelism --maxWorkers=2 --testTimeout 60000 --reporter=verbose` and a short local temporary path through `AI_APIS_TEMP_DIR`. The 60-second default accommodates the Windows test host; assertions, fixtures, skips, explicit test timeouts and runtime constraints were not weakened. GitHub CI ran the ordinary repository command and its existing timeout settings on Ubuntu/Node 24.

The final local run is recorded separately in Git-ignored `work/poc-integration-final/results.json` and per-stage logs; the first failed run remains in `work/poc-integration-validation/`. The two runs and the earlier focused test run are not added together. Runtime checks include generic GPU pagination with 1,051 synthetic listings and Models with 50/250/1,000 synthetic models; those are synthetic regression checks, not evidence of live PoC behavior or production capacity.

Offline preflight returned `static_valid: true`, `ready: true` with `price_of_compute:disabled`, notification destination unconfigured and external monitor unconnected. The offline operations checker returned `network_performed: false` and `external_monitor: not_verified`. These successful offline commands do not verify authentication, live API reachability, production collection, publication or monitoring.

| Local artifact | SHA-256 |
|---|---|
| Collector dry-run bundle | `7dde07e303babe6dcdadb1a48f922ce9bde6ad5b67043525e798d94e3a3cc803` |
| API dry-run bundle | `377ca543428f59808d5cd2b635023e60d62a09656562dc487e519bc092fc701d` |
| Unchanged pnpm lockfile | `f6a08aa31f8d4fc9ad7e33d56aa1125c2fecd326c96f061490f75151876be57e` |

The integration branch is `codex/price-of-compute-private-readiness-20261005`. Publication to GitHub follows the owner's existing push/PR authorization after their Netlify confirmation; it does not reopen a Netlify verification claim or approve main merge/production changes. The independent GPU/energy checkout remains at `a0196dc`, Admin remains at `2de4211`, and the original operations checkout's uncommitted document was preserved.
