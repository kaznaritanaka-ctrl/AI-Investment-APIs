-- Private export coordination only. Existing history, authority and deadlines stay unchanged.
CREATE TABLE personal_daily_export_work (run_id TEXT PRIMARY KEY REFERENCES personal_daily_runs(run_id), projected_generation TEXT, projected_at TEXT, export_retry_after TEXT, projection_retry_after TEXT, failure_code TEXT CHECK(failure_code IN ('export_failed','projection_failed')));
CREATE INDEX personal_daily_projection ON personal_daily_export_work(projected_generation,projection_retry_after);
CREATE TABLE personal_daily_export_expiry (source_id TEXT NOT NULL, run_id TEXT NOT NULL REFERENCES personal_daily_runs(run_id), generation_day TEXT NOT NULL, expires_at TEXT NOT NULL, PRIMARY KEY(source_id,run_id,generation_day));
CREATE INDEX personal_daily_export_expiry_due ON personal_daily_export_expiry(source_id,expires_at);
