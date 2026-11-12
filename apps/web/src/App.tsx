import { SwipeDeck } from './deck/SwipeDeck';
import { recipes } from './data/recipes';
import styles from './App.module.css';

export function App() {
  return (
    <div className={styles.app}>
      <header className={styles.header}>
        <h1 className={styles.logo}>Yumanimous</h1>
        <p className={styles.tagline}>Swipe right on dinner.</p>
      </header>
      <main className={styles.main}>
        <SwipeDeck cards={recipes} />
      </main>
    </div>
  );
}
