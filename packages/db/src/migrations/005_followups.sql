-- Phase 7: what happens after the group decides.

-- One shopping list per matched (or accepted) recipe. Stored as one JSON document:
-- it is small (<= 60 lines), always read and written whole, and re-validated with
-- Zod on load like cards are.
CREATE TABLE shopping_lists (
  session_code text NOT NULL REFERENCES sessions (code) ON DELETE CASCADE,
  card_id      text NOT NULL,
  list         jsonb NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_code, card_id)
);

-- The mediator's compromise when nothing matched, and when it was started (it runs
-- once per deck, like the re-rank).
ALTER TABLE sessions ADD COLUMN suggestion jsonb;
ALTER TABLE sessions ADD COLUMN mediated_at timestamptz;

-- New kinds of AI run in the cost log.
ALTER TABLE ai_calls DROP CONSTRAINT ai_calls_kind_check;
ALTER TABLE ai_calls ADD CONSTRAINT ai_calls_kind_check
  CHECK (kind IN ('deck', 'rerank', 'smoke', 'shopping', 'mediator'));
