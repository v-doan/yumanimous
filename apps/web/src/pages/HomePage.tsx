import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import {
  GuestNameSchema,
  SessionCodeSchema,
  matchRules,
  type MatchRuleId,
} from '@yumanimous/shared';
import { api, ApiRequestError } from '../lib/api';
import { saveIdentity } from '../lib/identity';
import ui from '../ui/ui.module.css';

export function HomePage() {
  return (
    <div className={ui.page}>
      <p className={ui.muted}>Can’t decide what to eat? Swipe together until you’re yumanimous.</p>
      <CreateSessionForm />
      <JoinByCodeForm />
      {/* Attribution required by the recipe API's terms. */}
      <p className={ui.muted}>
        Recipes from{' '}
        <a href="https://spoonacular.com/food-api" target="_blank" rel="noopener noreferrer">
          Spoonacular
        </a>
        .
      </p>
    </div>
  );
}

function CreateSessionForm() {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [rule, setRule] = useState<MatchRuleId>('everyone');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    // Validate with the same schema the server uses, for instant feedback.
    const parsed = GuestNameSchema.safeParse(name);
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? 'Invalid name');

    setBusy(true);
    setError(null);
    try {
      const membership = await api.createSession({ hostName: parsed.data, matchRule: rule });
      saveIdentity(membership);
      navigate(`/s/${membership.code}`);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Something went wrong');
      setBusy(false);
    }
  }

  return (
    <form className={ui.panel} onSubmit={onSubmit} noValidate>
      <h2 className={ui.heading}>Start a session</h2>
      <label className={ui.field}>
        Your name
        <input
          className={ui.input}
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={24}
          autoComplete="nickname"
          enterKeyHint="go"
        />
      </label>

      <fieldset className={ui.choices}>
        <legend className={ui.field}>It’s a match when…</legend>
        {Object.values(matchRules).map((r) => (
          <label key={r.id} className={ui.choice}>
            <input
              type="radio"
              name="matchRule"
              value={r.id}
              checked={rule === r.id}
              onChange={() => setRule(r.id)}
            />
            <span className={ui.choiceTitle}>{r.label}</span>
            <span className={ui.choiceHint}>{r.description}</span>
          </label>
        ))}
      </fieldset>

      {error && (
        <p className={ui.error} role="alert">
          {error}
        </p>
      )}
      <button className={ui.primary} type="submit" disabled={busy}>
        {busy ? 'Creating…' : 'Create session'}
      </button>
    </form>
  );
}

function JoinByCodeForm() {
  const navigate = useNavigate();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const parsed = SessionCodeSchema.safeParse(code);
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? 'Invalid code');
    navigate(`/s/${parsed.data}`);
  }

  return (
    <form className={ui.panel} onSubmit={onSubmit} noValidate>
      <h2 className={ui.heading}>Join with a code</h2>
      <label className={ui.field}>
        Session code
        <input
          className={`${ui.input} ${ui.codeInput}`}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          maxLength={6}
          autoCapitalize="characters"
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="go"
        />
      </label>
      {error && (
        <p className={ui.error} role="alert">
          {error}
        </p>
      )}
      <button className={ui.secondary} type="submit">
        Join
      </button>
    </form>
  );
}
