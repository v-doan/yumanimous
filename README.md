# Yumanimous

Swipe-to-decide for groups: everyone swipes on a shared deck, and it's a match when the group is
_yumanimous_. Zero install: join from a link in the group chat.

> Work in progress. Phase 8: "Play again" runs another round with the same people, and the next deck
> learns from how everyone swiped. Earlier phases: a sous-chef agent's shared shopping list and a
> no-match mediator, an orchestrator with scout, curator and writer subagents that builds each deck
> (under 1¢), live sessions over WebSockets, Postgres, a cached recipe API, MCP servers, and food
> rules that bind the whole group.

## Quick start

Requires Node 22.22 or newer (see `.nvmrc`; react-router 8 needs it).

```sh
npm install
cp .env.example .env   # then add your SPOONACULAR_API_KEY
npm run db:up      # Postgres 18 in Docker (needs Docker Desktop running)
npm run dev        # API on :3001 + web on http://localhost:5173 (also exposed on your LAN)
npm test           # all workspaces
npm run lint
npm run typecheck
npm run build
```

**On phones:** run `npm run dev`, then open the `Network:` URL Vite prints (e.g.
`http://192.168.x.x:5173`) on phones connected to the same Wi-Fi. Create a session on one phone,
share the link, join from the others. On Windows, allow Node.js on private networks when the
firewall asks. In development, Vite proxies `/api` and `/socket.io` to the API, so phones only ever
talk to one origin.

Configuration lives in `.env.example`. Everything is optional: without `DATABASE_URL` sessions
live in memory, and without `SPOONACULAR_API_KEY` the deck is a set of hard-coded recipes.

Tests start their own throwaway Postgres with [Testcontainers](https://testcontainers.com/), so
`npm test` needs Docker running for the database tests. Without Docker those tests are skipped
with a warning, and everything else still runs. Set `TEST_DATABASE_URL` to use an existing server.

## How a session works

1. The host creates a session (`POST /api/sessions`) and picks a match rule.
2. Friends open `/s/:code`, type a name, and join (`POST /api/sessions/:code/members`). Each
   member gets a random token, kept in `localStorage`, so a refresh rejoins as the same person.
3. Each browser opens a Socket.io connection, authenticated by that token, into the session's room.
4. The host starts; swipes go to the server, which applies the match rule and broadcasts the full
   session state plus a `session:match` event when a card wins.

The server owns all state. Swiping, vote counting and matching are plain code, with no AI in the
hot path.

| Match rule   | A card matches when…              |
| ------------ | --------------------------------- |
| **everyone** | every member says yum (default)   |
| **majority** | more than half of members say yum |

Members who drop offline still count for 2 minutes (refresh, locked phone), then they are removed
and their votes stop counting. If the host is removed, the earliest-joined member who is online
becomes host. Late joiners swipe the full deck; matches that already happened stay matched.

## Food rules

In the lobby, each member types their rules in plain words: _"vegetarian, allergic to peanuts,
nothing over 45 min, love spicy"_. A keyword parser
([`preferenceParser.ts`](packages/shared/src/preferenceParser.ts)) turns that into chips as they
type, in the browser, with no AI and no network. The member removes anything it got wrong and saves.
Only the confirmed chips are sent (all enums or validated short words), never the typed text.

| Kind             | Examples                                                | Effect                                      |
| ---------------- | ------------------------------------------------------- | ------------------------------------------- |
| **Must** (hard)  | vegan, gluten free, no peanut, no kiwi, under 30 min    | Filters the deck for the **whole group**    |
| **Prefer**       | likes Thai, not keen on mushroom, in the mood for spicy | Ranks the deck                              |
| **Can't filter** | halal, kosher, low sodium                               | Shown to everyone: "check these yourselves" |

- **Anyone's restriction binds everyone.** `mergePreferences` unions every member's hard rules (and
  drops redundant ones: vegan implies vegetarian). The smallest time limit wins.
- **The deck is built when the host starts**, by a recipe search _with_ those filters, so the recipe
  API applies them. With hard rules there is no fallback to the unchecked hard-coded recipes: if the
  search can't run, or fewer than 3 recipes fit, the host is told why.
- **Late joiners** get one chance to add rules before their first card. If the deck wasn't filtered
  for one of them, everyone sees a warning naming the rule, and the host can rebuild the deck (which
  clears the votes, since they were cast on a different deck).
- The parser leans safe: any negated mention of an allergen ("no nuts", "can't have eggs") is a hard
  rule. It's covered by ~45 real-world phrasings in
  [`preferences.test.ts`](packages/shared/src/preferences.test.ts), including negations ("not
  vegetarian"), lists ("no peanuts and shellfish"), unknown allergens ("allergic to kiwi") and a
  prompt-injection attempt, which stays inert.

## AI deck building

When the host starts, a Claude **orchestrator** (Claude Agent SDK, `claude-haiku-5-5`) delegates to
three subagents, each limited to the tools its job needs:

| Agent        | Tools                                                                                            | Job                                           |
| ------------ | ------------------------------------------------------------------------------------------------ | --------------------------------------------- |
| orchestrator | `Agent` (delegation) only                                                                        | Runs scout, then curator, then writer         |
| scout        | `list_candidates`, `search_candidates`, `get_member_preferences`, `get_round_history`¹           | Widens the pool towards the group's tastes    |
| curator      | `list_candidates`, `submit_order`, `get_member_preferences`, `get_session`, `get_round_history`¹ | Picks and orders 20 cards for the whole group |
| writer       | `list_chosen`, `submit_blurbs`                                                                   | A short, fun blurb per card                   |

¹ From round 2 (see [Play again](#play-again-round-memory)).

The session tools are the Phase 4 `mcp-session` server, attached in-process on a read-only Postgres
connection. While it runs, everyone sees _"Scouting recipes… Picking dishes everyone will like…"_
live.

**Work is handed in through tools, not text.** The curator calls `submit_order` and the writer
`submit_blurbs`; the code validates each on arrival and assembles the deck. No agent retypes cards
into a final answer (that was slow, cost tokens, and was one more place to garble an id). Because the
order is known before the writer starts, **the deck goes live as soon as the curator submits**, with
the recipe blurbs, and the AI blurbs replace them on everyone's screen a few seconds later.

**AI suggests, code enforces.** The model never decides what is safe to eat:

- The candidate pool comes from the Phase 5 search **with** the group's hard rules. The scout's
  `search_candidates` tool has no diet or allergen parameters at all; the code injects the rules
  into every search, so the scout can add "Thai" but can't drop "no peanuts".
- The proposal is validated in [`aiDeckSource.ts`](apps/api/src/deck/aiDeckSource.ts): cards must
  come from the candidate pool, appear once, and have a clean blurb of at most 160 characters (no
  diet or health claims, no names). Invented or repeated cards are dropped.
- Budget reached, a 60 s timeout, a refusal, bad output, any error: the non-AI deck is used, so a
  session can always start.
- Guest names and recipe titles reach the model only as JSON tool results, never in the prompt.

**Re-rank.** Once every member has swiped 8 cards, a background run reads the swipe history and
reorders the cards **nobody has swiped yet**. Cards anyone swiped never move, so nobody's place
changes, and swiping never waits for AI. It runs once per session.

**Locked down.** `tools: ['Agent']`, explicit `allowedTools`, `permissionMode: 'dontAsk'`,
`settingSources: []`, `strictMcpConfig` and `disableClaudeAiConnectors` (so a developer's own
settings, `.mcp.json` or claude.ai connectors never reach the agents), `persistSession: false`
(transcripts contain guest names), and a per-run `maxBudgetUsd`. Subagents are forced inline
(`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS`): by default they run in the background, which restarts the
orchestrator after each one and made runs up to 4x dearer and much slower, at the model's whim.

**One build at a time.** A second Start (a double tap, or the host refreshing mid-build) joins the
build already running instead of paying for another.

**Cost and speed.** Every run is logged in `ai_calls` with tokens, cost and time; the dev page
`/debug` (or `/debug/s/:code`) shows them. Measured on `claude-haiku-5-5`:

| Version                                                    | Cost per deck | Cards visible after            | Turns |
| ---------------------------------------------------------- | ------------- | ------------------------------ | ----- |
| First version (background subagents, deck retyped as JSON) | ~$0.025–0.03  | 30–60 s                        | 11–12 |
| Now (inline, handed in via tools, live on order)           | **~$0.0055**  | **~15 s** (blurbs ~11 s later) | **4** |

A re-rank costs about $0.001 (3 s). Three limits stack: a per-run cap, the app's
`AI_MONTHLY_BUDGET_USD` (default $8, after which AI switches off until next month) and the Console's
workspace spend limit. At these prices $8 covers well over a thousand sessions a month.

Set `AI_TRACE=true` to log one line per agent message (which subagent ran, every tool call, timing).
Two dev scripts: `npm run agent:smoke -w @yumanimous/api` (one tiny real call, under 1¢, to check a
new machine) and `npm run deck:bench -w @yumanimous/api -- [--trace]` (one real build for a fixed
test group in a throwaway session: time per stage, cost, and quality checks).

## After the decision

**Shopping list (sous-chef).** On a match, anyone can tap _Shopping list_, say how many are eating
(it starts at the number of people in the session), and the whole group gets one live list: "we have
it" ticks show on everyone's phone, the servings can be changed later, and _Copy list_ puts what's
left to buy on the clipboard for the group chat.

1. The recipe comes from `get_recipe` on the Phase 4 `mcp-recipes` server, connected in-process
   through an MCP client, with the same Postgres cache (30 days), so a recipe costs at most one API
   call.
2. **Code scales every amount** ([`scale.ts`](apps/api/src/followUps/scale.ts)): summed per unit
   before rounding (3 × ⅓ cup is 1 cup), rounded for a shop (whole onions, quarter cups, grams to
   the nearest 5), never converted between units ("1 cup + 2 tbsp").
3. The sous-chef (one agent, `claude-haiku-5-5`) only groups and names: it merges the garlic used
   twice into one line, names it for a shopper, picks an aisle, and marks salt, oil and water as
   probably at home. It hands in lines through `submit_shopping_list`, where each line lists the
   ingredients it covers. **A list that drops, repeats or invents an ingredient is refused** with the
   reason, so the model can fix it (3 tries). The quantity on each line is computed by code from
   what it covers: the model never writes a number.
4. Over budget, a failure, or no valid list: the plain list (one line per ingredient, by the recipe
   API's aisle) is used instead. Changing servings later is arithmetic only, with no AI call.

**Mediator.** When everyone has finished and nothing matched, a mediator agent reads the vote tally
and everyone's food preferences through `mcp-session` and suggests one card with a short reason.
Anyone can tap _Go with it_, and the shopping list follows. The code checks the pick
([`mediator.ts`](apps/api/src/followUps/mediator.ts)): it must be in the deck and **at most one yum
behind the top card**, so the mediator can break a tie or favour a near-miss but never overrule the
votes, and the reason is cleaned and capped at 280 characters. Otherwise the top card is suggested,
with a plain reason. It runs once per deck, claimed in the same transaction as the swipe (or leave)
that finished the session, in the background.

| Run              | Cost (measured) | Time  |
| ---------------- | --------------- | ----- |
| Shopping list    | ~$0.0008        | ~4 s  |
| Mediator         | ~$0.0011        | ~4 s  |
| Deck (for scale) | ~$0.005–0.007   | ~25 s |

Both are logged in `ai_calls` and shown on `/debug`, under the same monthly budget.

## Play again (round memory)

When a round has a pick, or everyone has finished, the host can tap **Play again**: same people, same
food rules, same link, and a fresh deck that learns from the round before.

- **No repeats.** Every card already shown stays out of the next deck, while enough other safe cards
  exist (otherwise they're dealt last rather than leaving the round empty).
- **It learns each person's taste.** [`summarizeRounds`](packages/shared/src/rounds.ts) finds, per
  member, the cuisines they said yum to and the ones they skipped at least twice without ever saying
  yum. Those nudge the ranking at half the weight of a stated preference, in code, so the non-AI deck
  does it too. From round 2 the scout and curator also read them through `get_round_history`.
- **Swipes never become rules.** Only cuisine tags count: diet tags ("vegetarian") are ignored,
  because a diet is a hard rule that only the member states. Hard filters come from confirmed food
  rules alone.
- **Nothing outlives the session.** Up to 5 earlier rounds are kept in the session row and deleted
  with it after a day idle. Someone who leaves takes their votes from earlier rounds with them.

Measured: in round 1 both testers said yum to the Mexican and Chinese dishes and skipped every
American and Mediterranean one. Round 2 had no repeats, opened with two Mexican dishes and an Asian
one by the sixth card, and put the Mediterranean and American dishes last, for $0.0056 (round 1:
$0.0047).

Why not saved groups? Without accounts, a "saved group" is a fragile half-account (a key in one
browser's storage), and it adds steps to a flow whose point is _open the link, type a name, swipe_.
Link sessions stay one-time by design.

## Persistence

Postgres holds sessions, members, swipes and matches (schema:
[`001_init.sql`](packages/db/src/migrations/001_init.sql); migrations are plain SQL, applied in
order on startup or with `npm run db:migrate`).

- **Atomic updates.** Each change loads the session with `SELECT … FOR UPDATE`, applies it in
  memory and writes back only what changed, in one transaction. Concurrent swipes are safe even
  across several API processes.
- **The schema enforces the rules too.** One vote per member per card is a primary key; removing a
  member cascades to their votes; names are unique per session, ignoring case.
- **Restarts are invisible.** Presence is a `disconnected_at` timestamp, not an in-memory timer. On
  startup everyone is marked offline, phones reconnect with their stored token within seconds, and a
  sweep every 30 s removes members offline for over 2 minutes.

## Recipes

Decks come from [Spoonacular](https://spoonacular.com/food-api). Its free tier is 50 points a day
and one 50-recipe search costs about 4, so instead of a request per session, the API fetches a
**pool** of popular main courses, caches it in Postgres for a week (`api_cache`), and deals each
session 10 random cards from it. Most sessions make no API call at all.

If the cache is stale and the API fails (quota used up, network down), the stale pool is used; with
no pool at all, the hard-coded recipes are. A session can always start. Every fetched recipe is also
kept in `cards` with its diet facts (vegan, gluten-free, …), which Phase 5 uses as hard filters.

## MCP servers

Two [Model Context Protocol](https://modelcontextprotocol.io) servers give Claude (and, from
Phase 6, the app's own agents) structured access to recipes and sessions. Each is a
transport-agnostic `createXServer()` plus a small `stdio.ts` launcher.

| Server               | Tool                     | What it's for                                                                                            |
| -------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------- |
| `yumanimous-recipes` | `search_recipes`         | Filtered search: query, cuisine, `diets` (AND), `intolerances` (excluded), max time, type, 1–20 results  |
|                      | `get_recipe`             | Ingredients with amounts and supermarket aisle, numbered steps (the shopping list reads it)              |
| `yumanimous-session` | `get_session`            | Match rule, status, members, who's online, swipe progress, matches                                       |
|                      | `get_swipe_history`      | Each member's yums and skips with card titles and tags (for re-ranking)                                  |
|                      | `get_vote_tally`         | Per-card yums, skips and outcome under the session's rule, best first (for the no-match mediator)        |
|                      | `get_member_preferences` | Each member's confirmed rules, the merged hard/soft rules, and what the current deck wasn't filtered for |
|                      | `get_round_history`      | Earlier rounds: cards shown, picks, and each member's yum and never cuisines (for "Play again")          |

Design choices:

- **Structured inputs only.** Filters are enums mirroring the recipe API (a model can't ask for a
  diet the API doesn't know), counts are capped, ids are typed. No tool accepts SQL or a URL.
  Every tool declares an output schema and returns `structuredContent`.
- **`mcp-session` is read-only in the database, not just in code.** Its pool sets
  `default_transaction_read_only=on`, so Postgres rejects any write (there's a test for it). Each
  read runs in one `REPEATABLE READ` transaction, so a tally never mixes two moments. Rejoin token
  hashes are never selected.
- **Guest names are untrusted.** They only appear as JSON values, and every tool description tells
  the model to treat them as data, never as instructions.
- **Quota-aware.** Searches are cached for 7 days and recipe details for 30, in the same Postgres
  `api_cache` the app uses; a stale entry is served if the API fails. Each call logs the points it
  cost.
- **stdout is the protocol.** On stdio, all logging goes to stderr.

**Claude Code** picks both servers up from [`.mcp.json`](.mcp.json) when you open the repo (it asks
once to approve project servers). They read `SPOONACULAR_API_KEY` and `DATABASE_URL` from `.env`,
so no secret lives in the config. Try: _"In session ABC123, what has the group said yum to?"_

**Claude Desktop** needs absolute paths. Add this to `claude_desktop_config.json` (Settings →
Developer → Edit Config), replacing `C:/path/to/yumanimous`:

```json
{
  "mcpServers": {
    "yumanimous-recipes": {
      "command": "node",
      "args": [
        "C:/path/to/yumanimous/node_modules/tsx/dist/cli.mjs",
        "--env-file-if-exists=C:/path/to/yumanimous/.env",
        "C:/path/to/yumanimous/packages/mcp-recipes/src/stdio.ts"
      ]
    },
    "yumanimous-session": {
      "command": "node",
      "args": [
        "C:/path/to/yumanimous/node_modules/tsx/dist/cli.mjs",
        "--env-file-if-exists=C:/path/to/yumanimous/.env",
        "C:/path/to/yumanimous/packages/mcp-session/src/stdio.ts"
      ]
    }
  }
}
```

**Smoke test without an MCP client:** `npm run mcp:smoke -- <SESSION_CODE>` starts each server
exactly as `.mcp.json` describes, lists its tools and calls a few.

## Layout

| Path                   | What                                                                            |
| ---------------------- | ------------------------------------------------------------------------------- |
| `apps/web`             | React + Vite app: home, join, lobby, swipe deck, match screen, results, list    |
| `apps/api`             | Express + Socket.io + Postgres: sessions, presence, matches, recipes, AI agents |
| `packages/shared`      | Zod schemas, socket event types and pure match rules, used by both              |
| `packages/db`          | Postgres schema (SQL migrations), pools, API cache, test database helpers       |
| `packages/mcp-recipes` | MCP server + Spoonacular client (also used by the API's deck source)            |
| `packages/mcp-session` | Read-only MCP server over live sessions                                         |

Inside `apps/api`, `SessionService` holds every session rule and has no HTTP or socket code;
`http/` and `realtime/` are thin transports over it. `SessionStore` (in-memory or Postgres) and
`DeckSource` (hard-coded or recipe API) are interfaces, and the same behaviour tests run against
both stores.

Design tokens (colours, fonts, radii) live in one file: `apps/web/src/styles/tokens.css`.
