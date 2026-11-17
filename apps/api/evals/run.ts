/**
 * `npm run eval` (from the repo root), optionally `-- --only=deck|mediator|shopping`.
 * `npm run eval -- --capture` refreshes the recipe pools from Spoonacular (rarely).
 *
 * Runs every case in cases.ts against the real model and grades it with code
 * (graders.ts): no LLM judge, so scores are cheap and objective. Deck cases use
 * fixed recipe pools (fixtures/pools.json) with extra searches off, so runs compare
 * like with like and spend no recipe quota. Each case runs in a throwaway session
 * that is deleted afterwards. Costs about $0.10 per full run, logged in ai_calls
 * (kind "smoke") so it counts toward the monthly budget.
 *
 * Writes results/latest.json and RESULTS.md. Manual only, never in CI: it costs
 * money and the model isn't deterministic.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createPool, InMemoryApiCache } from '@yumanimous/db';
import { createSessionServer } from '@yumanimous/mcp-session';
import { SpoonacularClient } from '@yumanimous/mcp-recipes';
import {
  emptyPreferences,
  mergePreferences,
  summarizeRounds,
  withHistory,
  type Card,
  type PastRound,
  type Swipe,
} from '@yumanimous/shared';
import { PostgresAiCallLog } from '../src/ai/aiCallLog.js';
import type { AiUsage } from '../src/ai/agentRun.js';
import { ClaudeDeckAgent } from '../src/ai/deckAgent.js';
import { ClaudeFollowUpAgent } from '../src/ai/followUpAgents.js';
import { assembleDeck } from '../src/deck/aiDeckSource.js';
import { preferUnseen, staticRecipeDeck } from '../src/deck/deckSource.js';
import { RecipeDeckSource } from '../src/deck/recipeDeckSource.js';
import { contenders } from '../src/followUps/mediator.js';
import { PostgresSessionStore } from '../src/sessions/postgresSessionStore.js';
import { SessionService } from '../src/sessions/sessionService.js';
import { deckCases, mediatorCases, shoppingCases, type DeckCase } from './cases.js';
import { gradeDeck, gradeMediator, gradeShopping, type Facts } from './graders.js';
import { renderResults, type CaseResult } from './report.js';

const DIR = import.meta.dirname;
const POOLS = path.join(DIR, 'fixtures', 'pools.json');
const DECK_SIZE = 20;
const ROUND_ONE_CARDS = 12;

const model = process.env.AI_MODEL ?? 'claude-haiku-5-5';
const url = process.env.DATABASE_URL;
if (!url || !process.env.ANTHROPIC_API_KEY) {
  console.error('npm run eval needs DATABASE_URL and ANTHROPIC_API_KEY (see .env.example).');
  process.exit(1);
}
const capture = process.argv.includes('--capture');
const only = process.argv.find((a) => a.startsWith('--only='))?.slice('--only='.length);
/** `--case=round-2`: just the cases with this id (quick checks while tuning a prompt). */
const caseId = process.argv.find((a) => a.startsWith('--case='))?.slice('--case='.length);
const pick = <T extends { id: string }>(cases: T[]) =>
  caseId ? cases.filter((c) => c.id === caseId) : cases;

const pool = createPool(url);
const readOnly = createPool(url, { readOnly: true });
const store = new PostgresSessionStore(pool);
const service = new SessionService({ store, deckSource: staticRecipeDeck });
const aiLog = new PostgresAiCallLog(pool);
const sessionServer = () => createSessionServer({ pool: readOnly });
const deckAgent = new ClaudeDeckAgent({ model, createSessionServer: sessionServer });
const followUps = new ClaudeFollowUpAgent({ model, createSessionServer: sessionServer });

/** A throwaway session with these members and rules; deleted afterwards. */
async function withSession<T>(
  members: { name: string; rules: object }[],
  fn: (code: string, memberIds: string[]) => Promise<T>,
): Promise<T> {
  const host = await service.create({ hostName: members[0]!.name, matchRule: 'everyone' });
  try {
    const ids = [host.memberId];
    for (const m of members.slice(1)) ids.push((await service.join(host.code, m.name)).memberId);
    for (const [i, m] of members.entries()) {
      await service.setPreferences(host.code, ids[i]!, { ...emptyPreferences(), ...m.rules });
      // Online, so a running API's presence sweep leaves these members alone.
      await service.setConnected(host.code, ids[i]!, true);
    }
    return await fn(host.code, ids);
  } finally {
    await store.delete(host.code);
  }
}

async function groupOf(code: string) {
  const session = await store.get(code);
  if (!session) throw new Error('Eval session vanished');
  return { session, group: mergePreferences(session.members) };
}

async function log(code: string, usage: AiUsage, ms: number, ok: boolean) {
  await aiLog.record({
    sessionCode: code,
    kind: 'smoke',
    model,
    status: ok ? 'ok' : 'fallback',
    costUsd: usage.costUsd,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    durationMs: ms,
    numTurns: usage.numTurns,
    error: null,
  });
}

// ---------------------------------------------------------------- capture

type Pools = Record<string, { cards: Card[]; facts: Record<string, Facts> }>;

async function capturePools() {
  const key = process.env.SPOONACULAR_API_KEY;
  if (!key) throw new Error('--capture needs SPOONACULAR_API_KEY');
  const pools: Pools = {};
  for (const c of pick(deckCases)) {
    const facts: Record<string, Facts> = {};
    // A fresh in-memory cache, so every pool is fetched (and its facts recorded).
    const source = new RecipeDeckSource({
      client: new SpoonacularClient({ apiKey: key }),
      cache: new InMemoryApiCache(),
      catalog: {
        save: async (entries) => {
          for (const { card, facts: f } of entries) {
            const { vegetarian, vegan, glutenFree, dairyFree, readyInMinutes } = f as Facts;
            facts[card.id] = { vegetarian, vegan, glutenFree, dairyFree, readyInMinutes };
          }
        },
      },
      fallback: staticRecipeDeck,
      log: { info: () => {}, warn: console.warn },
    });
    const cards = await withSession(c.members, async (code) =>
      source.candidatePool((await groupOf(code)).group),
    );
    // Only what the agents and graders need: no recipe photos, credits or descriptions
    // from Spoonacular in the repo (the title stands in as the blurb).
    pools[c.id] = {
      cards: cards.map(({ id, title, tags }) => ({ id, title, tags, blurb: title })),
      facts,
    };
    console.log(`captured ${c.id}: ${cards.length} recipes`);
  }
  mkdirSync(path.dirname(POOLS), { recursive: true });
  writeFileSync(POOLS, `${JSON.stringify(pools, null, 2)}\n`);
}

// ---------------------------------------------------------------- deck

/** Round 1, played from the start of the pool: yum to some cuisines, skip others. */
function roundOne(cards: Card[], memberIds: string[], c: DeckCase): PastRound {
  const shown = cards.slice(0, ROUND_ONE_CARDS);
  const swipes: Swipe[] = shown.flatMap((card) =>
    memberIds.map((memberId) => ({
      memberId,
      cardId: card.id,
      direction: card.tags.some((t) => c.history!.yumTags.includes(t))
        ? ('like' as const)
        : ('skip' as const),
    })),
  );
  return {
    round: 1,
    cards: shown.map(({ id, title, tags }) => ({ id, title, tags })),
    swipes,
    decision: null,
  };
}

async function runDeck(c: DeckCase, pools: Pools): Promise<CaseResult> {
  const fixture = pools[c.id];
  if (!fixture) throw new Error(`No pool for ${c.id}: run npm run eval -- --capture`);
  return withSession(c.members, async (code, memberIds) => {
    const { session, group } = await groupOf(code);
    let candidates = fixture.cards;
    let seen = new Set<string>();
    let round = 1;
    if (c.history) {
      // What "Play again" leaves behind: round 1 in the session, seen cards out of
      // the pool, and the group's taste nudged by how everyone swiped.
      const past = [roundOne(fixture.cards, memberIds, c)];
      await pool.query('UPDATE sessions SET round = 2, past_rounds = $1 WHERE code = $2', [
        JSON.stringify(past),
        code,
      ]);
      seen = new Set(past[0]!.cards.map((card) => card.id));
      candidates = preferUnseen(fixture.cards, seen);
      group.soft.cuisineScores = withHistory(
        group.soft.cuisineScores,
        summarizeRounds(past, session.members),
      );
      round = 2;
    }

    const t0 = Date.now();
    const proposal = await deckAgent.buildDeck({
      sessionCode: code,
      deckSize: DECK_SIZE,
      pool: candidates,
      searchMore: null,
      round,
      signal: AbortSignal.timeout(180_000),
    });
    const ms = Date.now() - t0;
    const deck = assembleDeck(proposal, DECK_SIZE, group);
    await log(code, proposal.usage, ms, deck !== null);

    const names = c.members.map((m) => new RegExp(`\\b${m.name.split(' ')[0]}\\b`));
    const grade = gradeDeck({
      picks: proposal.picks,
      candidates: new Set(proposal.candidates.keys()),
      deck,
      pool: fixture.cards,
      fresh: candidates,
      facts: new Map(Object.entries(fixture.facts)),
      group,
      seen,
      forbidden: [...c.forbidden, ...names],
    });
    const pass =
      deck !== null &&
      grade.hardViolations.length === 0 &&
      grade.invented === 0 &&
      grade.deckSize === Math.min(DECK_SIZE, candidates.length) &&
      grade.seenInDeck === 0 &&
      grade.blurbProblems.length === 0 &&
      grade.tasteHits >= grade.baselineTasteHits - 2;
    return {
      job: 'deck',
      id: c.id,
      title: c.title,
      pass,
      costUsd: proposal.usage.costUsd,
      ms,
      grade,
    };
  });
}

// ---------------------------------------------------------------- mediator

async function runMediator(c: (typeof mediatorCases)[number]): Promise<CaseResult> {
  return withSession(c.members, async (code, memberIds) => {
    await service.start(code, memberIds[0]!);
    const { session } = await groupOf(code);
    for (const [i, card] of session.deck.entries()) {
      for (const [m, memberId] of memberIds.entries()) {
        const direction = c.yums[i]?.includes(m) ? 'like' : 'skip';
        await service.swipe(code, memberId, { cardId: card.id, direction });
      }
    }
    const after = (await groupOf(code)).session;
    const ranked = contenders(after.deck, after.swipes, memberIds, after.matchRule);

    const t0 = Date.now();
    const { pick, usage } = await followUps.pickCompromise({
      sessionCode: code,
      signal: AbortSignal.timeout(90_000),
    });
    const ms = Date.now() - t0;
    const grade = gradeMediator(
      pick,
      ranked,
      c.forbidden,
      c.members.map((m) => m.name),
    );
    await log(code, usage, ms, grade.accepted);
    return {
      job: 'mediator',
      id: c.id,
      title: c.title,
      pass: grade.accepted && grade.problems.length === 0,
      costUsd: usage.costUsd,
      ms,
      grade,
    };
  });
}

// ---------------------------------------------------------------- shopping

async function runShopping(c: (typeof shoppingCases)[number]): Promise<CaseResult> {
  const t0 = Date.now();
  const { plan, usage } = await followUps.planShoppingList({
    sessionCode: 'EVAL00',
    title: c.title,
    ingredients: c.ingredients,
    signal: AbortSignal.timeout(90_000),
  });
  const ms = Date.now() - t0;
  const grade = gradeShopping(
    plan,
    {
      ingredients: c.ingredients.length,
      merge: c.merge,
      staples: c.staples,
      groceries: c.groceries,
    },
    c.forbidden,
  );
  await log('EVAL00', usage, ms, grade.accepted);
  return {
    job: 'shopping',
    id: c.id,
    title: c.title,
    pass:
      grade.accepted &&
      grade.unmerged.length === 0 &&
      grade.quantityInName.length === 0 &&
      grade.problems.length === 0 &&
      grade.atHomeMisses.length <= 1,
    costUsd: usage.costUsd,
    ms,
    grade,
  };
}

// ---------------------------------------------------------------- main

try {
  if (capture) {
    await capturePools();
  } else {
    const pools = JSON.parse(readFileSync(POOLS, 'utf8')) as Pools;
    const results: CaseResult[] = [];
    const run = async (job: string, fn: () => Promise<CaseResult>) => {
      const r = await fn();
      console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${job}/${r.id}  $${r.costUsd.toFixed(4)}`);
      results.push(r);
      if (!r.pass) console.log(`      ${JSON.stringify(r.grade)}`);
    };
    if (!only || only === 'deck')
      for (const c of pick(deckCases)) await run('deck', () => runDeck(c, pools));
    if (!only || only === 'mediator')
      for (const c of pick(mediatorCases)) await run('mediator', () => runMediator(c));
    if (!only || only === 'shopping')
      for (const c of pick(shoppingCases)) await run('shopping', () => runShopping(c));

    if (only || caseId) {
      console.log('(partial run: results files not updated)');
    } else {
      mkdirSync(path.join(DIR, 'results'), { recursive: true });
      const stamped = { model, ranAt: new Date().toISOString(), results };
      writeFileSync(
        path.join(DIR, 'results', 'latest.json'),
        `${JSON.stringify(stamped, null, 2)}\n`,
      );
      writeFileSync(path.join(DIR, 'RESULTS.md'), renderResults(stamped));
    }
    const passed = results.filter((r) => r.pass).length;
    const cost = results.reduce((s, r) => s + r.costUsd, 0);
    console.log(
      `\n${passed}/${results.length} passed · $${cost.toFixed(4)} · see evals/RESULTS.md`,
    );
  }
} finally {
  await readOnly.end();
  await pool.end();
}
