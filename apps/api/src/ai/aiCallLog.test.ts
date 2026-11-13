import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, databaseUrl } from '@yumanimous/db/testing';
import {
  BudgetGuard,
  InMemoryAiCallLog,
  PostgresAiCallLog,
  type AiCall,
  type AiCallLog,
} from './aiCallLog.js';

const call = (p: Partial<AiCall> = {}): AiCall => ({
  sessionCode: 'ABCDEF',
  kind: 'deck',
  model: 'claude-haiku-5-5',
  status: 'ok',
  costUsd: 0.01,
  inputTokens: 100,
  outputTokens: 50,
  cacheReadTokens: 1000,
  cacheWriteTokens: 0,
  durationMs: 4000,
  numTurns: 3,
  error: null,
  ...p,
});

const NOV_12 = Date.UTC(2026, 10, 12);

describe.each(['memory', 'postgres'] as const)('AiCallLog (%s)', (kind) => {
  describe.skipIf(kind === 'postgres' && !databaseUrl)('', () => {
    let db: Awaited<ReturnType<typeof createTestDatabase>> | undefined;
    let log: AiCallLog;

    beforeAll(async () => {
      if (kind === 'postgres') db = await createTestDatabase();
    });
    afterAll(async () => {
      await db?.drop();
    });
    beforeEach(async () => {
      if (db) await db.pool.query('TRUNCATE ai_calls');
      log = db ? new PostgresAiCallLog(db.pool) : new InMemoryAiCallLog(() => NOV_12);
    });

    it('records calls and lists them newest first, optionally per session', async () => {
      await log.record(call({ sessionCode: 'ABCDEF', costUsd: 0.01 }));
      await log.record(call({ sessionCode: 'GHJKMN', kind: 'rerank', costUsd: 0.002 }));
      const all = await log.list({ limit: 10 });
      expect(all.map((c) => c.kind)).toEqual(['rerank', 'deck']);
      const one = await log.list({ sessionCode: 'GHJKMN', limit: 10 });
      expect(one).toHaveLength(1);
      expect(one[0]).toMatchObject({ costUsd: 0.002, model: 'claude-haiku-5-5' });
    });

    it('sums this month’s spend', async () => {
      await log.record(call({ costUsd: 0.25 }));
      await log.record(call({ costUsd: 0.5, status: 'error' })); // Failed runs cost too.
      // Postgres stamps rows with now(); compare against the real clock there.
      const now = db ? Date.now() : NOV_12;
      expect(await log.monthToDateUsd(now)).toBeCloseTo(0.75, 6);
    });

    it('keeps long error messages bounded', async () => {
      await log.record(call({ status: 'error', error: 'x'.repeat(5000) }));
      expect((await log.list({ limit: 1 }))[0]!.error).toHaveLength(500);
    });
  });
});

describe('monthly boundary', () => {
  it('only counts the current calendar month (UTC)', async () => {
    let clock = Date.UTC(2026, 9, 31, 23, 0); // Oct 31
    const log = new InMemoryAiCallLog(() => clock);
    await log.record(call({ costUsd: 3 }));
    clock = Date.UTC(2026, 10, 1, 1, 0); // Nov 1
    await log.record(call({ costUsd: 1 }));
    expect(await log.monthToDateUsd(clock)).toBe(1);
  });
});

describe('BudgetGuard', () => {
  it('allows runs until the month’s spend reaches the budget', async () => {
    const log = new InMemoryAiCallLog(() => NOV_12);
    const guard = new BudgetGuard(log, 1, () => NOV_12);
    await log.record(call({ costUsd: 0.6 }));
    expect(await guard.status()).toEqual({ spentUsd: 0.6, budgetUsd: 1, allowed: true });
    await log.record(call({ costUsd: 0.4 }));
    expect((await guard.status()).allowed).toBe(false);
  });
});
