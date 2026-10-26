-- Set when a quiet morning sent a short message instead of the full brief in `text`.
ALTER TABLE briefs ADD COLUMN sent_text TEXT;
