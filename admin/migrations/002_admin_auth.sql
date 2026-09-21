ALTER TABLE managed_users ADD COLUMN IF NOT EXISTS password_hash TEXT;

CREATE INDEX IF NOT EXISTS managed_users_username_idx ON managed_users(username);
