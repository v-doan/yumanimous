import type pg from 'pg';
import {
  CardSchema,
  HardFiltersSchema,
  MemberPreferencesSchema,
  type Card,
  type HardFilters,
  type MemberPreferences,
  type MatchRuleId,
  type SessionStatus,
  type Swipe,
} from '@yumanimous/shared';

/**
 * Read-only view of one session, loaded with fixed, parameterized queries. There is
 * no way to pass SQL in from a tool call: tools pick which of these functions runs,
 * and the session code is always a bound parameter.
 */
export interface SessionSnapshot {
  code: string;
  mode: string;
  matchRule: MatchRuleId;
  status: SessionStatus;
  hostId: string;
  deck: Card[];
  /** The hard filters the deck was built with; null in the lobby. */
  deckFilters: HardFilters | null;
  members: {
    id: string;
    name: string;
    online: boolean;
    /** Confirmed, enum-only rules. The text a member typed is never stored. */
    preferences: MemberPreferences | null;
  }[];
  swipes: Swipe[];
  matches: { cardId: string; matchedAt: string }[];
}

export async function loadSnapshot(
  pool: pg.Pool,
  code: string,
): Promise<SessionSnapshot | undefined> {
  // One REPEATABLE READ transaction, so all five queries see the same moment. Without
  // it, a swipe landing between two queries could make the tally disagree with itself.
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const snapshot = await readSnapshot(client, code);
    await client.query('COMMIT');
    return snapshot;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function readSnapshot(db: pg.PoolClient, code: string): Promise<SessionSnapshot | undefined> {
  const session = await db.query<{
    code: string;
    mode: string;
    match_rule: MatchRuleId;
    status: SessionStatus;
    host_id: string;
    deck_filters: unknown;
  }>('SELECT code, mode, match_rule, status, host_id, deck_filters FROM sessions WHERE code = $1', [
    code,
  ]);
  const row = session.rows[0];
  if (!row) return undefined;

  // Deliberately not selected: token_hash. Rejoin secrets never leave the API.
  const members = await db.query<{
    id: string;
    name: string;
    online: boolean;
    preferences: unknown;
  }>(
    `SELECT m.id, m.name, m.disconnected_at IS NULL AS online, p.preferences
     FROM members m LEFT JOIN member_preferences p ON p.member_id = m.id
     WHERE m.session_code = $1 ORDER BY m.seq`,
    [code],
  );
  const deck = await db.query<{ card: unknown }>(
    // The session's own copy of each card; the catalog for rows from before it existed.
    `SELECT COALESCE(sc.card, c.card) AS card
     FROM session_cards sc JOIN cards c ON c.id = sc.card_id
     WHERE sc.session_code = $1 ORDER BY sc.position`,
    [code],
  );
  const swipes = await db.query<{
    card_id: string;
    member_id: string;
    direction: Swipe['direction'];
  }>('SELECT card_id, member_id, direction FROM swipes WHERE session_code = $1 ORDER BY seq', [
    code,
  ]);
  const matches = await db.query<{ card_id: string; matched_at: Date }>(
    'SELECT card_id, matched_at FROM matches WHERE session_code = $1 ORDER BY seq',
    [code],
  );

  return {
    code: row.code,
    mode: row.mode,
    matchRule: row.match_rule,
    status: row.status,
    hostId: row.host_id,
    deck: deck.rows.map((r) => CardSchema.parse(r.card)),
    deckFilters: row.deck_filters === null ? null : HardFiltersSchema.parse(row.deck_filters),
    // jsonb is re-validated on read, like everything else that reaches a model.
    members: members.rows.map((m) => ({
      id: m.id,
      name: m.name,
      online: m.online,
      preferences: m.preferences === null ? null : MemberPreferencesSchema.parse(m.preferences),
    })),
    swipes: swipes.rows.map((s) => ({
      cardId: s.card_id,
      memberId: s.member_id,
      direction: s.direction,
    })),
    matches: matches.rows.map((m) => ({
      cardId: m.card_id,
      matchedAt: m.matched_at.toISOString(),
    })),
  };
}
