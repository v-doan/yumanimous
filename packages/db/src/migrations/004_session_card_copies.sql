-- Phase 6 fix: each session keeps its own copy of every card as it was dealt.
--
-- `cards` is a shared catalog (one row per recipe, written once). A session's card
-- can differ from it: the AI writer gives each session its own blurbs. Before this,
-- the session only stored a reference, so those blurbs were lost on the next load.
-- NULL for rows written before this migration; reads fall back to the catalog then.
ALTER TABLE session_cards ADD COLUMN card jsonb;
