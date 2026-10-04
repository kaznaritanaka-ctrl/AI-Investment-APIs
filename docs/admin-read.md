# Admin operations read projection

Owner-approved implementation plan: 2026-10-04. The Admin repository has a corresponding branch, codex/admin-operations-pages. This branch adds a named AdminRead WorkerEntrypoint to the existing Collector. The default HTTP handler still returns 404. Scheduled collection, source policy files, Cron, CPU limits, API routes and public D1 bindings are unchanged.

## Read contract

The Admin binds ADMIN_READ to ai-investment-collector#AdminRead and calls read(resource, query). The entrypoint exposes no SQL, URL, R2, fetch, collection, notification, settings or rights mutation method. admin-contract.ts is copied identically into both repositories. The Admin validates the response again and applies a 10-second deadline, a 2-MiB response limit, no-store and its existing Access/origin protections.

Resources are overview, sources, runs, data, rights, settings and releases. The Admin GET routes mirror these names; runs/data also support an observation/run ID path. Source/detail selection is also available through exact query filters. Unknown and duplicate query fields are rejected. Lists default to 50, with a maximum of 100. Runs default to the past seven days; bounded history searches accept at most 31 days per request. Older history remains searchable by selecting another period. Keyset cursors preserve the cutoff and filter fingerprint and reject reuse with different filters.

All SQL statements originate in this code and pass a SELECT/WITH guard. DTOs whitelist fields; evidence pointers, R2 contents, raw metadata/domain JSON, arbitrary error text and Secret values never leave the Collector. Credential reporting consists only of configuration-presence booleans.

Private values require the current runtime/stored configuration and policy version to agree, an unsuspended source, valid internal-analysis/private-storage rights, approved scope/retention and an unexpired record. Legacy values under a previous grant are not automatically reauthorized. Public values independently reuse the public API's current rights, complete batch, snapshot, expiry and lineage gates. Revoking a source masks both internal and public values; private-only permission can expose internal values while publication remains blocked.

## Counts and time

Overview, Sources and Runs use the same run projection and publication calculation. A source's minute is one logical slot: a successful seconds-based legacy run takes precedence over a false minute-based missing record. Watchdog and continuation summaries are related evidence, not additional collections. Collection success, publication and notification are distinct. Notification-not-configured is a Settings issue; configured but pending/exhausted delivery can appear in Overview.

Data defaults to each scope's latest complete snapshot; staging/partial snapshots are available through run/history filters. It preserves decimal strings, null values, original units, source periods, observation/storage/publication timestamps, corrections, per-model price quarantine and FX lineage. Published dataset counts cover all currently visible retained history for the selected source/dataset, not the current page or selected time interval. Derived FX is marked separately and is never counted as a fetched observation.

The cutoff bounds immutable records and pagination membership, while current rights always apply. Mutable run/checkpoint rows cannot reconstruct every earlier state. If later progress is recorded beyond the cutoff, the earlier run state/counts are reported as unavailable instead of inventing past success. The UI exposes both retrieval time and cutoff, and refresh starts a new cutoff. This is not a transactional snapshot across private/public D1 and Cloudflare; independent failures remain explicit.

Electricity acquisition/0004 is an independent, not-yet-deployed branch. This release reports electricity as not_supported; the UI and normalized-field projection support monthly period/unit fields without claiming live electricity data. GPU source activation and API-key registration are outside this release.

## Private migration and release ledger

Only new private migration 0005_admin_release_ledger.sql is required. 0004 is reserved by the separate GPU/energy work. Existing 0001–0003 and public migrations are untouched. 0005 adds the release ledger, append-only/conflict triggers and bounded-read indexes. It neither copies nor replaces observations.

scripts/admin-release-record.mjs checks the strict manifest, artifact/evidence SHA-256, evidence version/SHA/event/checks and the Git commit's tree. It prepares SQL locally and never connects to Cloudflare. Identical replay is idempotent; conflicting data under an existing record ID and updates/deletes fail.

    node scripts/admin-release-record.mjs manifest.json artifact evidence.json repository prepared.sql

The approved deployment procedure must capture the actual Cloudflare version/deployment, traffic, commit/tree, frozen artifact and readback results; prepare a record only after verification, review the generated metadata SQL, apply it with an authorized operator, then read back the matching ledger row. Failed/unconfirmed upload is not marked verified. Rollback is a new event, never rewriting history.

docs/admin-releases contains three verified historical records. P0 API/Collector digests refer to retained frozen Worker modules. The Admin digest refers explicitly to a historical asset-hash manifest verified during the prior deployment, not a claim that today's rebuilt bundle equals that version. Each evidence file records its provenance digest. Historical records are not proof of current traffic; the Admin matches their version IDs against Cloudflare before displaying a production SHA.

## Production sequence (requires immediate owner approval)

1. Fresh read-only checks: current deployed versions, existing settings/Access/bindings, private migration journal, observation counts/FKs/triggers, and the candidate/SQL digests. Confirm the only intended pending migration in this checkout is 0005. Stop if 0004 or another migration is unexpectedly pending.
2. Obtain approval for private 0005; apply only that reviewed migration and verify the ledger/index definitions, unchanged observations, foreign keys and immutable triggers. Existing Workers continue running at this point.
3. Obtain separate approval to upload/activate the frozen Collector candidate; preserve all existing runtime variables, bindings and three Crons. Verify the named AdminRead entrypoint, existing nonpublic exposure and scheduled configuration.
4. Obtain separate approval to upload/activate Admin with the single new service binding. Preserve Access, custom domain, read token and workers_dev/preview_urls=false. Verify authenticated GET pages and unauthenticated Access redirects.
5. Apply only approved, verified historical/new release metadata SQL and read back exact records. This is an operator procedure, not an Admin API write endpoint.

No public D1 migration or public API deploy is needed. Roll back Admin before removing its Collector entrypoint if necessary; keep the additive migration and immutable ledger. Confirm active versions before retrying uncertain uploads. Do not downgrade schema, delete history, replay collection or change source permissions.

## Verification

Run check, unit tests, offline preflight, workerd runtime tests, dry-run builds and source/OpenAPI regeneration. New tests exercise populated-0003 migration, strict read-only behavior, failures/expiry/revocation/private-only access, legacy slots, notifications, 125-row pagination, separate publication/derived counts, metadata ledger replay/conflicts, and the real named Service binding.

On this Windows workspace, set AI_APIS_TEMP_DIR to a short writable temporary directory for Miniflare. Esbuild needs access to ancestor configuration directories; a restricted-shell failure reading an ancestor is an environment failure, not a build success. Validate the ordinary unit suite and the RPC/workerd build checks with suitable local read permissions. Do not remove --dry-run to resolve local validation problems.
