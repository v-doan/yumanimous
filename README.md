# Yumanimous

Swipe-to-decide for groups: everyone swipes on a shared deck, and it's a match when the group is
_yumanimous_. Zero install: join from a link in the group chat.

> Work in progress. Phase 4: two MCP servers expose recipes and live session data to Claude
> (Desktop, Code, and the app's own agents from Phase 6). Sessions persist in Postgres and decks come
> from a real recipe API, cached to respect its free quota.

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

| Server               | Tool                | What it's for                                                                                           |
| -------------------- | ------------------- | ------------------------------------------------------------------------------------------------------- |
| `yumanimous-recipes` | `search_recipes`    | Filtered search: query, cuisine, `diets` (AND), `intolerances` (excluded), max time, type, 1–20 results |
|                      | `get_recipe`        | Ingredients with amounts and supermarket aisle, numbered steps (for the Phase 7 cook plan)              |
| `yumanimous-session` | `get_session`       | Match rule, status, members, who's online, swipe progress, matches                                      |
|                      | `get_swipe_history` | Each member's yums and skips with card titles and tags (for re-ranking)                                 |
|                      | `get_vote_tally`    | Per-card yums, skips and outcome under the session's rule, best first (for the no-match mediator)       |

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

| Path                   | What                                                                      |
| ---------------------- | ------------------------------------------------------------------------- |
| `apps/web`             | React + Vite app: home, join, lobby, swipe deck, match screen, results    |
| `apps/api`             | Express + Socket.io + Postgres: sessions, presence, matches, recipes      |
| `packages/shared`      | Zod schemas, socket event types and pure match rules, used by both        |
| `packages/db`          | Postgres schema (SQL migrations), pools, API cache, test database helpers |
| `packages/mcp-recipes` | MCP server + Spoonacular client (also used by the API's deck source)      |
| `packages/mcp-session` | Read-only MCP server over live sessions                                   |

Inside `apps/api`, `SessionService` holds every session rule and has no HTTP or socket code;
`http/` and `realtime/` are thin transports over it. `SessionStore` (in-memory or Postgres) and
`DeckSource` (hard-coded or recipe API) are interfaces, and the same behaviour tests run against
both stores.

Design tokens (colours, fonts, radii) live in one file: `apps/web/src/styles/tokens.css`.
