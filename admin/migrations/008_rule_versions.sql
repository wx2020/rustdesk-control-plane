CREATE TABLE IF NOT EXISTS policy_rule_versions (
  id BIGSERIAL PRIMARY KEY,
  rule_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  snapshot JSONB NOT NULL,
  actor TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (rule_id, version)
);

CREATE INDEX IF NOT EXISTS policy_rule_versions_rule_idx ON policy_rule_versions(rule_id, version DESC);
