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
  buildDeck: (group?: GroupPreferences) => Promise<Card[]>;
}

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
