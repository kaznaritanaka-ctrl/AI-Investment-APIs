-- 0004 is reserved for the independent GPU/energy expansion.
-- Additive metadata only; no observation, policy or existing migration is changed.
CREATE TABLE admin_release_ledger (record_id TEXT PRIMARY KEY, worker TEXT NOT NULL, version_id TEXT NOT NULL, recorded_at TEXT NOT NULL, record_json TEXT NOT NULL);
CREATE INDEX admin_release_worker ON admin_release_ledger(worker,recorded_at DESC,record_id);
CREATE TRIGGER immutable_admin_release_update BEFORE UPDATE ON admin_release_ledger BEGIN SELECT RAISE(ABORT,'append-only release ledger'); END;
CREATE TRIGGER immutable_admin_release_delete BEFORE DELETE ON admin_release_ledger BEGIN SELECT RAISE(ABORT,'append-only release ledger'); END;
CREATE TRIGGER consistent_admin_release_insert BEFORE INSERT ON admin_release_ledger WHEN EXISTS(SELECT 1 FROM admin_release_ledger WHERE record_id=NEW.record_id AND record_json<>NEW.record_json) BEGIN SELECT RAISE(ABORT,'release record conflict'); END;
CREATE INDEX admin_runs_schedule ON collection_runs(scheduled_for DESC,source_id,run_id);
CREATE INDEX admin_observation_run ON observations(run_id,observation_id);
CREATE INDEX admin_summary_time ON daily_summaries(recorded_at DESC);
CREATE INDEX admin_quality_run ON quality_events(run_id,recorded_at,event_id);
CREATE INDEX admin_attempt_run ON fetch_attempts(run_id,id);
CREATE INDEX admin_model_member_catalog ON model_snapshot_members(catalog_observation_id);
CREATE INDEX admin_change_observation ON change_events(observation_id,observed_at DESC);
CREATE INDEX admin_model_event_observation ON model_events(observation_id,recorded_at DESC);
