ALTER TABLE departments ADD COLUMN IF NOT EXISTS disabled BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS departments_disabled_idx ON departments(disabled);
