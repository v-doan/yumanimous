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
  /** null while online; otherwise when the member's last socket closed (epoch ms). */
  disconnectedAt: number | null;
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

/** What an update callback returns: whether to persist, and a value to hand back. */
export interface UpdateDecision<T> {
  save: boolean;
  value: T;
}

/**
 * Persistence boundary. SessionService only ever changes a session through
 * `update`, which runs the change atomically: a lock in memory, a transaction with
 * `SELECT ... FOR UPDATE` in Postgres. The callback is synchronous on purpose, so no
 * I/O can happen while the session is locked.
 */
export interface SessionStore {
  get: (code: string) => Promise<StoredSession | undefined>;
  /** Inserts a new session; resolves false if the code is already taken. */
  create: (session: StoredSession) => Promise<boolean>;
  /**
   * Loads the latest state (undefined if the session doesn't exist), lets `change`
   * modify it, and persists it if `change` says so. Throwing aborts with no writes.
   */
  update: <T>(
    code: string,
    change: (session: StoredSession | undefined) => UpdateDecision<T>,
  ) => Promise<{ value: T; saved?: StoredSession }>;
  delete: (code: string) => Promise<void>;
  /** Codes of sessions not updated since `cutoff` (epoch ms). */
  idleSince: (cutoff: number) => Promise<string[]>;
  /** Members who have been offline since before `cutoff` (epoch ms). */
  disconnectedBefore: (cutoff: number) => Promise<{ code: string; memberId: string }[]>;
  /** On startup no member has a socket yet, so everyone starts offline as of `at`. */
  markAllDisconnected: (at: number) => Promise<void>;
  close: () => Promise<void>;
}

/**
 * Stores deep copies, so callers can't change stored state by accident and every
 * write goes through `update`, the same way a database would behave. Used by tests
 * and for running without Postgres.
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

  // No `await` between read and write, so this is atomic on Node's single thread.
  async update<T>(code: string, change: (s: StoredSession | undefined) => UpdateDecision<T>) {
    const current = this.sessions.get(code);
    const draft = current && structuredClone(current);
    const { save, value } = change(draft);
    if (save && draft) {
      this.sessions.set(code, structuredClone(draft));
      return { value, saved: draft };
    }
    return { value };
  }

  async delete(code: string) {
    this.sessions.delete(code);
  }

  async idleSince(cutoff: number) {
    return [...this.sessions.values()].filter((s) => s.updatedAt < cutoff).map((s) => s.code);
  }

  async disconnectedBefore(cutoff: number) {
    return [...this.sessions.values()].flatMap((s) =>
      s.members
        .filter((m) => m.disconnectedAt !== null && m.disconnectedAt < cutoff)
        .map((m) => ({ code: s.code, memberId: m.id })),
    );
  }

  async markAllDisconnected(at: number) {
    for (const session of this.sessions.values()) {
      for (const m of session.members) m.disconnectedAt ??= at;
    }
  }

  async close() {}
}
