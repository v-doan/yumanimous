import { useMemo, useState } from 'react';
import { emptyPreferences, parsePreferences, type MemberPreferences } from '@yumanimous/shared';
import { removeChip, toChips, type Chip } from './preferenceChips';
import ui from '../ui/ui.module.css';
import styles from './PreferencesPanel.module.css';

interface PreferencesPanelProps {
  /** What's saved on the server, or null if nothing yet. */
  saved: MemberPreferences | null;
  onSave: (preferences: MemberPreferences) => Promise<boolean>;
  /** Shown for late joiners: "No rules, take me to the deck". */
  onSkip?: () => void;
}

/**
 * "Your food rules": type in plain words, see what we understood as chips, remove
 * anything wrong, save. Parsing is a keyword matcher that runs right here in the
 * browser (no AI, nothing sent until you save). Only the confirmed chips are sent,
 * never the text you typed.
 */
export function PreferencesPanel({ saved, onSave, onSkip }: PreferencesPanelProps) {
  const [editing, setEditing] = useState(saved === null);
  const [text, setText] = useState('');
  const [removed, setRemoved] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  // Shown until the server's broadcast brings `saved` up to date.
  const [justSaved, setJustSaved] = useState<MemberPreferences | null>(null);
  const current = saved ?? justSaved;

  // Re-parse as you type; then drop the chips you removed.
  const draft = useMemo(
    () => removed.reduce(removeChip, text.trim() ? parsePreferences(text) : emptyPreferences()),
    [text, removed],
  );
  const chips = toChips(draft);

  async function save(preferences: MemberPreferences) {
    setBusy(true);
    const ok = await onSave(preferences);
    setBusy(false);
    if (ok) {
      setJustSaved(preferences);
      setEditing(false);
      setText('');
      setRemoved([]);
    }
  }

  if (!editing && current) {
    const savedChips = toChips(current);
    return (
      <section className={ui.panel} aria-labelledby="prefs-title">
        <h2 id="prefs-title" className={ui.heading}>
          Your food rules
        </h2>
        {savedChips.length ? (
          <ChipList chips={savedChips} />
        ) : (
          <p className={ui.muted}>No rules. You’ll eat anything!</p>
        )}
        <button type="button" className={ui.secondary} onClick={() => setEditing(true)}>
          Change
        </button>
      </section>
    );
  }

  return (
    <section className={ui.panel} aria-labelledby="prefs-title">
      <h2 id="prefs-title" className={ui.heading}>
        Your food rules
      </h2>
      <label className={ui.field}>
        Anything we should know?
        <textarea
          className={`${ui.input} ${styles.textarea}`}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setRemoved([]);
          }}
          maxLength={500}
          rows={3}
          placeholder="e.g. vegetarian, allergic to peanuts, nothing over 45 min, love spicy"
        />
      </label>

      {chips.length > 0 && (
        <>
          <p className={ui.muted}>Here’s what we understood. Tap ✕ to remove anything wrong.</p>
          <ChipList chips={chips} onRemove={(id) => setRemoved((r) => [...r, id])} />
        </>
      )}
      {text.trim() !== '' && chips.length === 0 && (
        <p className={ui.muted}>
          We didn’t spot any food rules there. Try words like “vegan”, “no nuts” or “under 30 min”.
        </p>
      )}

      <div className={styles.actions}>
        <button
          type="button"
          className={ui.primary}
          disabled={busy}
          onClick={() => void save(draft)}
        >
          {busy ? 'Saving…' : chips.length ? 'Save my rules' : 'No rules for me'}
        </button>
        {onSkip && (
          <button type="button" className={ui.textButton} onClick={onSkip}>
            Skip
          </button>
        )}
        {!onSkip && current && (
          <button type="button" className={ui.textButton} onClick={() => setEditing(false)}>
            Cancel
          </button>
        )}
      </div>
    </section>
  );
}

const KIND_LABEL = { must: 'Must', prefer: 'Prefer', unsupported: 'Can’t filter' } as const;

export function ChipList({ chips, onRemove }: { chips: Chip[]; onRemove?: (id: string) => void }) {
  return (
    <div className={styles.groups}>
      {(['must', 'prefer', 'unsupported'] as const).map((kind) => {
        const group = chips.filter((c) => c.kind === kind);
        if (!group.length) return null;
        return (
          <div key={kind} className={styles.group}>
            <span className={styles.groupLabel}>{KIND_LABEL[kind]}</span>
            <ul className={styles.chips} aria-label={KIND_LABEL[kind]}>
              {group.map((chip) => (
                <li key={chip.id} className={`${styles.chip} ${styles[kind]}`}>
                  {chip.label}
                  {onRemove && (
                    <button
                      type="button"
                      className={styles.remove}
                      onClick={() => onRemove(chip.id)}
                      aria-label={`Remove ${chip.label}`}
                    >
                      ✕
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}
