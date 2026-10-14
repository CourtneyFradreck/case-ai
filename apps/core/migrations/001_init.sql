CREATE TABLE repos (
  id             SERIAL PRIMARY KEY,
  full_name      TEXT UNIQUE NOT NULL,
  default_branch TEXT NOT NULL,
  private        BOOLEAN NOT NULL,
  active         BOOLEAN NOT NULL DEFAULT true,
  added_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE runs (
  id           BIGSERIAL PRIMARY KEY,
  source       TEXT NOT NULL,                    -- schedule | command
  window_start TIMESTAMPTZ NOT NULL,
  window_end   TIMESTAMPTZ NOT NULL,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at  TIMESTAMPTZ,
  status       TEXT NOT NULL DEFAULT 'running',  -- running | ok | partial | failed
  error        TEXT
);

CREATE TABLE events (
  id            BIGSERIAL PRIMARY KEY,
  repo_id       INT NOT NULL REFERENCES repos(id),
  type          TEXT NOT NULL,                   -- commit | pr | issue | branch | ci_run
  ref           TEXT NOT NULL,                   -- sha, number, branch name, workflow id
  title         TEXT,
  url           TEXT NOT NULL,
  occurred_at   TIMESTAMPTZ NOT NULL,
  raw           JSONB NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_run BIGINT REFERENCES runs(id),
  UNIQUE (repo_id, type, ref)
);
CREATE INDEX events_occurred_idx ON events (occurred_at);

CREATE TABLE findings (
  run_id   BIGINT NOT NULL REFERENCES runs(id),
  id       TEXT NOT NULL,
  rule     TEXT NOT NULL,
  severity TEXT NOT NULL,
  repo     TEXT NOT NULL,
  summary  TEXT NOT NULL,
  sources  JSONB NOT NULL,                       -- [{label, url}]
  PRIMARY KEY (run_id, id)
);

CREATE TABLE briefs (
  id            BIGSERIAL PRIMARY KEY,
  run_id        BIGINT NOT NULL REFERENCES runs(id),
  text          TEXT NOT NULL,
  model         TEXT,                            -- null until M2
  input_tokens  INT,
  output_tokens INT,
  json          JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);