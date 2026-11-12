import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { Membership } from '@yumanimous/shared';
import { SwipeDeck } from '../deck/SwipeDeck';
import { Lobby } from './Lobby';
import { MatchOverlay } from './MatchOverlay';
import { Results } from './Results';
import { useSession } from './useSession';
import ui from '../ui/ui.module.css';
import styles from './SessionRoom.module.css';

interface SessionRoomProps {
  membership: Membership;
  /** The stored token stopped working (e.g. removed after a long absence): rejoin by name. */
  onLostIdentity: () => void;
}

export function SessionRoom({ membership, onLostIdentity }: SessionRoomProps) {
  const session = useSession(membership);
  const { view, ended, pending, currentMatch, error, clearError } = session;
  const [showResults, setShowResults] = useState(false);

  useEffect(() => {
    if (ended === 'invalid-identity') onLostIdentity();
  }, [ended, onLostIdentity]);

  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(clearError, 4000);
    return () => clearTimeout(timer);
  }, [error, clearError]);

  if (ended) {
    return (
      <div className={ui.center}>
        <h2 className={ui.heading}>
          {ended === 'expired' ? 'This session has ended' : 'You left the session'}
        </h2>
        <Link className={ui.primary} to="/">
          Back to start
        </Link>
      </div>
    );
  }

  if (!view) return <p className={ui.muted}>Connecting…</p>;

  const me = view.members.find((m) => m.id === membership.memberId);

  // My position = first card I haven't swiped (confirmed by the server or still in
  // flight). Derived, not stored, so it's correct after a refresh or reconnect.
  const mine = new Set(
    view.swipes.filter((s) => s.memberId === membership.memberId).map((s) => s.cardId),
  );
  for (const cardId of pending) mine.add(cardId);
  const index = view.deck.findIndex((card) => !mine.has(card.id));
  const doneSwiping = index === -1;

  const matchedCard = currentMatch ? view.deck.find((c) => c.id === currentMatch) : undefined;

  return (
    <div className={styles.room}>
      <div className={styles.bar}>
        <span className={ui.muted}>
          {me?.name} · {view.code}
          {session.status === 'reconnecting' && ' · reconnecting…'}
        </span>
        <span className={styles.barActions}>
          {view.status === 'swiping' && !doneSwiping && (
            <button
              type="button"
              className={ui.textButton}
              onClick={() => setShowResults((s) => !s)}
              aria-pressed={showResults}
            >
              {showResults ? 'Back to deck' : 'Results'}
            </button>
          )}
          <button
            type="button"
            className={ui.textButton}
            onClick={() => {
              if (window.confirm('Leave this session? Your votes will be removed.'))
                session.leave();
            }}
          >
            Leave
          </button>
        </span>
      </div>

      {view.status === 'lobby' ? (
        <Lobby view={view} myId={membership.memberId} onStart={session.start} />
      ) : doneSwiping || showResults ? (
        <Results view={view} myId={membership.memberId} />
      ) : (
        <SwipeDeck cards={view.deck} index={index} onSwipe={session.swipe} />
      )}

      {matchedCard && (
        <MatchOverlay
          card={matchedCard}
          view={view}
          onKeepSwiping={() => {
            session.dismissMatch();
            setShowResults(false);
          }}
          onSeeResults={() => {
            session.dismissMatch();
            setShowResults(true);
          }}
        />
      )}

      {error && (
        <p className={styles.toast} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
