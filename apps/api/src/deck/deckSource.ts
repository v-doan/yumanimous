import {
  hasHardFilters,
  type Card,
  type GroupPreferences,
  type SessionMode,
} from '@yumanimous/shared';
import { staticRecipes } from './staticRecipes.js';

/**
 * Where a session's cards come from. Each mode (cook in, eat out, later travel)
 * implements this, so sessions, swiping and match rules never know which mode they
 * are in. Phase 6 adds an AI-curated source.
 */
export interface DeckSource {
  mode: SessionMode;
  /**
   * Builds a deck that satisfies every hard filter in `group` (or throws DeckError),
   * ranked by its soft preferences. No `group` means nobody has stated any rules.
   */
  buildDeck: (group?: GroupPreferences, context?: DeckBuildContext) => Promise<Card[]>;
  /**
   * Optional: a better order for cards nobody has swiped yet, as card ids, or null to
   * leave the deck alone. Only the AI source implements it.
   */
  rerank?: (input: { sessionCode: string; cards: Card[] }) => Promise<string[] | null>;
}

/** Who the deck is for, and a way to report progress while it's being built. */
export interface DeckBuildContext {
  sessionCode: string;
  onProgress?: (stage: DeckProgressStage) => void;
  /**
   * Blurbs that arrive after the deck was returned (card id -> blurb), already
   * cleaned. The AI source returns the deck as soon as the order is known, so the
   * group can start swiping while the writer is still writing.
   */
  onBlurbs?: (blurbs: Map<string, string>) => void;
  /**
   * Phase 8: cards shown in earlier rounds of this session. The new deck avoids them
   * while enough other safe cards exist (see `preferUnseen`).
   */
  excludeCardIds?: string[];
  /** Which round the deck is for (1 for the first deck). */
  round?: number;
}

/** Fewer unseen cards than this and a round would be too short: repeats are allowed. */
export const MIN_FRESH_CARDS = 5;

/**
 * The cards a new round may use: the ones nobody has seen yet, if there are enough;
 * otherwise everything (a short pool after several rounds beats no deck).
 */
export function preferUnseen(pool: Card[], exclude: ReadonlySet<string>): Card[] {
  const fresh = pool.filter((c) => !exclude.has(c.id));
  return fresh.length >= MIN_FRESH_CARDS ? fresh : pool;
}

/** Cards already seen go to the back of the deck (stable otherwise). */
export function seenLast(deck: Card[], exclude: ReadonlySet<string>): Card[] {
  return [...deck.filter((c) => !exclude.has(c.id)), ...deck.filter((c) => exclude.has(c.id))];
}

export type DeckProgressStage = 'scouting' | 'curating' | 'writing';

/** A deck can't be built. The message is shown to the host as-is. */
export class DeckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeckError';
  }
}

export const staticRecipeDeck: DeckSource = {
  mode: 'cook-in',
  buildDeck: async (group) => {
    // These recipes were never checked against diets or allergens, so serving them
    // to a group with hard rules could break someone's restriction. Refuse instead.
    if (group && hasHardFilters(group.hard)) {
      throw new DeckError(
        'The recipe service is unavailable, so the deck can’t be checked against the group’s food rules. Try again shortly.',
      );
    }
    // Copy so no session can mutate the shared constant.
    return staticRecipes.map((card) => ({ ...card, tags: [...card.tags] }));
  },
};
