import { useState } from 'react';
import type { Card } from '@yumanimous/shared';
import styles from './CardImage.module.css';

/**
 * Shows the whole card photo, or a styled placeholder with the recipe name when there
 * is no verified image or the URL fails at runtime (link rot, offline, blocked CDN).
 *
 * Recipe photos are wide (Spoonacular's are ~1.6:1) but the card's photo area is
 * roughly square on a phone, so `object-fit: cover` would crop away ~40% of the dish.
 * Instead the photo is shown whole (`contain`), and a blurred, enlarged copy of the
 * same image fills the space around it. Same URL, so it's only downloaded once.
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
    <div className={styles.frame}>
      {/* Decorative: empty alt keeps it out of the accessibility tree. */}
      <img className={styles.backdrop} src={card.imageUrl} alt="" draggable={false} />
      <img
        className={styles.image}
        src={card.imageUrl}
        alt={card.imageAlt ?? card.title}
        // Native image drag would hijack the swipe gesture on desktop and some Android browsers.
        draggable={false}
        decoding="async"
        onError={() => setFailed(true)}
      />
    </div>
  );
}
