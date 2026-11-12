import { describeHardFilters, mergePreferences, type SessionView } from '@yumanimous/shared';
import ui from '../ui/ui.module.css';
import styles from './GroupRules.module.css';

/**
 * Everyone's hard rules combined: what the deck will be (or was) filtered for, plus
 * rules nobody can filter for. Same merge function the server uses.
 */
export function GroupRules({ view }: { view: SessionView }) {
  const group = mergePreferences(view.members);
  const rules = describeHardFilters(view.deckFilters ?? group.hard);
  const noneYet = !view.members.some((m) => m.preferences);

  return (
    <section className={ui.panel} aria-labelledby="group-rules-title">
      <h2 id="group-rules-title" className={ui.heading}>
        Group rules
      </h2>
      {rules.length ? (
        <p className={styles.rules}>
          {view.status === 'lobby' ? 'Every card will be ' : 'Every card is '}
          <strong>{rules.join(' · ')}</strong>
        </p>
      ) : (
        <p className={ui.muted}>
          {noneYet ? 'Nobody has added food rules yet.' : 'No must-have rules. Anything goes.'}
        </p>
      )}
      {group.unsupported.map(({ rule, members }) => (
        <p key={rule} className={ui.muted}>
          {members.join(', ')}: <strong>{rule}</strong>. We can’t filter for this, so please check
          the recipes yourselves.
        </p>
      ))}
    </section>
  );
}

/** Shown while swiping when someone's rule wasn't part of the deck's filters. */
export function UncoveredWarning({
  view,
  isHost,
  onRebuild,
}: {
  view: SessionView;
  isHost: boolean;
  onRebuild: () => void;
}) {
  if (!view.uncovered.length) return null;
  const text = view.uncovered.map((u) => `${u.rule} (${u.members.join(', ')})`).join(', ');

  return (
    <div className={styles.warning} role="alert">
      <span>
        ⚠ This deck wasn’t filtered for: <strong>{text}</strong>.
      </span>
      {isHost ? (
        <button
          type="button"
          className={styles.rebuild}
          onClick={() => {
            if (window.confirm('Rebuild the deck for everyone’s rules? All votes will be cleared.'))
              onRebuild();
          }}
        >
          Rebuild deck
        </button>
      ) : (
        <span> The host can rebuild the deck.</span>
      )}
    </div>
  );
}
