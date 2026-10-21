-- Findings left out of the brief until `until`. High findings are never snoozed.
CREATE TABLE snoozes (
  finding_id TEXT PRIMARY KEY,
  repo       TEXT,
  until      TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- The medium and low attention items offered by a brief's "Snooze…" button, in list order:
-- [{findingId, repo, text}]. Snooze buttons carry only the brief ID and a number.
ALTER TABLE briefs ADD COLUMN snoozable JSONB;
