# Yumanimous

Swipe-to-decide for groups: everyone swipes on a shared deck, and it's a match when the group is
_yumanimous_. Zero install: join from a link in the group chat.

> Work in progress. Phase 3: sessions persist in Postgres (an API restart mid-session goes
> unnoticed) and decks come from a real recipe API, cached to respect its free quota.

## Quick start

Requires Node 22.22 or newer (see `.nvmrc`; react-router 8 needs it).

```sh
npm install
cp .env.example apps/api/.env   # then add your SPOONACULAR_API_KEY
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
[`001_init.sql`](apps/api/src/db/migrations/001_init.sql); migrations are plain SQL, applied in
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

## Layout

| Path              | What                                                                   |
| ----------------- | ---------------------------------------------------------------------- |
| `apps/web`        | React + Vite app: home, join, lobby, swipe deck, match screen, results |
| `apps/api`        | Express + Socket.io + Postgres: sessions, presence, matches, recipes   |
| `packages/shared` | Zod schemas, socket event types and pure match rules, used by both     |

Inside `apps/api`, `SessionService` holds every session rule and has no HTTP or socket code;
`http/` and `realtime/` are thin transports over it. `SessionStore` (in-memory or Postgres) and
`DeckSource` (hard-coded or recipe API) are interfaces, and the same behaviour tests run against
both stores.

Design tokens (colours, fonts, radii) live in one file: `apps/web/src/styles/tokens.css`.
