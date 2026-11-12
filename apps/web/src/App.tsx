import { Link, Outlet } from 'react-router';
import styles from './App.module.css';

/** Shell shared by every route: logo header + the current page. */
export function App() {
  return (
    <div className={styles.app}>
      <header className={styles.header}>
        <Link to="/" className={styles.logoLink}>
          <h1 className={styles.logo}>Yumanimous</h1>
        </Link>
        <p className={styles.tagline}>Swipe right on dinner.</p>
      </header>
      <main className={styles.main}>
        <Outlet />
      </main>
    </div>
  );
}
