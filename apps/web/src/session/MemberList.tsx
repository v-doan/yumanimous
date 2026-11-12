import type { SessionView } from '@yumanimous/shared';
import ui from '../ui/ui.module.css';
import styles from './MemberList.module.css';

/** Who's here, who's online, and (once swiping) how far along each person is. */
export function MemberList({ view, myId }: { view: SessionView; myId: string }) {
  const total = view.deck.length;

  return (
    <ul className={styles.list}>
      {view.members.map((m) => {
        const done = m.swipedCount === total;
        let status = 'here';
        if (!m.connected) status = 'offline';
        else if (view.status === 'swiping') status = done ? 'done' : 'swiping';

        return (
          <li key={m.id} className={styles.member}>
            <span
              className={`${styles.dot} ${m.connected ? styles.online : ''}`}
              aria-hidden="true"
            />
            <span className={styles.name}>
              {m.name}
              {m.id === myId && ' (you)'}
            </span>
            {m.isHost && <span className={ui.badge}>host</span>}
            {m.preferences && (
              <span className={ui.badge} title="Has food rules">
                rules ✓
              </span>
            )}
            <span className={styles.status}>
              {view.status === 'swiping' && !done && `${m.swipedCount}/${total} · `}
              {status}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
