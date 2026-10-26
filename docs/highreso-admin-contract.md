# Highreso private AdminRead RPC contract (v1)

Collector service binding only: `ADMIN_READ` → `ai-investment-collector#AdminRead`.
No HTTP/public API route, public D1, mutation, new binding or secret.
Collector export: `src/collector-admin-entrypoint.ts` extends the existing read-only
Admin class; the base Admin module and public API have no research dependency.
Implementation and runtime response validators: `src/admin-highreso-contract.ts`.
Existing `read(resource, query)` is unchanged. B2 should copy the new contract file
and validate both RPC responses in the existing Admin proxy.

```ts
interface HighresoSource {
  source_id: 'highreso_public';
  source_url: string;
  attribution_text: string;
  license_url: string | null;
  terms_url: string | null;
}
interface HighresoAdminRead {
  highresoRuns(limit?: number): Promise<HighresoRunsDTO>;
  highresoLatestPrices(): Promise<HighresoLatestPricesDTO>;
}
interface HighresoRunsDTO {
  schema_version: 'highreso-admin-v1';
  visibility: 'private_only';
  source: HighresoSource;
  runs: Array<{
    run_id: string;
    run_date_jst: string; // YYYY-MM-DD, scheduled_for converted to Asia/Tokyo
    scheduled_for: string; // UTC ISO 8601
    state: 'success' | 'partial' | 'fail';
    observation_count: number;
    last_error: string | null; // allowlisted code; unknown -> operation_failed
  }>;
}
interface HighresoLatestPricesDTO {
  schema_version: 'highreso-admin-v1';
  visibility: 'private_only';
  source: HighresoSource;
  run_id: string | null;
  observed_at: string | null; // UTC ISO 8601
  history_truncated: boolean;
  prices: Array<{
    record_key: string; // quote identity: do not collapse by GPU model
    gpu_model: string; // provider's reported GPU/product label
    gpu_count: number | null;
    price_jpy: string | null; // original decimal string; null is not free
    unit: string; // original unit, e.g. node_hour or month
    tax_status: 'included' | 'excluded' | 'unknown';
    first_seen: string | null; // UTC ISO 8601
    last_changed: string | null; // UTC ISO 8601
  }>;
}
```

`limit` defaults to 30; integer 1–30 only, invalid values reject (no coercion).
Runs sorted by scheduled_for descending, then run_id descending; real Highreso only.
Complete maps to success, collecting/partial to partial, other states to fail.
Observation count is the stored run count, not price count or an attempt count.

Prices come from the latest complete real run; history scans the latest 30 complete real runs. No
fallback to stale snapshots when the selected snapshot is hidden/expired.
Disappeared quotes are excluded. At most 192 prices. Current source rights,
config hash/history approval, retained deadlines, and R2 revocation/deletion
markers apply through the bounded research snapshot reader; denied/unavailable reads reject.
The reader uses three bounded D1 queries for up to 30 snapshots (current policy, snapshot data, and identity links).
Expired snapshots or observation-count mismatches reject, including missing rows for a nonempty run. The
Admin must show an unavailable state, never convert an RPC failure into success.
An authorized empty history returns null run/timestamp and an empty price list.

Timestamp history is bounded to those 30 complete runs. `first_seen` is present only when
an accessible first_seen observation exists in that window; `last_changed` is
the newest accessible revised/first_seen observation. Null means not established
within readable history, not unchanged forever. `history_truncated` indicates
more than 30 runs exist. Revised includes quote-condition changes, not just price.
Timestamps describe retained observations, not the provider's original listing date.
All timestamps stay UTC except the explicitly named run_date_jst.

Part A: timeout/network_error only, 45-minute cooldown, at most two extra whole
fetch sequences per daily run (robots + terms + page, maximum 9 HTTP requests).
Each request retains the 15-second timeout and existing gates/UA. Crossing UTC
midnight or the third failure defers 24 hours; longer Retry-After takes precedence.
403/429/robots and schema/review failures never get a same-day retry.
No new D1 migration is required. GPU sequence admission is recorded in the
existing private `fetch_attempts` ledger (`research_gpu_sequence`), with a metadata
parent in `collection_runs` (state `research`). The research run lease serializes
admission; at most three sequences are admitted per daily research run. Each
sequence admits at most three HTTP requests, for at most nine requests total.
The existing `research_runs.http_page_attempts` remains a request counter capped
at three. Other adapters retain their existing request budgets. A crash after
admission consumes a sequence rather than allowing an uncounted retry. Legacy
runs with existing HTTP attempts and no sequence ledger fail closed without new
HTTP requests.
No production migration was performed.

Display source attribution and retain the terms/license references; private_only
does not grant public redistribution.

2026-10-27 identity compatibility proposal: price entries gain optional `instance_id`,
`instance_id_changed_from`, and `identity_change_label` (「型番変更」 or null). The
companion Admin strict validator and #highreso display require a coordinated update.
See [stable-key rollout and rollback](highreso-stable-key.md). No deployment performed.
