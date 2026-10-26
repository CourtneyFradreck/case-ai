-- A name of at most 40 characters for each finding and chosen focus, e.g. "taga product branch".
-- Focus buttons and /focus show it; the full text stays in summary and item_text.
ALTER TABLE findings ADD COLUMN short_label TEXT;
ALTER TABLE core.focus ADD COLUMN short_label TEXT;
