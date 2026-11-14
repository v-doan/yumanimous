import { canMakeShoppingList, type SessionView } from '@yumanimous/shared';
import ui from '../ui/ui.module.css';
import styles from './SuggestionPanel.module.css';

interface SuggestionPanelProps {
  view: SessionView;
  onAccept: () => void;
  onOpenList: (cardId: string) => void;
}

/** Nothing matched: the mediator's compromise, which anyone can accept. */
export function SuggestionPanel({ view, onAccept, onOpenList }: SuggestionPanelProps) {
  const { suggestion } = view;
  if (!suggestion) {
    if (!view.mediating) return null;
    return (
      <section className={ui.panel} aria-labelledby="suggestion-title">
        <h2 id="suggestion-title" className={ui.heading}>
          Finding a compromise…
        </h2>
        <p className={ui.muted} role="status">
          Looking at everyone’s yums for the fairest pick.
        </p>
      </section>
    );
  }

  const card = view.deck.find((c) => c.id === suggestion.cardId);
  if (!card) return null;
  const acceptedBy = view.members.find((m) => m.id === suggestion.acceptedBy);

  return (
    <section className={`${ui.panel} ${styles.panel}`} aria-labelledby="suggestion-title">
      <h2 id="suggestion-title" className={ui.heading}>
        How about this?
      </h2>
      <p className={styles.pick}>{card.title}</p>
      <p className={styles.reason}>{suggestion.reason}</p>
      {suggestion.acceptedBy === null ? (
        <button type="button" className={ui.primary} onClick={onAccept}>
          Go with it
        </button>
      ) : (
        <>
          <p className={ui.muted}>
            {acceptedBy ? `${acceptedBy.name} said let’s go with it.` : 'You’re going with it.'}
          </p>
          {canMakeShoppingList(view, card.id) && (
            <button type="button" className={ui.primary} onClick={() => onOpenList(card.id)}>
              Shopping list
            </button>
          )}
        </>
      )}
    </section>
  );
}
