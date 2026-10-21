-- The focus suggestions shown with a brief, in button order: [{text, reason, findingId, repo}].
-- Focus buttons carry only the brief ID and a number, so the choice is looked up here.
ALTER TABLE briefs ADD COLUMN focus JSONB;
