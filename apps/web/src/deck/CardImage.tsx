import { useState } from 'react';
import type { Card } from '@yumanimous/shared';
import styles from './CardImage.module.css';

/**
 * Shows the card photo, or a styled placeholder with the recipe name when there is
 * no verified image or the URL fails at runtime (link rot, offline, blocked CDN).
 */
export function CardImage({ card }: { card: Card }) {
  const [failed, setFailed] = useState(false);

  if (!card.imageUrl || failed) {
    return (
      <div className={styles.placeholder} data-testid="card-image-placeholder" aria-hidden="true">
        <span>{card.title}</span>
      </div>
    );
  }

  return (
    <img
      className={styles.image}
      src={card.imageUrl}
      alt={card.imageAlt ?? card.title}
      // Native image drag would hijack the swipe gesture on desktop and some Android browsers.
      draggable={false}
      decoding="async"
      onError={() => setFailed(true)}
    />
  );
}
