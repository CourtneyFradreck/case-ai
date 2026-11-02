CREATE TABLE core.activity_logs (
  id BIGSERIAL PRIMARY KEY,
  date DATE NOT NULL,
  text TEXT NOT NULL,
  tag TEXT,
  via TEXT NOT NULL CHECK (via IN ('command', 'checkin')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX activity_logs_date_idx ON core.activity_logs(date);
