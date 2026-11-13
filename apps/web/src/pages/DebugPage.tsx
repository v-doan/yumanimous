import { useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { z } from 'zod';
import { API_URL } from '../lib/api';
import ui from '../ui/ui.module.css';
import styles from './DebugPage.module.css';

const DebugSchema = z.object({
  month: z.object({ spentUsd: z.number(), budgetUsd: z.number(), allowed: z.boolean() }),
  calls: z.array(
    z.object({
      id: z.number(),
      sessionCode: z.string().nullable(),
      kind: z.string(),
      model: z.string(),
      status: z.string(),
      costUsd: z.number(),
      inputTokens: z.number(),
      outputTokens: z.number(),
      cacheReadTokens: z.number(),
      durationMs: z.number(),
      numTurns: z.number(),
      error: z.string().nullable(),
      createdAt: z.string(),
    }),
  ),
});

type Debug = z.infer<typeof DebugSchema>;

/**
 * Development only (routed only in dev builds, and the API serves it only with
 * DEBUG_ROUTES=true): the cost and latency of every AI run, per session or overall.
 */
export function DebugPage() {
  const { code } = useParams();
  const [data, setData] = useState<Debug | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const query = code ? `?session=${encodeURIComponent(code)}` : '';
    fetch(`${API_URL}/api/debug/ai${query}`)
      .then(async (res) => {
        if (res.status === 404)
          throw new Error('Debug routes are off: set DEBUG_ROUTES=true in .env');
        setData(DebugSchema.parse(await res.json()));
      })
      .catch((err: Error) => setError(err.message));
  }, [code]);

  if (error) return <p className={ui.error}>{error}</p>;
  if (!data) return <p className={ui.muted}>Loading…</p>;

  const total = data.calls.reduce((sum, c) => sum + c.costUsd, 0);

  return (
    <div className={ui.page}>
      <section className={ui.panel}>
        <h2 className={ui.heading}>AI runs {code ? `· ${code}` : '· all sessions'}</h2>
        <p className={ui.muted}>
          This month: <strong>${data.month.spentUsd.toFixed(4)}</strong> of ${data.month.budgetUsd}{' '}
          {data.month.allowed ? '' : '(budget reached: AI is off)'}
          {code && (
            <>
              {' '}
              · this session: <strong>${total.toFixed(4)}</strong>
            </>
          )}
        </p>
        <p className={ui.muted}>
          Costs are the Agent SDK’s estimates; the Console bill is the truth.
        </p>
      </section>

      <div className={styles.scroll}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>When</th>
              {!code && <th>Session</th>}
              <th>Kind</th>
              <th>Status</th>
              <th>Cost</th>
              <th>Tokens in / out / cached</th>
              <th>Time</th>
              <th>Turns</th>
            </tr>
          </thead>
          <tbody>
            {data.calls.map((c) => (
              <tr key={c.id} title={c.error ?? undefined}>
                <td>{new Date(c.createdAt).toLocaleTimeString()}</td>
                {!code && <td>{c.sessionCode ?? '-'}</td>}
                <td>{c.kind}</td>
                <td className={c.status === 'ok' ? '' : styles.warn}>{c.status}</td>
                <td>${c.costUsd.toFixed(4)}</td>
                <td>
                  {c.inputTokens} / {c.outputTokens} / {c.cacheReadTokens}
                </td>
                <td>{(c.durationMs / 1000).toFixed(1)} s</td>
                <td>{c.numTurns}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {data.calls.length === 0 && <p className={ui.muted}>No AI runs yet.</p>}
      </div>
    </div>
  );
}
