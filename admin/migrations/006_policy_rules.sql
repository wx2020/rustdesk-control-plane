ALTER TABLE devices ADD COLUMN IF NOT EXISTS tags JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE TABLE IF NOT EXISTS policy_rules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('register', 'connect', 'relay', 'force_relay')),
  effect TEXT NOT NULL CHECK (effect IN ('allow', 'deny', 'force_relay')),
  device_id TEXT REFERENCES devices(id) ON DELETE CASCADE,
  group_id TEXT REFERENCES device_groups(id) ON DELETE CASCADE,
  tag TEXT,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  priority INTEGER NOT NULL DEFAULT 100,
  description TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS policy_rules_enabled_priority_idx ON policy_rules(enabled, priority);
CREATE INDEX IF NOT EXISTS devices_tags_idx ON devices USING GIN(tags);
