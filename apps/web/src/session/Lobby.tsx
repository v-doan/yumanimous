import { useState } from 'react';
import { matchRules, type SessionView } from '@yumanimous/shared';
import { MemberList } from './MemberList';
import ui from '../ui/ui.module.css';
import styles from './Lobby.module.css';

interface LobbyProps {
  view: SessionView;
  myId: string;
  onStart: () => void;
}

/** Waiting room: share the link, watch friends arrive, host taps Start. */
export function Lobby({ view, myId, onStart }: LobbyProps) {
  const isHost = view.members.find((m) => m.id === myId)?.isHost ?? false;
  const host = view.members.find((m) => m.isHost);

  return (
    <div className={ui.page}>
      <section className={ui.panel} aria-labelledby="lobby-title">
        <h2 id="lobby-title" className={ui.heading}>
          Invite your group
        </h2>
        <p className={styles.code} aria-label={`Session code ${view.code.split('').join(' ')}`}>
          {view.code}
        </p>
        <ShareButton code={view.code} />
        <p className={ui.muted}>
          {matchRules[view.matchRule].label}: {matchRules[view.matchRule].description}
        </p>
      </section>

      <section className={ui.panel} aria-labelledby="members-title">
        <h2 id="members-title" className={ui.heading}>
          Here so far ({view.members.length})
        </h2>
        <MemberList view={view} myId={myId} />
      </section>

      {isHost ? (
        <button type="button" className={ui.primary} onClick={onStart}>
          {view.members.length === 1 ? 'Start anyway' : 'Start swiping'}
        </button>
      ) : (
        <p className={ui.muted}>Waiting for {host?.name ?? 'the host'} to start…</p>
      )}
    </div>
  );
}

/** Native share sheet on phones (straight into the group chat), clipboard elsewhere. */
function ShareButton({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const url = `${window.location.origin}/s/${code}`;

  async function share() {
    if (navigator.share) {
      try {
        await navigator.share({ title: 'Yumanimous', text: 'Help pick dinner!', url });
        return;
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return; // User closed it.
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt('Copy this link:', url);
    }
  }

  return (
    <button type="button" className={ui.secondary} onClick={share}>
      {copied ? 'Link copied!' : 'Share link'}
    </button>
  );
}
