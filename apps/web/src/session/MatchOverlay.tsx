import { useEffect, useRef } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { tallyCard, type Card, type SessionView } from '@yumanimous/shared';
import { CardImage } from '../deck/CardImage';
import ui from '../ui/ui.module.css';
import styles from './MatchOverlay.module.css';

interface MatchOverlayProps {
  card: Card;
  view: SessionView;
  onKeepSwiping: () => void;
  onSeeResults: () => void;
}

/** "It's a match!" shown to everyone at the same moment. */
export function MatchOverlay({ card, view, onKeepSwiping, onSeeResults }: MatchOverlayProps) {
  const reduceMotion = useReducedMotion();
  const firstButton = useRef<HTMLButtonElement>(null);

  const memberIds = view.members.map((m) => m.id);
  const { likes } = tallyCard(card.id, view.swipes, memberIds);
  const names = view.members.filter((m) => likes.includes(m.id)).map((m) => m.name);
  const everyone = likes.length === memberIds.length;

  // Move focus into the dialog so keyboard and screen-reader users land on it.
  useEffect(() => firstButton.current?.focus(), [card.id]);

  return (
    <div className={styles.backdrop}>
      <motion.div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="match-title"
        initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.85, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ type: 'spring', stiffness: 320, damping: 22 }}
      >
        <h2 id="match-title" className={styles.title}>
          It’s a match!
        </h2>
        <div className={styles.image}>
          <CardImage card={card} />
        </div>
        <p className={styles.cardTitle}>{card.title}</p>
        <p className={ui.muted}>
          {everyone ? 'Everyone said yum' : `Yum from ${names.join(', ')}`}
        </p>
        <div className={styles.actions}>
          <button ref={firstButton} type="button" className={ui.primary} onClick={onKeepSwiping}>
            Keep swiping
          </button>
          <button type="button" className={ui.secondary} onClick={onSeeResults}>
            See results
          </button>
        </div>
      </motion.div>
    </div>
  );
}
