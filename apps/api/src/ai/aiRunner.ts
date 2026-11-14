import type { AiCallKind, AiCallLog, AiCallStatus, BudgetGuard } from './aiCallLog.js';
import { AgentRunError, type AiUsage } from './agentRun.js';

export interface AiRunnerOptions {
  log: AiCallLog;
  budget: BudgetGuard;
  /** For runs that fail before reporting usage. */
  model: string;
  warn?: (message: string) => void;
}

/**
 * The bookkeeping around every AI run, shared by the deck, shopping list and
 * mediator: check the monthly budget first, run under a timeout, and log what each
 * run cost, including runs that failed or were skipped.
 */
export class AiRunner {
  readonly warn: (message: string) => void;

  constructor(private readonly opts: AiRunnerOptions) {
    this.warn = opts.warn ?? ((m) => console.warn(m));
  }

  /** False (and logged as skipped) once this month's or today's spend reaches its cap. */
  async withinBudget(sessionCode: string, kind: AiCallKind): Promise<boolean> {
    const budget = await this.opts.budget.status();
    if (budget.allowed) return true;
    this.warn(
      `[ai] AI budget reached ($${budget.spentUsd.toFixed(2)} of $${budget.budgetUsd} this month` +
        `${budget.todayUsd !== undefined ? `, $${budget.todayUsd.toFixed(2)} of $${budget.dailyBudgetUsd} today` : ''}); skipping ${kind}`,
    );
    await this.record(sessionCode, kind, 'skipped', null, 'AI budget reached');
    return false;
  }

  /** Runs one agent job under a timeout. Errors are logged (with cost) and return null. */
  async run<T extends { usage: AiUsage }>(
    sessionCode: string,
    kind: AiCallKind,
    timeoutMs: number,
    job: (signal: AbortSignal) => Promise<T>,
  ): Promise<{ result: T; usage: AiUsage } | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const started = Date.now();
    try {
      const result = await job(controller.signal);
      return { result, usage: result.usage };
    } catch (err) {
      const message = controller.signal.aborted
        ? `Timed out after ${timeoutMs} ms`
        : (err as Error).message;
      this.warn(`[ai] ${sessionCode} ${kind} failed: ${message}`);
      // A failed run can still have cost money; AgentRunError carries what it spent.
      const usage =
        err instanceof AgentRunError
          ? err.usage
          : { ...emptyUsage(this.opts.model), durationMs: Date.now() - started };
      await this.record(sessionCode, kind, 'error', usage, message);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async record(
    sessionCode: string,
    kind: AiCallKind,
    status: AiCallStatus,
    usage: AiUsage | null,
    error: string | null,
  ) {
    const u = usage ?? emptyUsage(this.opts.model);
    try {
      await this.opts.log.record({
        sessionCode,
        kind,
        status,
        model: u.model,
        costUsd: u.costUsd,
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
        cacheReadTokens: u.cacheReadTokens,
        cacheWriteTokens: u.cacheWriteTokens,
        durationMs: u.durationMs,
        numTurns: u.numTurns,
        error,
      });
    } catch (err) {
      // Logging must never break the feature it's logging.
      this.warn(`[ai] could not log AI call: ${(err as Error).message}`);
    }
  }
}

export const emptyUsage = (model: string): AiUsage => ({
  model,
  costUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  durationMs: 0,
  numTurns: 0,
});
