import type { Card } from '@yumanimous/shared';
import styles from './DeckEnd.module.css';

interface DeckEndProps {
  liked: Card[];
  total: number;
  onRestart: () => void;
}

export function DeckEnd({ liked, total, onRestart }: DeckEndProps) {
  return (
    <section className={styles.end} aria-labelledby="deck-end-title">
      <h2 id="deck-end-title" className={styles.title}>
        That&rsquo;s the deck!
      </h2>
      <p className={styles.summary}>
        {liked.length === 0
          ? 'Nothing caught your eye this time.'
          : `You liked ${liked.length} of ${total}.`}
      </p>

      {liked.length > 0 && (
        <ul className={styles.list} aria-label="Recipes you liked">
          {liked.map((card) => (
            <li key={card.id} className={styles.item}>
              <span className={styles.itemTitle}>{card.title}</span>
              <span className={styles.itemTags}>{card.tags.join(' · ')}</span>
            </li>
          ))}
        </ul>
      )}

      <button type="button" className={styles.restart} onClick={onRestart}>
        Swipe again
      </button>
    </section>
  );
}
