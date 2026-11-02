-- Repos are discovered from the token's owned repos; CASE_REPOS entries are 'manual'.
ALTER TABLE repos RENAME COLUMN added_at TO first_seen_at;
ALTER TABLE repos ADD COLUMN last_pushed_at TIMESTAMPTZ;
ALTER TABLE repos ADD COLUMN source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('discovered', 'manual'));
-- Set once the brief has said "New repo picked up". Repos read before discovery aren't new.
ALTER TABLE repos ADD COLUMN announced_at TIMESTAMPTZ;
UPDATE repos SET announced_at = now();
-- Branches as last read, with the pushed_at they were read at: reused until the repo is pushed to.
ALTER TABLE repos ADD COLUMN branch_cache JSONB;
