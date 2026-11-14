-- Phase 9: per-session caps. A deck rebuild costs an AI run, so a session may only
-- rebuild a few times (counted per session, across rounds).
ALTER TABLE sessions ADD COLUMN rebuilds int NOT NULL DEFAULT 0 CHECK (rebuilds >= 0);
