import type pg from 'pg';

export type AiCallKind = 'deck' | 'rerank' | 'smoke' | 'shopping' | 'mediator';
export type AiCallStatus = 'ok' | 'fallback' | 'error' | 'skipped';

/** One AI run, as logged. CLAUDE.md: log the cost and latency of every AI call. */
export interface AiCall {
  sessionCode: string | null;
  kind: AiCallKind;
  model: string;
  status: AiCallStatus;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  durationMs: number;
  numTurns: number;
  error: string | null;
}

export interface LoggedAiCall extends AiCall {
  id: number;
  createdAt: string;
}

export interface AiCallLog {
  record: (call: AiCall) => Promise<void>;
  /** Total cost since the start of the current calendar month (UTC). */
  monthToDateUsd: (now: number) => Promise<number>;
  /** Total cost since the start of the current day (UTC). */
  dayToDateUsd: (now: number) => Promise<number>;
  list: (filter: { sessionCode?: string; limit: number }) => Promise<LoggedAiCall[]>;
}

const monthStart = (now: number) => {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
};

const dayStart = (now: number) => {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
};

/** Errors can quote model output; keep the log readable and bounded. */
const clip = (text: string | null) => (text === null ? null : text.slice(0, 500));

export class InMemoryAiCallLog implements AiCallLog {
  private calls: LoggedAiCall[] = [];

  constructor(private readonly now: () => number = Date.now) {}

  async record(call: AiCall) {
    this.calls.push({
      ...call,
      error: clip(call.error),
      id: this.calls.length + 1,
      createdAt: new Date(this.now()).toISOString(),
    });
  }

  async monthToDateUsd(now: number) {
    return this.spentSince(monthStart(now));
  }

  async dayToDateUsd(now: number) {
    return this.spentSince(dayStart(now));
  }

  private spentSince(start: number) {
    return this.calls
      .filter((c) => Date.parse(c.createdAt) >= start)
      .reduce((sum, c) => sum + c.costUsd, 0);
  }

  async list({ sessionCode, limit }: { sessionCode?: string; limit: number }) {
    return this.calls
      .filter((c) => !sessionCode || c.sessionCode === sessionCode)
      .slice(-limit)
      .reverse();
  }
}

export class PostgresAiCallLog implements AiCallLog {
  constructor(private readonly pool: pg.Pool) {}

  async record(c: AiCall) {
    await this.pool.query(
      `INSERT INTO ai_calls (session_code, kind, model, status, cost_usd, input_tokens,
         output_tokens, cache_read_tokens, cache_write_tokens, duration_ms, num_turns, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        c.sessionCode,
        c.kind,
        c.model,
        c.status,
        c.costUsd,
        c.inputTokens,
        c.outputTokens,
        c.cacheReadTokens,
        c.cacheWriteTokens,
        c.durationMs,
        c.numTurns,
        clip(c.error),
      ],
    );
  }

  async monthToDateUsd(now: number) {
    return this.spentSince(monthStart(now));
  }

  async dayToDateUsd(now: number) {
    return this.spentSince(dayStart(now));
  }

  private async spentSince(start: number) {
    const { rows } = await this.pool.query<{ total: string | null }>(
      'SELECT sum(cost_usd) AS total FROM ai_calls WHERE created_at >= $1',
      [new Date(start)],
    );
    return Number(rows[0]?.total ?? 0);
  }

  async list({ sessionCode, limit }: { sessionCode?: string; limit: number }) {
    const { rows } = await this.pool.query<{
      id: string;
      session_code: string | null;
      kind: AiCallKind;
      model: string;
      status: AiCallStatus;
      cost_usd: string;
      input_tokens: number;
      output_tokens: number;
      cache_read_tokens: number;
      cache_write_tokens: number;
      duration_ms: number;
      num_turns: number;
      error: string | null;
      created_at: Date;
    }>(
      `SELECT * FROM ai_calls WHERE ($1::text IS NULL OR session_code = $1)
       ORDER BY id DESC LIMIT $2`,
      [sessionCode ?? null, limit],
    );
    return rows.map((r) => ({
      id: Number(r.id),
      sessionCode: r.session_code,
      kind: r.kind,
      model: r.model,
      status: r.status,
      costUsd: Number(r.cost_usd),
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      cacheReadTokens: r.cache_read_tokens,
      cacheWriteTokens: r.cache_write_tokens,
      durationMs: r.duration_ms,
      numTurns: r.num_turns,
      error: r.error,
      createdAt: r.created_at.toISOString(),
    }));
  }
}

/**
 * The app's own spending caps, below the Console's hard limit. Checked before every
 * run; when this month's (or, if set, today's) logged spend reaches its cap, AI
 * features switch off and the non-AI versions are used until it rolls over.
 *
 * The daily cap is what keeps a public deployment usable: without it, one busy (or
 * abusive) day could spend the whole month's budget.
 */
export class BudgetGuard {
  constructor(
    private readonly log: AiCallLog,
    private readonly monthlyUsd: number,
    private readonly now: () => number = Date.now,
    private readonly dailyUsd: number | null = null,
  ) {}

  async status() {
    const now = this.now();
    const spent = await this.log.monthToDateUsd(now);
    const monthOk = spent < this.monthlyUsd;
    if (this.dailyUsd === null) {
      return { spentUsd: spent, budgetUsd: this.monthlyUsd, allowed: monthOk };
    }
    const today = await this.log.dayToDateUsd(now);
    return {
      spentUsd: spent,
      budgetUsd: this.monthlyUsd,
      todayUsd: today,
      dailyBudgetUsd: this.dailyUsd,
      allowed: monthOk && today < this.dailyUsd,
    };
  }
}
