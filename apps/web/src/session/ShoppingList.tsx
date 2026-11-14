import { useEffect, useState } from 'react';
import { shoppingListText, type ShoppingLine, type ShoppingList } from '@yumanimous/shared';
import { copyText } from '../lib/copyText';
import { ServingsStepper } from './ServingsStepper';
import ui from '../ui/ui.module.css';
import styles from './ShoppingList.module.css';

interface ShoppingListViewProps {
  list: ShoppingList;
  onToggle: (lineId: string, have: boolean) => void;
  onServings: (servings: number) => void;
  onRetry: () => void;
  onBack: () => void;
}

/** One shared list: everyone sees the same ticks, live. */
export function ShoppingListView({
  list,
  onToggle,
  onServings,
  onRetry,
  onBack,
}: ShoppingListViewProps) {
  const [copied, setCopied] = useState<'yes' | 'failed' | null>(null);
  useEffect(() => {
    if (copied !== 'yes') return;
    const timer = setTimeout(() => setCopied(null), 2500);
    return () => clearTimeout(timer);
  }, [copied]);

  // Shown at once and sent on every tap. Reading list.servings instead would lose
  // quick taps: the second tap would still see the old value until the server's
  // update arrives. Someone else's change still comes through.
  const [servings, setServings] = useState(list.servings);
  // Adopt a new server value during render (React's pattern for derived state).
  const [serverServings, setServerServings] = useState(list.servings);
  if (list.servings !== serverServings) {
    setServerServings(list.servings);
    setServings(list.servings);
  }
  const changeServings = (next: number) => {
    setServings(next);
    onServings(next);
  };

  const toBuy = list.lines.filter((l) => !l.likelyAtHome);
  const atHome = list.lines.filter((l) => l.likelyAtHome);
  const left = list.lines.filter((l) => !l.have).length;

  const text = shoppingListText(list);
  const copy = async () => setCopied((await copyText(text)) ? 'yes' : 'failed');

  return (
    <div className={ui.page}>
      <section className={ui.panel} aria-labelledby="list-title">
        <div className={styles.header}>
          <h2 id="list-title" className={ui.heading}>
            Shopping list
          </h2>
          <button type="button" className={ui.textButton} onClick={onBack}>
            Back
          </button>
        </div>
        <p className={styles.recipe}>{list.title}</p>

        {list.status === 'building' && (
          <p className={ui.muted} role="status">
            Making the list…
          </p>
        )}

        {list.status === 'failed' && (
          <>
            <p className={ui.error} role="alert">
              {list.error ?? 'The list could not be made.'}
            </p>
            <button type="button" className={ui.primary} onClick={onRetry}>
              Try again
            </button>
          </>
        )}

        {list.status === 'ready' && (
          <>
            <ServingsStepper value={servings} onChange={changeServings} />
            <p className={ui.muted}>
              {left === 0 ? 'Got everything!' : `${left} to buy`} ·{' '}
              {list.source === 'ai' ? 'Sorted by our sous-chef' : 'Straight from the recipe'}
            </p>

            {groupByAisle(toBuy).map(([aisle, lines]) => (
              <Aisle key={aisle} title={aisle} lines={lines} onToggle={onToggle} />
            ))}

            {atHome.length > 0 && (
              <details className={styles.atHome}>
                <summary>Probably at home ({atHome.length})</summary>
                <Aisle title="Probably at home" hideTitle lines={atHome} onToggle={onToggle} />
              </details>
            )}

            <button type="button" className={ui.primary} onClick={copy}>
              {copied === 'yes' ? 'Copied!' : 'Copy list'}
            </button>
            {copied === 'failed' && (
              // Last resort: the text itself, to long-press and copy by hand.
              <label className={ui.field}>
                <span role="alert">This browser won’t copy for us. Long-press to copy:</span>
                <textarea className={ui.input} readOnly rows={8} value={text} />
              </label>
            )}
          </>
        )}
      </section>
    </div>
  );
}

function Aisle({
  title,
  hideTitle = false,
  lines,
  onToggle,
}: {
  title: string;
  hideTitle?: boolean;
  lines: ShoppingLine[];
  onToggle: (lineId: string, have: boolean) => void;
}) {
  return (
    <fieldset className={styles.aisle}>
      <legend className={hideTitle ? styles.hidden : styles.aisleTitle}>{title}</legend>
      {lines.map((line) => (
        <label key={line.id} className={styles.line}>
          <input
            type="checkbox"
            checked={line.have}
            onChange={(e) => onToggle(line.id, e.target.checked)}
          />
          <span className={line.have ? styles.done : undefined}>
            {line.name}
            {/* The space is its own text node: a leading space inside the span is
                dropped from the checkbox's accessible name ("Garlic· 3 cloves"). */}
            {line.quantity && ' '}
            {line.quantity && <span className={styles.quantity}>· {line.quantity}</span>}
          </span>
        </label>
      ))}
    </fieldset>
  );
}

/** Aisles in the order they first appear (the sous-chef orders them for a shop). */
function groupByAisle(lines: ShoppingLine[]): [string, ShoppingLine[]][] {
  const groups = new Map<string, ShoppingLine[]>();
  for (const line of lines) groups.set(line.aisle, [...(groups.get(line.aisle) ?? []), line]);
  return [...groups];
}
