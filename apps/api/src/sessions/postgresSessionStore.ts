import type pg from 'pg';
import {
  CardSchema,
  HardFiltersSchema,
  MemberPreferencesSchema,
  type Card,
  type Match,
  type MatchRuleId,
  type SessionMode,
  type SessionStatus,
  type Swipe,
} from '@yumanimous/shared';
import type { SessionStore, StoredMember, StoredSession, UpdateDecision } from './sessionStore.js';

type Queryable = pg.Pool | pg.PoolClient;

const toDate = (ms: number) => new Date(ms);
const toMs = (d: Date | null) => (d === null ? null : d.getTime());

/**
 * Postgres-backed sessions. A session is loaded as a whole (it's small: <= 10
 * members, a 10-card deck), changed in memory by SessionService, and written back
 * as a diff (only new or changed rows) inside one transaction.
 */
export class PostgresSessionStore implements SessionStore {
  constructor(private readonly pool: pg.Pool) {}

  async get(code: string) {
    return load(this.pool, code, false);
  }

  async create(session: StoredSession) {
    return this.transaction(async (db) => {
      const inserted = await db.query(
        `INSERT INTO sessions (code, mode, match_rule, status, host_id, deck_filters, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (code) DO NOTHING`,
        [
          session.code,
          session.mode,
          session.matchRule,
          session.status,
          session.hostId,
          session.deckFilters,
          toDate(session.updatedAt),
        ],
      );
      if (inserted.rowCount === 0) return false; // Code already taken.

      await writeDeck(db, session.code, session.deck);
      for (const member of session.members) await insertMember(db, session.code, member);
      return true;
    });
  }

  async update<T>(code: string, change: (s: StoredSession | undefined) => UpdateDecision<T>) {
    return this.transaction(async (db) => {
      // FOR UPDATE holds the session row until commit, so a second API process
      // updating the same session waits instead of overwriting this change.
      const before = await load(db, code, true);
      const draft = before && structuredClone(before);
      const { save, value } = change(draft);
      if (!save || !before || !draft) return { value };
      await persistDiff(db, before, draft);
      return { value, saved: draft };
    });
  }

  async delete(code: string) {
    await this.pool.query('DELETE FROM sessions WHERE code = $1', [code]);
  }

  async idleSince(cutoff: number) {
    const { rows } = await this.pool.query<{ code: string }>(
      'SELECT code FROM sessions WHERE updated_at < $1',
      [toDate(cutoff)],
    );
    return rows.map((r) => r.code);
  }

  async disconnectedBefore(cutoff: number) {
    const { rows } = await this.pool.query<{ code: string; id: string }>(
      'SELECT session_code AS code, id FROM members WHERE disconnected_at < $1',
      [toDate(cutoff)],
    );
    return rows.map((r) => ({ code: r.code, memberId: r.id }));
  }

  async markAllDisconnected(at: number) {
    await this.pool.query('UPDATE members SET disconnected_at = $1 WHERE disconnected_at IS NULL', [
      toDate(at),
    ]);
  }

  /** The pool belongs to whoever created it (createServer), so it isn't ended here. */
  async close() {}

  private async transaction<T>(fn: (db: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}

/** Card ids look like `spoonacular:715538`; hard-coded ones have no prefix. */
const cardSource = (id: string) => (id.includes(':') ? id.split(':')[0]! : 'static');

async function load(db: Queryable, code: string, forUpdate: boolean) {
  const session = await db.query<{
    code: string;
    mode: SessionMode;
    match_rule: MatchRuleId;
    status: SessionStatus;
    host_id: string;
    deck_filters: unknown;
    reranked_at: Date | null;
    updated_at: Date;
  }>(`SELECT * FROM sessions WHERE code = $1 ${forUpdate ? 'FOR UPDATE' : ''}`, [code]);
  const row = session.rows[0];
  if (!row) return undefined;

  // Sequential, not Promise.all: inside a transaction these share one connection,
  // which runs one query at a time anyway (and pg@9 will reject overlapping calls).
  const deck = await db.query<{ card: unknown }>(
    // The session's own copy of each card (with its AI blurb); the shared catalog
    // only for rows written before migration 004.
    `SELECT COALESCE(sc.card, c.card) AS card
       FROM session_cards sc JOIN cards c ON c.id = sc.card_id
       WHERE sc.session_code = $1 ORDER BY sc.position`,
    [code],
  );
  const members = await db.query<{
    id: string;
    name: string;
    token_hash: string;
    joined_at: Date;
    disconnected_at: Date | null;
    preferences: unknown;
  }>(
    `SELECT m.id, m.name, m.token_hash, m.joined_at, m.disconnected_at, p.preferences
       FROM members m LEFT JOIN member_preferences p ON p.member_id = m.id
       WHERE m.session_code = $1 ORDER BY m.seq`,
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

  const stored: StoredSession = {
    code: row.code,
    mode: row.mode,
    matchRule: row.match_rule,
    status: row.status,
    hostId: row.host_id,
    // jsonb comes back as plain JSON; re-validate so a bad row can't reach clients.
    deck: deck.rows.map((r) => CardSchema.parse(r.card)),
    deckFilters: row.deck_filters === null ? null : HardFiltersSchema.parse(row.deck_filters),
    rerankedAt: toMs(row.reranked_at),
    members: members.rows.map((m) => ({
      id: m.id,
      name: m.name,
      tokenHash: m.token_hash,
      joinedAt: m.joined_at.getTime(),
      disconnectedAt: toMs(m.disconnected_at),
      preferences: m.preferences === null ? null : MemberPreferencesSchema.parse(m.preferences),
    })),
    swipes: swipes.rows.map((s) => ({
      cardId: s.card_id,
      memberId: s.member_id,
      direction: s.direction,
    })),
    matches: matches.rows.map((m): Match => ({
      cardId: m.card_id,
      matchedAt: m.matched_at.getTime(),
    })),
    updatedAt: row.updated_at.getTime(),
  };
  return stored;
}

async function writeDeck(db: Queryable, code: string, deck: Card[]) {
  for (const [position, card] of deck.entries()) {
    // The deck source may already have cached this card (with its facts); that row wins.
    await db.query(
      `INSERT INTO cards (id, source, card) VALUES ($1, $2, $3)
       ON CONFLICT (id) DO NOTHING`,
      [card.id, cardSource(card.id), card],
    );
    await db.query(
      'INSERT INTO session_cards (session_code, position, card_id, card) VALUES ($1, $2, $3, $4)',
      [code, position, card.id, card],
    );
  }
}

async function insertMember(db: Queryable, code: string, m: StoredMember) {
  await db.query(
    `INSERT INTO members (id, session_code, name, token_hash, joined_at, disconnected_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      m.id,
      code,
      m.name,
      m.tokenHash,
      toDate(m.joinedAt),
      m.disconnectedAt === null ? null : toDate(m.disconnectedAt),
    ],
  );
  if (m.preferences) await writePreferences(db, m);
}

async function writePreferences(db: Queryable, m: StoredMember) {
  if (m.preferences === null) {
    await db.query('DELETE FROM member_preferences WHERE member_id = $1', [m.id]);
    return;
  }
  await db.query(
    `INSERT INTO member_preferences (member_id, preferences, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (member_id) DO UPDATE
       SET preferences = excluded.preferences, updated_at = excluded.updated_at`,
    [m.id, m.preferences],
  );
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Writes only what changed between two versions of a session. */
async function persistDiff(db: pg.PoolClient, before: StoredSession, after: StoredSession) {
  await db.query(
    `UPDATE sessions SET status = $2, host_id = $3, match_rule = $4, deck_filters = $5,
       reranked_at = $6, updated_at = $7 WHERE code = $1`,
    [
      after.code,
      after.status,
      after.hostId,
      after.matchRule,
      after.deckFilters,
      after.rerankedAt === null ? null : toDate(after.rerankedAt),
      toDate(after.updatedAt),
    ],
  );

  // A new deck (the start, or a host rebuild) replaces the old one wholesale.
  // Compared by content, not just ids: a re-rank changes the order, and blurbs can
  // arrive after the deck (both must be written).
  if (!sameJson(before.deck, after.deck)) {
    await db.query('DELETE FROM session_cards WHERE session_code = $1', [after.code]);
    await writeDeck(db, after.code, after.deck);
  }

  const beforeMembers = new Map(before.members.map((m) => [m.id, m]));
  const afterIds = new Set(after.members.map((m) => m.id));

  for (const m of before.members) {
    // Cascades to the member's swipes and preferences.
    if (!afterIds.has(m.id)) await db.query('DELETE FROM members WHERE id = $1', [m.id]);
  }
  for (const m of after.members) {
    const old = beforeMembers.get(m.id);
    if (!old) {
      await insertMember(db, after.code, m);
      continue;
    }
    if (old.disconnectedAt !== m.disconnectedAt || old.name !== m.name) {
      await db.query('UPDATE members SET disconnected_at = $2, name = $3 WHERE id = $1', [
        m.id,
        m.disconnectedAt === null ? null : toDate(m.disconnectedAt),
        m.name,
      ]);
    }
    if (!sameJson(old.preferences, m.preferences)) await writePreferences(db, m);
  }

  const swipeKey = (s: Swipe) => `${s.memberId}|${s.cardId}`;
  const oldSwipes = new Set(before.swipes.map(swipeKey));
  const newSwipes = new Set(after.swipes.map(swipeKey));
  // Votes removed other than by a member leaving: a deck rebuild clears them all.
  for (const s of before.swipes) {
    if (!newSwipes.has(swipeKey(s)) && afterIds.has(s.memberId)) {
      await db.query('DELETE FROM swipes WHERE member_id = $1 AND card_id = $2', [
        s.memberId,
        s.cardId,
      ]);
    }
  }
  for (const s of after.swipes) {
    if (oldSwipes.has(swipeKey(s)) || !afterIds.has(s.memberId)) continue;
    await db.query(
      `INSERT INTO swipes (member_id, session_code, card_id, direction) VALUES ($1, $2, $3, $4)
       ON CONFLICT (member_id, card_id) DO NOTHING`,
      [s.memberId, after.code, s.cardId, s.direction],
    );
  }

  const oldMatches = new Set(before.matches.map((m) => m.cardId));
  const newMatches = new Set(after.matches.map((m) => m.cardId));
  for (const cardId of oldMatches) {
    if (!newMatches.has(cardId)) {
      await db.query('DELETE FROM matches WHERE session_code = $1 AND card_id = $2', [
        after.code,
        cardId,
      ]);
    }
  }
  for (const m of after.matches) {
    if (oldMatches.has(m.cardId)) continue;
    await db.query(
      `INSERT INTO matches (session_code, card_id, matched_at) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [after.code, m.cardId, toDate(m.matchedAt)],
    );
  }
}
