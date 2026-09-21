ALTER TABLE sessions ADD COLUMN IF NOT EXISTS session_key TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS transport TEXT NOT NULL DEFAULT 'relay';
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS source_ip TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

UPDATE sessions SET status = CASE WHEN ended_at IS NULL THEN 'active' ELSE 'ended' END WHERE status IS NULL OR status = '';

CREATE UNIQUE INDEX IF NOT EXISTS sessions_session_key_idx ON sessions(session_key);
CREATE INDEX IF NOT EXISTS sessions_status_idx ON sessions(status);

CREATE TABLE IF NOT EXISTS communication_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  device_id TEXT REFERENCES devices(id) ON DELETE SET NULL,
  target_rustdesk_id TEXT NOT NULL,
  session_key TEXT,
  source_ip TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS communication_events_device_created_idx ON communication_events(device_id, created_at DESC);
CREATE INDEX IF NOT EXISTS communication_events_session_key_idx ON communication_events(session_key);
