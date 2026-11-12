-- Phase 3: sessions, members, swipes and matches, plus caches for external data.
-- Timestamps are timestamptz; the app works in epoch milliseconds and converts at the edge.

-- Cards shown in any session, whatever their source. `card` is the shared Card shape
-- (validated with CardSchema on read); `facts` keeps extra source data, like diet
-- flags, that later phases filter on.
CREATE TABLE cards (
  id         text PRIMARY KEY,
  source     text NOT NULL,
  card       jsonb NOT NULL,
  facts      jsonb NOT NULL DEFAULT '{}',
  fetched_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  code       text PRIMARY KEY,
  mode       text NOT NULL,
  match_rule text NOT NULL CHECK (match_rule IN ('everyone', 'majority')),
  status     text NOT NULL CHECK (status IN ('lobby', 'swiping')),
  -- No foreign key: members also reference sessions, and the host changes over time.
  -- SessionService guarantees host_id is always a current member.
  host_id    uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL
);

CREATE INDEX sessions_updated_at_idx ON sessions (updated_at);

-- The deck: a fixed, ordered list of cards chosen when the session is created.
CREATE TABLE session_cards (
  session_code text NOT NULL REFERENCES sessions (code) ON DELETE CASCADE,
  position     int  NOT NULL,
  card_id      text NOT NULL REFERENCES cards (id),
  PRIMARY KEY (session_code, position),
  UNIQUE (session_code, card_id)
);

CREATE TABLE members (
  id              uuid PRIMARY KEY,
  -- Join order. Host handoff picks the earliest member, and timestamps can tie.
  seq             bigserial NOT NULL,
  session_code    text NOT NULL REFERENCES sessions (code) ON DELETE CASCADE,
  name            text NOT NULL,
  token_hash      text NOT NULL UNIQUE,
  joined_at       timestamptz NOT NULL,
  -- NULL while online. Set when the last socket closes; the presence sweep
  -- removes members whose value is older than the grace period.
  disconnected_at timestamptz
);

-- Backstop for the service's "names are unique per session, ignoring case" rule.
CREATE UNIQUE INDEX members_session_name_idx ON members (session_code, lower(name));
CREATE INDEX members_disconnected_at_idx ON members (disconnected_at)
  WHERE disconnected_at IS NOT NULL;

CREATE TABLE swipes (
  -- Deleting a member deletes their votes: that's how "a member who leaves stops
  -- counting" is enforced, and how group memory (Phase 8) forgets a removed member.
  member_id    uuid NOT NULL REFERENCES members (id) ON DELETE CASCADE,
  session_code text NOT NULL REFERENCES sessions (code) ON DELETE CASCADE,
  card_id      text NOT NULL,
  direction    text NOT NULL CHECK (direction IN ('like', 'skip')),
  seq          bigserial NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- One vote per member per card. Inserts use ON CONFLICT DO NOTHING, so the first
  -- swipe wins even if application code had a bug.
  PRIMARY KEY (member_id, card_id)
);

CREATE INDEX swipes_session_idx ON swipes (session_code);

CREATE TABLE matches (
  session_code text NOT NULL REFERENCES sessions (code) ON DELETE CASCADE,
  card_id      text NOT NULL,
  matched_at   timestamptz NOT NULL,
  seq          bigserial NOT NULL,
  PRIMARY KEY (session_code, card_id)
);

-- Raw responses from external APIs, keyed by request. Lets us respect free-tier
-- quotas and never repeat a lookup while the entry is fresh.
CREATE TABLE api_cache (
  key        text PRIMARY KEY,
  response   jsonb NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
