import { useEffect, useId, useRef } from 'react';
import ui from './ui.module.css';
import styles from './ConfirmDialog.module.css';

interface ConfirmDialogProps {
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * The app's own "are you sure?" dialog, instead of window.confirm(). In-app browsers
 * (the ones chat apps open links in, which is how people join) and embedded
 * previews often suppress native dialogs: confirm() then returns false at once, and
 * the button silently does nothing.
 */
export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const titleId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    // Focus the safe choice, so a stray Enter doesn't do the destructive one.
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div
      className={styles.backdrop}
      // A tap outside the dialog cancels, like a native sheet.
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className={styles.dialog} role="alertdialog" aria-modal="true" aria-labelledby={titleId}>
        <h2 id={titleId} className={styles.title}>
          {title}
        </h2>
        <p className={ui.muted}>{message}</p>
        <div className={styles.actions}>
          <button ref={cancelRef} type="button" className={ui.secondary} onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className={ui.primary} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
