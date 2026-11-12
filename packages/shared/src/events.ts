import { z } from 'zod';
import { SessionCodeSchema, type SessionView } from './session.js';
import type { SwipeInput } from './swipe.js';

/**
 * The Socket.io contract, shared by client and server so an event name or payload
 * typo is a compile error on both sides. Payloads are still validated with Zod on
 * the server, because types don't exist at runtime and clients are untrusted.
 */

/** Sent in the Socket.io handshake (`io(url, { auth })`). */
export const SocketAuthSchema = z.object({
  code: SessionCodeSchema,
  token: z.string().min(32).max(128),
});

export type SocketAuth = z.infer<typeof SocketAuthSchema>;

export type AckResult = { ok: true } | { ok: false; error: string };
export type Ack = (result: AckResult) => void;

export interface ClientToServerEvents {
  swipe: (input: SwipeInput, ack: Ack) => void;
  /** Host only: lobby -> swiping. */
  'session:start': (ack: Ack) => void;
  /** Leave for good: the member and their votes are removed. */
  'session:leave': (ack: Ack) => void;
}

export interface ServerToClientEvents {
  'session:state': (view: SessionView) => void;
  /** Fired once per new match, so clients can show the match screen exactly once. */
  'session:match': (match: { cardId: string }) => void;
  /** The session no longer exists, or this member was removed. Clear the stored token. */
  'session:ended': (reason: 'removed' | 'expired') => void;
}
