import { useCallback, useEffect, useRef } from 'react';
import type { Card, SwipeDirection } from '@yumanimous/shared';
import { useDeck } from './useDeck';
import { SwipeCard, type SwipeCardHandle } from './SwipeCard';
import { DeckControls } from './DeckControls';
import { DeckEnd } from './DeckEnd';
import styles from './SwipeDeck.module.css';

export function SwipeDeck({ cards }: { cards: Card[] }) {
  const { state, visibleCards, done, liked, swipe, reset } = useDeck(cards);
  const topCard = useRef<SwipeCardHandle>(null);

  // Buttons and keys ask the top card to animate away; the card then reports back via
  // onSwiped. That keeps one code path for drag, tap and keyboard.
  const requestSwipe = useCallback((direction: SwipeDirection) => {
    topCard.current?.swipe(direction);
  }, []);

  useEffect(() => {
    if (done) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') requestSwipe('skip');
      if (e.key === 'ArrowRight') requestSwipe('like');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [done, requestSwipe]);

  const total = state.cards.length;

  if (done) {
    return <DeckEnd liked={liked} total={total} onRestart={reset} />;
  }

  const current = visibleCards[0];

  return (
    <section className={styles.deck} aria-label="Recipe deck">
      <p className={styles.progress} aria-hidden="true">
        {state.index + 1} / {total}
      </p>

      <div className={styles.stack}>
        {/* Render back-to-front so the top card is last in the DOM. */}
        {visibleCards
          .map((card, depth) => (
            <SwipeCard
              key={card.id}
              card={card}
              depth={depth}
              onSwiped={swipe}
              ref={depth === 0 ? topCard : undefined}
            />
          ))
          .reverse()}
      </div>

      <p className="visually-hidden" aria-live="polite">
        {current && `Card ${state.index + 1} of ${total}: ${current.title}. ${current.blurb}`}
      </p>

      <DeckControls onSwipe={requestSwipe} />
    </section>
  );
}
