/**
 * `npm run deck:bench -w @yumanimous/api -- [--thinking=adaptive|disabled]`
 *
 * One real deck build for a fixed test group, in a throwaway session that is deleted
 * afterwards (so runs are comparable and no real session is touched): prints
 * wall time per stage, cost, turns, and quality checks (valid picks, blurbs, taste
 * fit, hard-rule violations). Used to compare settings before changing defaults.
 * Costs a few cents per run; each run is logged in ai_calls (kind "smoke") so it
 * counts toward the monthly budget.
 */
import { createPool, noopCardCatalog, PostgresApiCache } from '@yumanimous/db';
import { createSessionServer } from '@yumanimous/mcp-session';
import { SpoonacularClient } from '@yumanimous/mcp-recipes';
import { emptyPreferences, mergePreferences, type MemberPreferences } from '@yumanimous/shared';
import { PostgresAiCallLog } from '../src/ai/aiCallLog.js';
import { ClaudeDeckAgent } from '../src/ai/deckAgent.js';
import { assembleDeck, cleanBlurb } from '../src/deck/aiDeckSource.js';
import { staticRecipeDeck } from '../src/deck/deckSource.js';
import { RecipeDeckSource, softScore } from '../src/deck/recipeDeckSource.js';
import { PostgresSessionStore } from '../src/sessions/postgresSessionStore.js';
import { SessionService } from '../src/sessions/sessionService.js';

/** The fixed test group: one hard diet, one allergy, and clear tastes. */
const GROUP: { name: string; rules: Partial<MemberPreferences> }[] = [
  { name: 'Vy', rules: { diets: ['vegetarian'], cravings: ['spicy'] } },
  { name: 'Sam', rules: { intolerances: ['peanut'], cuisinesLiked: ['Thai'] } },
  { name: 'Kim', rules: { cuisinesLiked: ['Indian', 'Mexican'], cuisinesDisliked: ['American'] } },
];

const thinking = process.argv.includes('--thinking=disabled') ? 'disabled' : 'adaptive';
const model = process.env.AI_MODEL ?? 'claude-haiku-5-5';
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('Usage: deck:bench [--thinking=disabled]  (needs DATABASE_URL)');
  process.exit(1);
}

const pool = createPool(url);
const readOnly = createPool(url, { readOnly: true });
const store = new PostgresSessionStore(pool);
// Only create/join/setPreferences are used: the deck is built below, not by start().
const service = new SessionService({ store, deckSource: staticRecipeDeck });
const host = await service.create({ hostName: GROUP[0]!.name, matchRule: 'everyone' });
const code = host.code;
try {
  const memberIds = [host.memberId];
  for (const m of GROUP.slice(1)) memberIds.push((await service.join(code, m.name)).memberId);
  for (const [i, m] of GROUP.entries()) {
    await service.setPreferences(code, memberIds[i]!, { ...emptyPreferences(), ...m.rules });
    // Online, so the running API's presence sweep leaves these test members alone.
    await service.setConnected(code, memberIds[i]!, true);
  }
  const session = await store.get(code);
  if (!session) throw new Error('Test session vanished');
  const group = mergePreferences(session.members);
  console.log('group hard rules:', JSON.stringify(group.hard));

  const recipes = new RecipeDeckSource({
    client: process.env.SPOONACULAR_API_KEY
      ? new SpoonacularClient({ apiKey: process.env.SPOONACULAR_API_KEY })
      : null,
    cache: new PostgresApiCache(pool),
    catalog: noopCardCatalog,
    fallback: staticRecipeDeck,
    log: { info: () => {}, warn: console.warn },
  });
  const candidatePool = await recipes.candidatePool(group);
  const agent = new ClaudeDeckAgent({
    model,
    thinking,
    createSessionServer: () => createSessionServer({ pool: readOnly }),
    ...(process.argv.includes('--trace') ? { trace: (line: string) => console.log(line) } : {}),
  });

  const t0 = Date.now();
  const proposal = await agent.buildDeck({
    sessionCode: code,
    deckSize: 20,
    pool: candidatePool,
    searchMore: recipes.canSearch ? (extra) => recipes.searchMore(group.hard, extra) : null,
    signal: new AbortController().signal,
  });
  const wallMs = Date.now() - t0;
  const deck = assembleDeck(proposal, 20, group);

  // ---- quality ----
  const picked = proposal.picks.map((p) => p.cardId);
  const valid = picked.filter((id) => proposal.candidates.has(id));
  const unique = new Set(valid);
  const blurbsOk = proposal.picks.filter((p) => cleanBlurb(p.blurb) !== null).length;
  const ids = picked;
  const top10 = (deck ?? []).slice(0, 10);
  const tasteHits = top10.filter((c) => softScore(c, group.soft) > 0).length;

  // Hard-rule check against the facts Spoonacular gave for each card.
  const { rows } = await pool.query<{ id: string; facts: Record<string, unknown> }>(
    'SELECT id, facts FROM cards WHERE id = ANY($1)',
    [(deck ?? []).map((c) => c.id)],
  );
  const facts = new Map(rows.map((r) => [r.id, r.facts]));
  const dietFlag: Record<string, string> = {
    vegetarian: 'vegetarian',
    vegan: 'vegan',
    'gluten free': 'glutenFree',
  };
  const violations = (deck ?? []).filter((c) =>
    group.hard.diets.some((d) => dietFlag[d] && facts.get(c.id)?.[dietFlag[d]!] === false),
  );

  const u = proposal.usage;
  console.log(`\n=== ${model}, thinking=${thinking} ===`);
  console.log(
    `wall ${(wallMs / 1000).toFixed(1)}s · ${u.numTurns} turns · $${u.costUsd.toFixed(4)} · out ${u.outputTokens} tok · cache read ${u.cacheReadTokens}`,
  );
  console.log(
    'stages (s):',
    Object.entries(proposal.stages ?? {})
      .map(([k, v]) => `${k} ${(v / 1000).toFixed(1)}`)
      .join(' · '),
  );
  console.log(
    `picks ${ids.length} · valid ${valid.length} · unique ${unique.size} · invented ${ids.length - valid.length} · blurbs ok ${blurbsOk}/${ids.length}`,
  );
  console.log(
    `deck ${deck ? deck.length : 'FALLBACK'} · top-10 taste hits ${tasteHits}/10 · hard-rule violations ${violations.length}`,
  );
  console.log('top 10:', top10.map((c) => c.title.slice(0, 30)).join(' | '));
  for (const p of proposal.picks.slice(0, 3)) console.log(`  blurb: ${p.blurb}`);

  await new PostgresAiCallLog(pool).record({
    sessionCode: code,
    kind: 'smoke',
    model,
    status: deck ? 'ok' : 'fallback',
    costUsd: u.costUsd,
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
    cacheReadTokens: u.cacheReadTokens,
    cacheWriteTokens: u.cacheWriteTokens,
    durationMs: wallMs,
    numTurns: u.numTurns,
    error: null,
  });
} finally {
  await store.delete(code); // Throwaway: nothing of it stays, except its cost row.
  await readOnly.end();
  await pool.end();
}
