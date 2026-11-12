import type { CSSProperties } from 'react';
import { evaluateCard, matchRules, type CardOutcome, type SessionView } from '@yumanimous/shared';
import { MemberList } from './MemberList';
import ui from '../ui/ui.module.css';
import styles from './Results.module.css';

const OUTCOME_LABEL: Record<CardOutcome, string> = {
  match: 'Match',
  'no-match': 'Out',
  undecided: 'Voting',
};

const OUTCOME_CLASS: Record<CardOutcome, string> = {
  match: styles.match ?? '',
  'no-match': styles.noMatch ?? '',
  undecided: '',
};

/**
 * Live leaderboard. Tallies use the same pure match rule as the server, so what
 * people see here always agrees with the match the server declared.
 */
export function Results({ view, myId }: { view: SessionView; myId: string }) {
  const rule = matchRules[view.matchRule];
  const memberIds = view.members.map((m) => m.id);
  const matchOrder = new Map(view.matches.map((m, i) => [m.cardId, i]));

  const rows = view.deck
    .map((card, deckIndex) => {
      const { tally, outcome } = evaluateCard(rule, card.id, view.swipes, memberIds);
      // Server-declared matches are sticky, even if a late joiner would reopen the vote.
      const matched = matchOrder.has(card.id);
      return { card, deckIndex, tally, outcome: matched ? ('match' as const) : outcome };
    })
    // Matches first (in the order they happened), then most yums, then deck order.
    .sort(
      (a, b) =>
        (matchOrder.get(a.card.id) ?? Infinity) - (matchOrder.get(b.card.id) ?? Infinity) ||
        b.tally.likes.length - a.tally.likes.length ||
        a.deckIndex - b.deckIndex,
    );

  const stillSwiping = view.members.filter((m) => m.swipedCount < view.deck.length);
  let heading = 'Live results';
  if (view.finished) heading = view.matches.length > 0 ? 'Final results' : 'No match this time';

  return (
    <div className={ui.page}>
      <section className={ui.panel} aria-labelledby="results-title">
        <h2 id="results-title" className={ui.heading}>
          {heading}
        </h2>
        <p className={ui.muted}>
          {view.finished
            ? view.matches.length > 0
              ? `${view.matches.length} ${view.matches.length === 1 ? 'match' : 'matches'}. Dinner is decided.`
              : 'Nothing got enough yums. Here’s what came closest.'
            : `Waiting on ${stillSwiping.map((m) => m.name).join(', ')}.`}
        </p>

        <ol className={styles.board} aria-label="Leaderboard">
          {rows.map(({ card, tally, outcome }) => (
            <li key={card.id} className={`${styles.row} ${OUTCOME_CLASS[outcome]}`}>
              <span className={styles.title}>{card.title}</span>
              <span className={styles.count}>
                {tally.likes.length}/{memberIds.length} yum
              </span>
              <span className={ui.badge}>{OUTCOME_LABEL[outcome]}</span>
              <span
                className={styles.bar}
                style={
                  {
                    '--fill': `${(tally.likes.length / Math.max(memberIds.length, 1)) * 100}%`,
                  } as CSSProperties
                }
                aria-hidden="true"
              />
            </li>
          ))}
        </ol>
      </section>

      <section className={ui.panel} aria-labelledby="who-title">
        <h2 id="who-title" className={ui.heading}>
          Who’s swiping
        </h2>
        <MemberList view={view} myId={myId} />
      </section>
    </div>
  );
}
