-- Phase 6: every AI run is logged with its cost, and the monthly budget is read
-- from this table.

CREATE TABLE ai_calls (
  id                 bigserial PRIMARY KEY,
  -- No foreign key on purpose: idle sessions are deleted after a day, but what they
  -- cost must stay on the books for the monthly budget.
  session_code       text,
  kind               text NOT NULL CHECK (kind IN ('deck', 'rerank', 'smoke')),
  model              text NOT NULL,
  -- ok: AI result used. fallback: AI ran but its output was unusable, so the
  -- non-AI deck was used. error: the run failed. skipped: budget reached, no run.
  status             text NOT NULL CHECK (status IN ('ok', 'fallback', 'error', 'skipped')),
  -- The Agent SDK's estimate; the Console bill is the source of truth.
  cost_usd           numeric(10, 6) NOT NULL DEFAULT 0,
  input_tokens       integer NOT NULL DEFAULT 0,
  output_tokens      integer NOT NULL DEFAULT 0,
  cache_read_tokens  integer NOT NULL DEFAULT 0,
  cache_write_tokens integer NOT NULL DEFAULT 0,
  duration_ms        integer NOT NULL DEFAULT 0,
  num_turns          integer NOT NULL DEFAULT 0,
  error              text,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ai_calls_created_at_idx ON ai_calls (created_at);
CREATE INDEX ai_calls_session_idx ON ai_calls (session_code);

-- The re-rank runs at most once per session; this records that it happened.
ALTER TABLE sessions ADD COLUMN reranked_at timestamptz;
