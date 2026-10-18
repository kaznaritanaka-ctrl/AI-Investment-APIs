-- Local-only follow-up to 0007. No existing payload expiry is extended or approved.
CREATE TABLE research_config_versions ( config_hash TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES research_sources(source_id), policy_version TEXT NOT NULL, registered_at TEXT NOT NULL, config_json TEXT NOT NULL CHECK(json_valid(config_json)), UNIQUE(source_id,policy_version) );
CREATE TRIGGER research_config_versions_immutable BEFORE UPDATE ON research_config_versions BEGIN SELECT RAISE(ABORT,'immutable_research_config'); END;
ALTER TABLE research_runs ADD COLUMN retention_snapshot_json TEXT CHECK(retention_snapshot_json IS NULL OR json_valid(retention_snapshot_json));
ALTER TABLE research_runs ADD COLUMN all_copies_expires_at TEXT;
ALTER TABLE research_runs ADD COLUMN deleted_at TEXT;
ALTER TABLE research_runs ADD COLUMN backup_residual_until TEXT;
CREATE TRIGGER research_run_contract_immutable BEFORE UPDATE OF source_id,config_hash,policy_version,terms_version,recorded_at,scheduled_for,synthetic,evidence_expires_at,normalized_expires_at,retention_snapshot_json,all_copies_expires_at ON research_runs BEGIN SELECT RAISE(ABORT,'immutable_research_retention'); END;
CREATE INDEX research_retention_source ON research_runs(source_id,state,normalized_expires_at);
