-- One row per NEXT.md item ever seen. Items that leave the file keep their row; last_seen stops moving.
CREATE TABLE next_items (
  repo               TEXT NOT NULL,
  item_id            TEXT NOT NULL,
  text               TEXT NOT NULL,
  section            TEXT,
  state              TEXT NOT NULL CHECK (state IN ('open', 'done')),
  first_seen         TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen          TIMESTAMPTZ NOT NULL DEFAULT now(),
  section_changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_run_id        BIGINT REFERENCES runs(id),
  previous_ids       JSONB NOT NULL DEFAULT '[]',     -- item IDs this item had before its wording was edited
  PRIMARY KEY (repo, item_id)
);
