-- /wrong and /missed reports about a brief. Never sent to the model or shown in a brief.
-- brief_id is the brief replied to, else the latest delivered one, else NULL.
CREATE TABLE core.feedback (
  id          BIGSERIAL PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('wrong', 'missed')),
  text        TEXT NOT NULL,
  brief_id    BIGINT NULL REFERENCES public.briefs(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ NULL
);
CREATE INDEX feedback_created_at_idx ON core.feedback (created_at);
