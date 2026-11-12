import type { SwipeDirection } from '@yumanimous/shared';
import styles from './DeckControls.module.css';

/** Tap alternative to dragging: same outcome, same animation. */
export function DeckControls({ onSwipe }: { onSwipe: (direction: SwipeDirection) => void }) {
  return (
    <div className={styles.controls}>
      <button
        type="button"
        className={`${styles.button} ${styles.skip}`}
        onClick={() => onSwipe('skip')}
        aria-label="Skip this recipe"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
        Skip
      </button>
      <button
        type="button"
        className={`${styles.button} ${styles.like}`}
        onClick={() => onSwipe('like')}
        aria-label="Like this recipe"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 20s-7-4.4-7-9.4C5 8 7 6 9.3 6c1.2 0 2.2.6 2.7 1.5C12.5 6.6 13.5 6 14.7 6 17 6 19 8 19 10.6 19 15.6 12 20 12 20z" />
        </svg>
        Like
      </button>
    </div>
  );
}
