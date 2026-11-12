import { useCallback, useEffect, useRef } from 'react';
import type { Card, SwipeDirection } from '@yumanimous/shared';
import { SwipeCard, type SwipeCardHandle } from './SwipeCard';
import { DeckControls } from './DeckControls';
import styles from './SwipeDeck.module.css';

interface SwipeDeckProps {
  cards: Card[];
  /** Index of the card on top. The parent owns it (derived from server state), so a
   *  refresh mid-session resumes on the right card. */
  index: number;
  onSwipe: (cardId: string, direction: SwipeDirection) => void;
}

/** Presentational: shows the stack and reports swipes. Knows nothing about sessions. */
export function SwipeDeck({ cards, index, onSwipe }: SwipeDeckProps) {
  const topCard = useRef<SwipeCardHandle>(null);
  const visibleCards = cards.slice(index, index + 3); // Rendering the next two also preloads their images.
  const current = visibleCards[0];

  // Buttons and keys ask the top card to animate away; the card then reports back via
  // onSwiped. That keeps one code path for drag, tap and keyboard.
  const requestSwipe = useCallback((direction: SwipeDirection) => {
    topCard.current?.swipe(direction);
  }, []);

  useEffect(() => {
    if (!current) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') requestSwipe('skip');
      if (e.key === 'ArrowRight') requestSwipe('like');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [current, requestSwipe]);

  if (!current) return null;

  return (
    <section className={styles.deck} aria-label="Recipe deck">
      <p className={styles.progress} aria-hidden="true">
        {index + 1} / {cards.length}
      </p>

      <div className={styles.stack}>
        {/* Render back-to-front so the top card is last in the DOM. */}
        {visibleCards
          .map((card, depth) => (
            <SwipeCard
              key={card.id}
              card={card}
              depth={depth}
              onSwiped={(direction) => onSwipe(card.id, direction)}
              ref={depth === 0 ? topCard : undefined}
            />
          ))
          .reverse()}
      </div>

      <p className="visually-hidden" aria-live="polite">
        {`Card ${index + 1} of ${cards.length}: ${current.title}. ${current.blurb}`}
      </p>

      <DeckControls onSwipe={requestSwipe} />
    </section>
  );
}
