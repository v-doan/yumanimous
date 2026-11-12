# Yumanimous

Swipe-to-decide for groups: everyone swipes on a shared deck, and it's a match when the group is
_yumanimous_. Zero install: join from a link in the group chat.

> Work in progress. Phase 1: monorepo + mobile-first swipe deck with hard-coded recipes.

## Quick start

Requires Node 22 (see `.nvmrc`).

```sh
npm install
npm run dev        # http://localhost:5173, also exposed on your LAN for phone testing
npm test           # all workspaces
npm run lint
npm run typecheck
npm run build
```

**On a phone:** run `npm run dev`, then open the `Network:` URL Vite prints (e.g.
`http://192.168.x.x:5173`) on a phone connected to the same Wi-Fi. On Windows, allow Node.js on
private networks when the firewall asks.

## Layout

| Path              | What                                                    |
| ----------------- | ------------------------------------------------------- |
| `apps/web`        | React + Vite app, swipe deck (Motion drag), CSS Modules |
| `packages/shared` | Zod schemas + types shared by web, API and MCP servers  |

Design tokens (colours, fonts, radii) live in one file: `apps/web/src/styles/tokens.css`.
