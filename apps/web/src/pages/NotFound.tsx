import { Link } from 'react-router';
import ui from '../ui/ui.module.css';

export function NotFound() {
  return (
    <div className={ui.center}>
      <h2 className={ui.heading}>That session doesn’t exist</h2>
      <p className={ui.muted}>Check the code or ask for a fresh link.</p>
      <Link className={ui.primary} to="/">
        Start your own
      </Link>
    </div>
  );
}
