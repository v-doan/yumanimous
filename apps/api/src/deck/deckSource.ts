import type { Card, SessionMode } from '@yumanimous/shared';
import { staticRecipes } from './staticRecipes.js';

/**
 * Where a session's cards come from. Each mode (cook in, eat out, later travel)
 * implements this, so sessions, swiping and match rules never know which mode they
 * are in. Phase 3 adds a real recipe API source; Phase 6 an AI-curated one.
 */
export interface DeckSource {
  mode: SessionMode;
  buildDeck: () => Promise<Card[]>;
}

export const staticRecipeDeck: DeckSource = {
  mode: 'cook-in',
  // Copy so no session can mutate the shared constant.
  buildDeck: async () => staticRecipes.map((card) => ({ ...card, tags: [...card.tags] })),
};
