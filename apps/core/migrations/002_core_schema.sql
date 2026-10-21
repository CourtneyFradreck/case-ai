-- Shared ALFRED data lives in the core schema. CASE-only tables stay in public.
-- activity_logs (M4) and feedback (M5) belong here too, because ALFRED will reuse them.
CREATE SCHEMA IF NOT EXISTS core;

CREATE TABLE core.focus (
  id         BIGSERIAL PRIMARY KEY,
  date       DATE NOT NULL,
  item_text  TEXT NOT NULL,
  finding_id TEXT,
  repo       TEXT,
  chosen_via TEXT NOT NULL CHECK (chosen_via IN ('button', 'text', 'command')),
  brief_id   BIGINT REFERENCES public.briefs(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX focus_date_idx ON core.focus (date);
