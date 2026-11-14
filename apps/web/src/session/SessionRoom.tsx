import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { Membership } from '@yumanimous/shared';
import { SwipeDeck } from '../deck/SwipeDeck';
import { UncoveredWarning } from './GroupRules';
import { Lobby } from './Lobby';
import { MatchOverlay } from './MatchOverlay';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { PreferencesPanel } from './PreferencesPanel';
import { Results } from './Results';
import { ServingsDialog } from './ServingsDialog';
import { ShoppingListView } from './ShoppingList';
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
  const { view, ended, pending, currentMatch, error, clearError, notice, clearNotice } = session;
  const [showResults, setShowResults] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const cancelLeave = useCallback(() => setConfirmLeave(false), []);
  const [rulesAsked, setRulesAsked] = useRulesAsked(membership);
  /** The recipe whose shopping list is open, if any. */
  const [listFor, setListFor] = useState<string | null>(null);
  /** The recipe someone tapped "Shopping list" on, while choosing servings. */
  const [servingsFor, setServingsFor] = useState<string | null>(null);
  const cancelServings = useCallback(() => setServingsFor(null), []);

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

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(clearNotice, 5000);
    return () => clearTimeout(timer);
  }, [notice, clearNotice]);

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
  const openList = view.shoppingLists.find((l) => l.cardId === listFor);
  const servingsCard = view.deck.find((c) => c.id === servingsFor);

  // An existing list (any state) opens straight away; otherwise ask for servings.
  const openShoppingList = (cardId: string) => {
    if (view.shoppingLists.some((l) => l.cardId === cardId)) setListFor(cardId);
    else setServingsFor(cardId);
  };
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
          <button type="button" className={ui.textButton} onClick={() => setConfirmLeave(true)}>
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
            deckProgress={session.deckProgress}
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
        ) : openList ? (
          <ShoppingListView
            list={openList}
            onToggle={(lineId, have) => session.toggleLine(openList.cardId, lineId, have)}
            onServings={(servings) => session.setServings(openList.cardId, servings)}
            onRetry={() => session.makeList(openList.cardId, openList.servings)}
            onBack={() => setListFor(null)}
          />
        ) : doneSwiping || showResults ? (
          <Results
            view={view}
            myId={membership.memberId}
            onOpenList={openShoppingList}
            onAcceptSuggestion={session.acceptSuggestion}
          />
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
          onShoppingList={() => {
            session.dismissMatch();
            setShowResults(true); // So "Back" from the list lands on the results.
            openShoppingList(matchedCard.id);
          }}
        />
      )}

      {servingsCard && (
        <ServingsDialog
          title={servingsCard.title}
          initial={Math.max(1, view.members.length)}
          onConfirm={(servings) => {
            setServingsFor(null);
            setListFor(servingsCard.id);
            void session.makeList(servingsCard.id, servings);
          }}
          onCancel={cancelServings}
        />
      )}

      {confirmLeave && (
        <ConfirmDialog
          title="Leave this session?"
          message="Your votes and food rules will be removed for everyone."
          confirmLabel="Leave"
          onConfirm={() => {
            setConfirmLeave(false);
            session.leave();
          }}
          onCancel={cancelLeave}
        />
      )}

      {error && (
        <p className={styles.toast} role="alert">
          {error}
        </p>
      )}
      {!error && notice && (
        <p className={styles.toast} role="status">
          {notice}
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
