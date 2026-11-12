import type {
  Card,
  Match,
  MatchRuleId,
  SessionMode,
  SessionStatus,
  Swipe,
} from '@yumanimous/shared';

export interface StoredMember {
  id: string;
  name: string;
  tokenHash: string;
  joinedAt: number;
  connected: boolean;
}

/** The server's private view of a session. `toView` strips secrets before broadcasting. */
export interface StoredSession {
  code: string;
  mode: SessionMode;
  matchRule: MatchRuleId;
  status: SessionStatus;
  hostId: string;
  deck: Card[];
  /** Ordered by join time; host handoff relies on that order. */
  members: StoredMember[];
  swipes: Swipe[];
  matches: Match[];
  updatedAt: number;
}

/**
 * Persistence boundary. Async on purpose, even for the in-memory version, so the
 * Phase 3 Postgres store drops in without touching SessionService.
 */
export interface SessionStore {
  get: (code: string) => Promise<StoredSession | undefined>;
  /** Inserts a new session; resolves false if the code is already taken. */
  create: (session: StoredSession) => Promise<boolean>;
  save: (session: StoredSession) => Promise<void>;
  delete: (code: string) => Promise<void>;
  /** Codes of sessions not updated since `cutoff` (epoch ms). */
  idleSince: (cutoff: number) => Promise<string[]>;
}

/**
 * Stores deep copies, so callers can't change stored state by accident and every
 * write goes through `save`, the same way a database would behave.
 */
export class InMemorySessionStore implements SessionStore {
  private sessions = new Map<string, StoredSession>();

  async get(code: string) {
    const session = this.sessions.get(code);
    return session && structuredClone(session);
  }

  async create(session: StoredSession) {
    if (this.sessions.has(session.code)) return false;
    this.sessions.set(session.code, structuredClone(session));
    return true;
  }

  async save(session: StoredSession) {
    this.sessions.set(session.code, structuredClone(session));
  }

  async delete(code: string) {
    this.sessions.delete(code);
  }

  async idleSince(cutoff: number) {
    return [...this.sessions.values()].filter((s) => s.updatedAt < cutoff).map((s) => s.code);
  }
}
