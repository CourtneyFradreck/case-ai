CREATE TABLE core.checkins (
  id BIGSERIAL PRIMARY KEY,
  date DATE NOT NULL UNIQUE,
  focus_id BIGINT REFERENCES core.focus(id),
  kind TEXT NOT NULL CHECK (kind IN ('focus', 'open')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'skipped', 'paused')),
  attempts INT NOT NULL DEFAULT 0,
  sent_at TIMESTAMPTZ,
  telegram_message_id BIGINT,
  answer TEXT CHECK (answer IN ('done', 'partly', 'none')),
  answered_at TIMESTAMPTZ,
  reason TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE core.pauses (
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (end_date >= start_date)
);
ALTER TABLE core.activity_logs ADD COLUMN focus_id BIGINT REFERENCES core.focus(id);
DROP TABLE core.checkin_pending;
