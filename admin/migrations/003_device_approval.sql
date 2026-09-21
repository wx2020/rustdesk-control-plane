ALTER TABLE devices ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'approved';

UPDATE devices SET status = CASE WHEN disabled THEN 'disabled' ELSE 'approved' END WHERE status IS NULL OR status = '';

ALTER TABLE devices DROP CONSTRAINT IF EXISTS devices_status_check;
ALTER TABLE devices ADD CONSTRAINT devices_status_check CHECK (status IN ('pending', 'approved', 'rejected', 'disabled'));

CREATE INDEX IF NOT EXISTS devices_status_idx ON devices(status);
