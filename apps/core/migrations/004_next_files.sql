-- NEXT.md state per repo as of the last run that could read the repo.
CREATE TABLE next_files (
  repo                TEXT PRIMARY KEY,
  sha                 TEXT,                         -- null while the repo has no NEXT.md
  run_id              BIGINT REFERENCES runs(id),   -- last run that read the file or found it missing
  missing_reported_at TIMESTAMPTZ                   -- set once next_missing has fired for the repo
);
