import { useEffect, useId, useRef, useState } from 'react';
import { ServingsStepper } from './ServingsStepper';
import ui from '../ui/ui.module.css';
import dialog from '../ui/ConfirmDialog.module.css';

interface ServingsDialogProps {
  title: string;
  /** Starts at the number of people in the session. */
  initial: number;
  onConfirm: (servings: number) => void;
  onCancel: () => void;
}

/** Asked of whoever taps "Shopping list": how many people is this for? */
export function ServingsDialog({ title, initial, onConfirm, onCancel }: ServingsDialogProps) {
  const titleId = useId();
  const [servings, setServings] = useState(initial);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    confirmRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div
      className={dialog.backdrop}
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className={dialog.dialog} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <h2 id={titleId} className={dialog.title}>
          How many are eating?
        </h2>
        <p className={ui.muted}>We’ll scale {title} and make one list for everyone.</p>
        <ServingsStepper value={servings} onChange={setServings} />
        <div className={dialog.actions}>
          <button type="button" className={ui.secondary} onClick={onCancel}>
            Cancel
          </button>
          <button
            ref={confirmRef}
            type="button"
            className={ui.primary}
            onClick={() => onConfirm(servings)}
          >
            Make list
          </button>
        </div>
      </div>
    </div>
  );
}
