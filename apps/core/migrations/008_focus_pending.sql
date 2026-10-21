-- Set by a "Something else" tap: the next plain text message from that chat becomes today's focus.
-- expires_at is the following midnight in Africa/Harare.
CREATE TABLE focus_pending (
  chat_id    TEXT PRIMARY KEY,
  brief_id   BIGINT REFERENCES briefs(id),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
