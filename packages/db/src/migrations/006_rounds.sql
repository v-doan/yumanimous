-- Phase 8: "Play again". A session can run several rounds with the same people.
-- Earlier rounds (cards, votes, decision) are kept so the next deck can learn from
-- them, and are deleted with the session: nothing outlives it (no saved groups).
-- One small JSON array (<= 5 rounds), re-validated with Zod on load.
ALTER TABLE sessions ADD COLUMN round int NOT NULL DEFAULT 1 CHECK (round > 0);
ALTER TABLE sessions ADD COLUMN past_rounds jsonb NOT NULL DEFAULT '[]';
