import { MAX_SERVINGS, MIN_SERVINGS } from '@yumanimous/shared';
import styles from './ShoppingList.module.css';

interface ServingsStepperProps {
  value: number;
  onChange: (servings: number) => void;
  disabled?: boolean;
}

/** − 4 + : big tap targets instead of a number input (fiddly on a phone keyboard). */
export function ServingsStepper({ value, onChange, disabled = false }: ServingsStepperProps) {
  return (
    <div className={styles.stepper} role="group" aria-label="Servings">
      <button
        type="button"
        className={styles.step}
        aria-label="Fewer servings"
        disabled={disabled || value <= MIN_SERVINGS}
        onClick={() => onChange(value - 1)}
      >
        −
      </button>
      <output className={styles.servings} aria-live="polite">
        {value} {value === 1 ? 'serving' : 'servings'}
      </output>
      <button
        type="button"
        className={styles.step}
        aria-label="More servings"
        disabled={disabled || value >= MAX_SERVINGS}
        onClick={() => onChange(value + 1)}
      >
        +
      </button>
    </div>
  );
}
