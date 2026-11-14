import { z } from 'zod';
import { SessionCodeSchema, type SessionView } from './session.js';
import type { MemberPreferences } from './preferences.js';
import type { SwipeInput } from './swipe.js';
import type { CreateShoppingList, SetShoppingServings, ToggleShoppingLine } from './followUps.js';

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

export type DeckProgressStage = 'scouting' | 'curating' | 'writing' | 'reranked';

export type AckResult = { ok: true } | { ok: false; error: string };
export type Ack = (result: AckResult) => void;

export interface ClientToServerEvents {
  swipe: (input: SwipeInput, ack: Ack) => void;
  /** Host only: lobby -> swiping. */
  'session:start': (ack: Ack) => void;
  /** Save this member's confirmed food rules (validated again on the server). */
  'preferences:set': (preferences: MemberPreferences, ack: Ack) => void;
  /**
   * Host only, while swiping: rebuild the deck with everyone's current rules. Clears
   * all votes and matches, because they were cast on a different deck.
   */
  'session:rebuild': (ack: Ack) => void;
  /** Leave for good: the member and their votes are removed. */
  'session:leave': (ack: Ack) => void;
  /**
   * Anyone, for a matched (or accepted) recipe: make its shopping list for this many
   * servings. One list per card; a second request joins the one being made.
   */
  'shopping:create': (input: CreateShoppingList, ack: Ack) => void;
  /** "We have it" on one line, for everyone. */
  'shopping:toggle': (input: ToggleShoppingLine, ack: Ack) => void;
  /** Rescale an existing list. Pure arithmetic on the server: no AI call. */
  'shopping:servings': (input: SetShoppingServings, ack: Ack) => void;
  /** Anyone: "Go with it" on the mediator's suggestion. */
  'suggestion:accept': (ack: Ack) => void;
}

export interface ServerToClientEvents {
  'session:state': (view: SessionView) => void;
  /**
   * Deck-building progress while the host's Start is running ("scouting recipes…"),
   * and "reranked" when the rest of the deck was reordered from the group's swipes.
   */
  'deck:progress': (progress: { stage: DeckProgressStage }) => void;
  /** Fired once per new match, so clients can show the match screen exactly once. */
  'session:match': (match: { cardId: string }) => void;
  /** The session no longer exists, or this member was removed. Clear the stored token. */
  'session:ended': (reason: 'removed' | 'expired') => void;
}
