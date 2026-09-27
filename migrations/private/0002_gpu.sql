-- D1 keeps foreign keys enabled. Defer only across this table rebuild.
PRAGMA defer_foreign_keys=ON;
CREATE TABLE observations_v2 (observation_id TEXT PRIMARY KEY, source_id TEXT NOT NULL, policy_version TEXT NOT NULL, run_id TEXT NOT NULL REFERENCES collection_runs, dataset TEXT NOT NULL CHECK(dataset IN ('fx','ai_api_prices','gpu_rental','gpu_secondary')), entity_key TEXT NOT NULL, observed_at TEXT NOT NULL, recorded_at TEXT NOT NULL, fingerprint TEXT NOT NULL, parser_version TEXT NOT NULL, quality_status TEXT NOT NULL, supersedes_observation_id TEXT REFERENCES observations_v2, metadata_json TEXT NOT NULL, UNIQUE(run_id,entity_key,parser_version,policy_version,fingerprint));
INSERT INTO observations_v2 SELECT * FROM observations;
DROP TABLE observations;
ALTER TABLE observations_v2 RENAME TO observations;
CREATE INDEX observation_series ON observations(source_id,entity_key,observed_at DESC,recorded_at DESC);
CREATE INDEX observation_content ON observations(source_id,entity_key,fingerprint,recorded_at);
CREATE TRIGGER immutable_observations BEFORE UPDATE ON observations BEGIN SELECT RAISE(ABORT,'append-only observations'); END;
PRAGMA defer_foreign_keys=OFF;
CREATE TABLE gpu_snapshots (snapshot_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES collection_runs, source_id TEXT NOT NULL, policy_version TEXT NOT NULL, dataset TEXT NOT NULL, partition_id TEXT NOT NULL, scope_hash TEXT NOT NULL, scope_json TEXT NOT NULL, state TEXT NOT NULL, reason TEXT, started_at TEXT NOT NULL, completed_at TEXT, next_page INTEGER DEFAULT 0, reported_total INTEGER, received_count INTEGER NOT NULL DEFAULT 0, duplicate_count INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT, lease_token TEXT, lease_until TEXT, data_origin TEXT NOT NULL, processing_stage TEXT NOT NULL DEFAULT 'pages', finalize_cursor TEXT NOT NULL DEFAULT '', UNIQUE(run_id,partition_id));
CREATE INDEX gpu_snapshot_scope ON gpu_snapshots(source_id,scope_hash,state,completed_at DESC);
CREATE TABLE gpu_pages (snapshot_id TEXT NOT NULL REFERENCES gpu_snapshots, page_number INTEGER NOT NULL, artifact_ref TEXT NOT NULL, state TEXT NOT NULL, observed_at TEXT NOT NULL, next_page INTEGER, received_count INTEGER NOT NULL, reported_total INTEGER, payload_hash TEXT NOT NULL, PRIMARY KEY(snapshot_id,page_number));
CREATE TABLE gpu_rental (observation_id TEXT PRIMARY KEY REFERENCES observations, gpu_sku_id TEXT, provider TEXT NOT NULL, region TEXT, currency TEXT NOT NULL, amount_decimal TEXT, amount_sort TEXT, cohort_key TEXT NOT NULL, domain_json TEXT NOT NULL);
CREATE TABLE gpu_secondary (observation_id TEXT PRIMARY KEY REFERENCES observations, gpu_sku_id TEXT, marketplace TEXT NOT NULL, listing_id TEXT NOT NULL, currency TEXT NOT NULL, amount_decimal TEXT, amount_sort TEXT, cohort_key TEXT NOT NULL, domain_json TEXT NOT NULL);
CREATE INDEX gpu_rental_cohort ON gpu_rental(cohort_key,amount_sort);
CREATE INDEX gpu_secondary_cohort ON gpu_secondary(cohort_key,amount_sort);
CREATE TRIGGER immutable_gpu_rental BEFORE UPDATE ON gpu_rental BEGIN SELECT RAISE(ABORT,'append-only GPU rental'); END;
CREATE TRIGGER immutable_gpu_secondary BEFORE UPDATE ON gpu_secondary BEGIN SELECT RAISE(ABORT,'append-only GPU secondary'); END;
CREATE TABLE gpu_snapshot_members (snapshot_id TEXT NOT NULL REFERENCES gpu_snapshots, record_key TEXT NOT NULL, observation_id TEXT NOT NULL REFERENCES observations, page_number INTEGER NOT NULL, cohort_key TEXT NOT NULL, eligible INTEGER NOT NULL, exclusion_json TEXT NOT NULL, PRIMARY KEY(snapshot_id,record_key));
CREATE INDEX gpu_members_cohort ON gpu_snapshot_members(snapshot_id,cohort_key,eligible,record_key);
CREATE TABLE gpu_lifecycle_events (event_id TEXT PRIMARY KEY, snapshot_id TEXT NOT NULL REFERENCES gpu_snapshots, previous_observation_id TEXT NOT NULL REFERENCES observations, record_key TEXT NOT NULL, state TEXT NOT NULL CHECK(state='not_seen'), observed_at TEXT NOT NULL, recorded_at TEXT NOT NULL);
CREATE TABLE gpu_metric_jobs (snapshot_id TEXT NOT NULL REFERENCES gpu_snapshots, cohort_key TEXT NOT NULL, metric_id TEXT NOT NULL, state TEXT NOT NULL, PRIMARY KEY(snapshot_id,cohort_key));
CREATE TABLE gpu_metric_lineage (metric_id TEXT NOT NULL REFERENCES derived_observations, input_snapshot_id TEXT REFERENCES gpu_snapshots, input_observation_id TEXT REFERENCES observations, source_id TEXT NOT NULL, policy_version TEXT NOT NULL, input_key TEXT NOT NULL, PRIMARY KEY(metric_id,input_key));

ALTER TABLE collection_runs ADD COLUMN last_progress_at TEXT;
ALTER TABLE gpu_snapshots ADD COLUMN revises_snapshot_id TEXT REFERENCES gpu_snapshots;
ALTER TABLE gpu_snapshots ADD COLUMN review_ref TEXT;
ALTER TABLE gpu_pages ADD COLUMN evidence_hash TEXT NOT NULL DEFAULT '';
