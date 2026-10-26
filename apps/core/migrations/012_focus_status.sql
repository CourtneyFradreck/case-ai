-- What became of a chosen focus, from the Done / Snooze buttons: active, done or snoozed.
-- A snoozed focus is no longer the day's focus, and its finding isn't suggested until status_until.
ALTER TABLE core.focus ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE core.focus ADD COLUMN status_until TIMESTAMPTZ;
