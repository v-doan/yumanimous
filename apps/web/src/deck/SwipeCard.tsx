import { useCallback, useImperativeHandle, useRef, type Ref } from 'react';
import {
  animate,
  motion,
  useMotionValue,
  useReducedMotion,
  useTransform,
  type PanInfo,
} from 'motion/react';
import type { Card, SwipeDirection } from '@yumanimous/shared';
import { CardImage } from './CardImage';
import styles from './SwipeCard.module.css';

/** Lets the deck trigger the same fly-away animation from buttons and arrow keys. */
export interface SwipeCardHandle {
  swipe: (direction: SwipeDirection) => void;
}

interface SwipeCardProps {
  card: Card;
  /** 0 = top (draggable), 1-2 = cards peeking out behind it. */
  depth: number;
  onSwiped: (direction: SwipeDirection) => void;
  ref?: Ref<SwipeCardHandle>;
}

// A swipe commits when the card is dragged past 30% of its width, OR flicked fast.
// The velocity rule matters on phones: a short, quick flick should count even if
// the finger only travelled a few centimetres.
const DISTANCE_THRESHOLD = 0.3;
const VELOCITY_THRESHOLD = 500; // px/s

export function SwipeCard({ card, depth, onSwiped, ref }: SwipeCardProps) {
  const isTop = depth === 0;
  const cardRef = useRef<HTMLDivElement>(null);
  const leaving = useRef(false);
  const reduceMotion = useReducedMotion();

  // `x` is the single source of truth for the gesture; rotation and the LIKE/NOPE
  // stamps are derived from it, so drag, buttons and spring-back all stay in sync.
  const x = useMotionValue(0);
  const opacity = useMotionValue(1);
  const rotate = useTransform(x, [-200, 200], [-15, 15]);
  const likeOpacity = useTransform(x, [20, 100], [0, 1]);
  const nopeOpacity = useTransform(x, [-100, -20], [1, 0]);

  const flyAway = useCallback(
    async (direction: SwipeDirection) => {
      // Guard against double commits (a fast flick followed by a button tap, key repeat, etc.).
      if (leaving.current) return;
      leaving.current = true;
      navigator.vibrate?.(10); // Android only; iOS Safari ignores it.

      if (reduceMotion) {
        await animate(opacity, 0, { duration: 0.15 });
      } else {
        const sign = direction === 'like' ? 1 : -1;
        const offscreen = window.innerWidth + (cardRef.current?.offsetWidth ?? 400);
        await animate(x, sign * offscreen, { duration: 0.3, ease: 'easeOut' });
      }
      // Only advance the deck once the card is gone, so the next card can't be
      // grabbed mid-animation and two cards can't be swiped by one gesture.
      onSwiped(direction);
    },
    [onSwiped, opacity, reduceMotion, x],
  );

  useImperativeHandle(ref, () => ({ swipe: (d) => void flyAway(d) }), [flyAway]);

  const handleDragEnd = (_event: PointerEvent | MouseEvent | TouchEvent, info: PanInfo) => {
    const width = cardRef.current?.offsetWidth ?? 320;
    const { offset, velocity } = info;
    const flicked =
      Math.abs(velocity.x) > VELOCITY_THRESHOLD && Math.sign(velocity.x) === Math.sign(offset.x);

    if (flicked || Math.abs(offset.x) > width * DISTANCE_THRESHOLD) {
      void flyAway(offset.x > 0 ? 'like' : 'skip');
    } else {
      animate(x, 0, { type: 'spring', stiffness: 500, damping: 32 });
    }
  };

  return (
    <motion.div
      ref={cardRef}
      className={styles.card}
      style={{ x, rotate, opacity, zIndex: 10 - depth }}
      // Cards behind the top one sit slightly smaller and lower; when the top card
      // leaves, the next one springs up into place.
      initial={false}
      animate={{ scale: 1 - depth * 0.05, y: depth * 14 }}
      transition={{ type: 'spring', stiffness: 300, damping: 26 }}
      drag={isTop ? 'x' : false}
      dragMomentum={false}
      onDragEnd={isTop ? handleDragEnd : undefined}
      aria-hidden={!isTop}
      data-testid={isTop ? 'top-card' : undefined}
    >
      <div className={styles.media}>
        <CardImage card={card} />
        <motion.span
          className={`${styles.stamp} ${styles.stampLike}`}
          style={{ opacity: likeOpacity }}
        >
          Like
        </motion.span>
        <motion.span
          className={`${styles.stamp} ${styles.stampNope}`}
          style={{ opacity: nopeOpacity }}
        >
          Nope
        </motion.span>
      </div>

      <div className={styles.body}>
        <h2 className={styles.title}>{card.title}</h2>
        <ul className={styles.tags} aria-label="Tags">
          {card.tags.map((tag) => (
            <li key={tag} className={styles.tag}>
              {tag}
            </li>
          ))}
        </ul>
        <p className={styles.blurb}>{card.blurb}</p>
        {card.imageCredit && (
          <p className={styles.credit}>
            Photo:{' '}
            <a href={card.imageCredit.url} target="_blank" rel="noopener noreferrer">
              {card.imageCredit.name}
            </a>
          </p>
        )}
      </div>
    </motion.div>
  );
}
