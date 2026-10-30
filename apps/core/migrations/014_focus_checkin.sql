ALTER TABLE core.focus ADD COLUMN checkin TEXT CHECK (checkin IN ('done', 'partly', 'none'));
ALTER TABLE core.focus ADD COLUMN checkin_at TIMESTAMPTZ;

CREATE TABLE core.checkin_pending (
  chat_id TEXT PRIMARY KEY,
  expires_at TIMESTAMPTZ NOT NULL
);
