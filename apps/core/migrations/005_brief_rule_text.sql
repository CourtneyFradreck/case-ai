-- The rule-only render of every brief, kept even when the model brief is the one sent.
ALTER TABLE briefs ADD COLUMN rule_text TEXT;
