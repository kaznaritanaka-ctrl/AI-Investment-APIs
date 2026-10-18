-- Local forward migration. Copy every 0007/0008 deadline verbatim; never upgrade an old run to until_revoked.
-- Rebuild only the research parent and its two children to make the normalized deadline nullable.
CREATE TABLE research_runs_v9 ( run_id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES research_sources(source_id), config_hash TEXT NOT NULL, query_hash TEXT NOT NULL, policy_version TEXT NOT NULL, terms_version TEXT NOT NULL, scheduled_for TEXT NOT NULL, recorded_at TEXT NOT NULL, synthetic INTEGER NOT NULL CHECK(synthetic IN (0,1)), state TEXT NOT NULL CHECK(state IN ('collecting','partial','complete','purging','purged')), next_page INTEGER CHECK(next_page >= 0), observation_count INTEGER NOT NULL DEFAULT 0, http_page_attempts INTEGER NOT NULL DEFAULT 0 CHECK(http_page_attempts BETWEEN 0 AND 3), last_error TEXT, retry_at TEXT, lease_token TEXT, lease_until TEXT, evidence_expires_at TEXT NOT NULL, evidence_purged_at TEXT, normalized_expires_at TEXT, retention_snapshot_json TEXT CHECK(retention_snapshot_json IS NULL OR json_valid(retention_snapshot_json)), all_copies_expires_at TEXT, deleted_at TEXT, backup_residual_until TEXT, normalized_mode TEXT NOT NULL DEFAULT 'fixed_days' CHECK(normalized_mode IN ('fixed_days','until_revoked')), CHECK((normalized_mode='fixed_days' AND normalized_expires_at IS NOT NULL) OR (normalized_mode='until_revoked' AND normalized_expires_at IS NULL AND all_copies_expires_at IS NULL AND retention_snapshot_json IS NOT NULL AND json_extract(retention_snapshot_json,'$.version') IS 'research-retention-v2' AND json_extract(retention_snapshot_json,'$.normalized_mode') IS 'until_revoked')) );
INSERT INTO research_runs_v9 SELECT *, 'fixed_days' FROM research_runs;
CREATE TABLE research_pages_v9 ( run_id TEXT NOT NULL REFERENCES research_runs_v9(run_id), page_number INTEGER NOT NULL, evidence_key TEXT NOT NULL UNIQUE, evidence_hash TEXT NOT NULL, observed_at TEXT NOT NULL, evidence_expires_at TEXT NOT NULL, evidence_deleted_at TEXT, reported_total INTEGER, received_count INTEGER NOT NULL, coverage TEXT NOT NULL CHECK(coverage IN ('complete','partial')), PRIMARY KEY(run_id,page_number) );
INSERT INTO research_pages_v9 SELECT * FROM research_pages;
CREATE TABLE research_observations_v9 ( observation_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES research_runs_v9(run_id), page_number INTEGER NOT NULL, record_key TEXT NOT NULL, source_url TEXT NOT NULL, method_version TEXT NOT NULL, observed_at TEXT NOT NULL, recorded_at TEXT NOT NULL, record_hash TEXT NOT NULL, previous_observation_id TEXT, change_kind TEXT NOT NULL CHECK(change_kind IN ('first_seen','reobserved','revised')), domain_json TEXT NOT NULL CHECK(json_valid(domain_json)), UNIQUE(run_id,record_key) );
INSERT INTO research_observations_v9 SELECT * FROM research_observations;
DROP TABLE research_observations;
DROP TABLE research_pages;
DROP TABLE research_runs;
ALTER TABLE research_runs_v9 RENAME TO research_runs;
ALTER TABLE research_pages_v9 RENAME TO research_pages;
ALTER TABLE research_observations_v9 RENAME TO research_observations;
CREATE INDEX research_runs_retention ON research_runs(normalized_expires_at,state);
CREATE INDEX research_runs_source ON research_runs(source_id,scheduled_for,state);
CREATE INDEX research_retention_source ON research_runs(source_id,state,normalized_expires_at);
CREATE UNIQUE INDEX research_one_run_per_day ON research_runs(source_id,substr(scheduled_for,1,10),synthetic);
CREATE INDEX research_records_key ON research_observations(record_key,observed_at);
CREATE TRIGGER research_observations_immutable BEFORE UPDATE ON research_observations BEGIN SELECT RAISE(ABORT,'immutable_research_observation'); END;
CREATE TRIGGER research_observations_retention BEFORE DELETE ON research_observations WHEN (SELECT state FROM research_runs WHERE run_id=OLD.run_id) != 'purging' BEGIN SELECT RAISE(ABORT,'research_retention_required'); END;
CREATE TRIGGER research_run_contract_immutable BEFORE UPDATE OF source_id,config_hash,policy_version,terms_version,recorded_at,scheduled_for,synthetic,evidence_expires_at,normalized_expires_at,normalized_mode,retention_snapshot_json,all_copies_expires_at ON research_runs BEGIN SELECT RAISE(ABORT,'immutable_research_retention'); END;
CREATE TABLE research_retention_assessments ( assessment_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES research_runs(run_id), assessed_at TEXT NOT NULL, config_hash TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('active','review_due','collection_stopped','rights_unknown','retention_expired','delete_required')), decision_json TEXT NOT NULL CHECK(json_valid(decision_json)) );
CREATE INDEX research_retention_assessment_run ON research_retention_assessments(run_id,assessed_at);
CREATE TRIGGER research_retention_assessments_immutable BEFORE UPDATE ON research_retention_assessments BEGIN SELECT RAISE(ABORT,'immutable_research_assessment'); END;
