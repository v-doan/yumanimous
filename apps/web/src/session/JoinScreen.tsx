import { useEffect, useState, type FormEvent } from 'react';
import {
  GuestNameSchema,
  matchRules,
  type Membership,
  type SessionPreview,
} from '@yumanimous/shared';
import { api, ApiRequestError } from '../lib/api';
import { saveIdentity } from '../lib/identity';
import { NotFound } from '../pages/NotFound';
import ui from '../ui/ui.module.css';

interface JoinScreenProps {
  code: string;
  onJoined: (membership: Membership) => void;
}

/** Name form for someone who opened the link. No account, just a display name. */
export function JoinScreen({ code, onJoined }: JoinScreenProps) {
  const [preview, setPreview] = useState<SessionPreview | null>(null);
  const [loadError, setLoadError] = useState<ApiRequestError | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.getPreview(code).then(
      (p) => !cancelled && setPreview(p),
      (err) => !cancelled && setLoadError(err instanceof ApiRequestError ? err : null),
    );
    return () => {
      cancelled = true;
    };
  }, [code]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const parsed = GuestNameSchema.safeParse(name);
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? 'Invalid name');

    setBusy(true);
    setError(null);
    try {
      const membership = await api.joinSession(code, parsed.data);
      saveIdentity(membership);
      onJoined(membership);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Something went wrong');
      setBusy(false);
    }
  }

  if (loadError?.status === 404) return <NotFound />;
  if (loadError) {
    return (
      <div className={ui.center}>
        <p className={ui.error}>{loadError.message}</p>
      </div>
    );
  }
  if (!preview) return <p className={ui.muted}>Loading…</p>;

  return (
    <div className={ui.page}>
      <form className={ui.panel} onSubmit={onSubmit} noValidate>
        <h2 className={ui.heading}>{preview.hostName} invited you</h2>
        <p className={ui.muted}>
          {preview.memberCount} {preview.memberCount === 1 ? 'person' : 'people'} in session{' '}
          {preview.code} · {matchRules[preview.matchRule].description}
        </p>

        {preview.full ? (
          <p className={ui.error}>This session is full.</p>
        ) : (
          <>
            <label className={ui.field}>
              Your name
              <input
                className={ui.input}
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={24}
                autoComplete="nickname"
                enterKeyHint="go"
                autoFocus
              />
            </label>
            {error && (
              <p className={ui.error} role="alert">
                {error}
              </p>
            )}
            <button className={ui.primary} type="submit" disabled={busy}>
              {busy ? 'Joining…' : 'Join'}
            </button>
          </>
        )}
      </form>
    </div>
  );
}
