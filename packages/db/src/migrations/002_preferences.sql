-- Phase 5: food rules per member, and which hard filters each deck was built with.

-- Confirmed rules only (the parsed chips the member kept), never the raw text they
-- typed. One row per member; deleted with the member, so leaving or being removed
-- from a session (or a saved group, Phase 8) also forgets their rules.
CREATE TABLE member_preferences (
  member_id   uuid PRIMARY KEY REFERENCES members (id) ON DELETE CASCADE,
  preferences jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- The hard filters (diets, intolerances, excluded ingredients, time) the current deck
-- was searched with. NULL until the host starts. Lets the app tell a late joiner
-- exactly which of their rules the deck was never checked against.
ALTER TABLE sessions ADD COLUMN deck_filters jsonb;
