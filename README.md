# Yumanimous

Swipe-to-decide for groups: everyone swipes on a shared deck, and it's a match when the group is
_yumanimous_. Zero install: join from a link in the group chat.

> Work in progress. Phase 2: live multi-person sessions over WebSockets, join by link, match
> rules, match screen and live results. Sessions are in memory until Phase 3 adds Postgres.

## Quick start

Requires Node 22.22 or newer (see `.nvmrc`; react-router 8 needs it).

```sh
npm install
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

Configuration lives in `.env.example`; nothing is required for local development.

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

## Layout

| Path              | What                                                                   |
| ----------------- | ---------------------------------------------------------------------- |
| `apps/web`        | React + Vite app: home, join, lobby, swipe deck, match screen, results |
| `apps/api`        | Express + Socket.io: sessions, presence, match detection               |
| `packages/shared` | Zod schemas, socket event types and pure match rules, used by both     |

Inside `apps/api`, `SessionService` holds every session rule and has no HTTP or socket code;
`http/` and `realtime/` are thin transports over it. `SessionStore` and `DeckSource` are the seams
where Postgres (Phase 3) and real recipe data plug in.

Design tokens (colours, fonts, radii) live in one file: `apps/web/src/styles/tokens.css`.
