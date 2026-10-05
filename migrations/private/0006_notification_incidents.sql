-- Forward-only metadata. Existing pending rows retain their payload, state and attempts.
CREATE TABLE notification_incidents (activation_at TEXT NOT NULL,incident_key TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 0 CHECK(active IN (0,1)),revision INTEGER NOT NULL DEFAULT 0,last_condition TEXT NOT NULL,last_code TEXT NOT NULL,checked_at TEXT NOT NULL,last_notice_at TEXT,last_event_id TEXT,PRIMARY KEY(activation_at,incident_key));
ALTER TABLE notification_outbox ADD COLUMN activation_at TEXT;
ALTER TABLE notification_outbox ADD COLUMN incident_key TEXT;
ALTER TABLE notification_outbox ADD COLUMN event_kind TEXT;
CREATE INDEX notification_active_pending ON notification_outbox(activation_at,state,recorded_at);
