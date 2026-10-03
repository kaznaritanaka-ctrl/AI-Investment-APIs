ALTER TABLE published_observations ADD COLUMN model_snapshot_id TEXT;
CREATE INDEX public_model_snapshot ON published_observations(model_snapshot_id,seq);
CREATE TABLE published_model_snapshots (snapshot_id TEXT PRIMARY KEY, batch_id TEXT NOT NULL REFERENCES publication_batches, source_id TEXT NOT NULL, policy_version TEXT NOT NULL, scope_hash TEXT NOT NULL, observed_at TEXT NOT NULL, recorded_at TEXT NOT NULL, completed_at TEXT, state TEXT NOT NULL, expires_at TEXT NOT NULL, public_json TEXT NOT NULL);
CREATE INDEX published_models_scope ON published_model_snapshots(source_id,scope_hash,state,observed_at DESC,completed_at DESC);
CREATE TABLE published_model_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, snapshot_id TEXT NOT NULL REFERENCES published_model_snapshots, observation_id TEXT, previous_observation_id TEXT, observed_at TEXT NOT NULL, recorded_at TEXT NOT NULL, public_json TEXT NOT NULL);
CREATE INDEX public_model_events ON published_model_events(snapshot_id,seq);
