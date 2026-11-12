import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { Membership } from '@yumanimous/shared';
import { SwipeDeck } from '../deck/SwipeDeck';
import { UncoveredWarning } from './GroupRules';
import { Lobby } from './Lobby';
import { MatchOverlay } from './MatchOverlay';
import { PreferencesPanel } from './PreferencesPanel';
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
  const [rulesAsked, setRulesAsked] = useRulesAsked(membership);

  useEffect(() => {
    if (ended === 'invalid-identity') onLostIdentity();
  }, [ended, onLostIdentity]);

  // Anyone who saw the lobby already had the chance to add food rules.
  const inLobby = view?.status === 'lobby';
  useEffect(() => {
    if (inLobby) setRulesAsked();
  }, [inLobby, setRulesAsked]);

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
  // Joined after the start: one chance to add food rules before the first card.
  const askForRules =
    view.status === 'swiping' && !rulesAsked && !me?.preferences && mine.size === 0;

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

      {view.status === 'swiping' && (
        <UncoveredWarning view={view} isHost={me?.isHost ?? false} onRebuild={session.rebuild} />
      )}

      <div className={styles.content}>
        {view.status === 'lobby' ? (
          <Lobby
            view={view}
            myId={membership.memberId}
            onStart={session.start}
            onSavePreferences={session.setPreferences}
          />
        ) : askForRules ? (
          <div className={ui.page}>
            <PreferencesPanel
              saved={null}
              onSave={async (p) => {
                const ok = await session.setPreferences(p);
                if (ok) setRulesAsked();
                return ok;
              }}
              onSkip={setRulesAsked}
            />
          </div>
        ) : doneSwiping || showResults ? (
          <Results view={view} myId={membership.memberId} />
        ) : (
          <SwipeDeck cards={view.deck} index={index} onSwipe={session.swipe} />
        )}
      </div>

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

/** Remembered per member, so a refresh doesn't ask again. */
function useRulesAsked({ code, memberId }: Membership): [boolean, () => void] {
  const key = `yumanimous:rules-asked:${code}:${memberId}`;
  const [asked, setAsked] = useState(() => {
    try {
      return localStorage.getItem(key) === '1';
    } catch {
      return false;
    }
  });
  const markAsked = useCallback(() => {
    setAsked(true);
    try {
      localStorage.setItem(key, '1');
    } catch {
      // Storage blocked: we'll just ask again after a refresh.
    }
  }, [key]);
  return [asked, markAsked];
}
