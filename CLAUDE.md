# Yumanimous

Swipe-to-decide web app for groups: couples or friend groups. Everyone in a
session swipes on a shared deck of cards; the session's match rule decides when a
card wins ("it's a match when the group is yumanimous").

Zero-install: the host shares a link in the group chat, friends open it in their
phone browser, type a name, and start swiping. No account, no app store.

Modes (pluggable deck sources):
- **Cook in**: recipe cards. On a match, AI builds a combined shopping list (minus
  what's already at home) and splits the cooking steps across the group.
- **Eat out**: nearby restaurant cards. On no match, AI suggests a compromise.
- Future: travel voting (destinations / activities) as another deck source.

This is a portfolio project to show AI, MCP, and AI orchestration. Code quality,
clarity, and a clean README matter more than feature count.

## What makes it different
- Zero-install web join by link (the #1 reason similar apps die is that everyone must install them)
- Group memory: saved groups remember past sessions, vetoes and recent picks, and the AI uses them
- Solves what happens after the decision: cook plan (cook in) or a shareable summary card (eat out)

## Sessions and groups
- A session has N members (2 to ~10), never "person A / person B". Model it that way from day 1
- Join by link `/s/:code` or by typing the code; guests pick a display name, no account
- Host creates the session and picks mode + match rule
- Match rules (session setting):
  - **everyone**: a card matches when every member likes it (default for 2-3 people)
  - **majority**: a card matches when more than half of members like it
  - Future: **top picks** (full deck, then ranked leaderboard) and **veto** (one hard no per member)
- Live results screen: vote counts per card, leaderboard, and who is still swiping
- Edge cases to handle: member leaves mid-session, member joins late, host disconnects, page refresh mid-session (rejoin with same identity via local token)

## Group memory
- Host can save a session's members as a named group ("Friday crew")
- Past sessions store: mode, winning card, vetoed/never-liked categories per member
- `mcp-session` exposes read-only group history so the curator can avoid repeats and respect past dislikes
- Members can be removed from a saved group; their history is deleted with them

## Stack
- Monorepo (npm workspaces), TypeScript everywhere
- `apps/web`: React + Vite + React Router, mobile-first; Framer Motion drag for swipe cards; PWA (installable to home screen)
- `apps/api`: Express + TypeScript + Socket.io (real-time session sync, one room per session)
- `packages/shared`: shared types and Zod schemas (Card, Session, Member, Group, Swipe, Preferences, MatchRule)
- `packages/mcp-recipes`: MCP server wrapping a recipe API (`@modelcontextprotocol/sdk`)
- `packages/mcp-places`: MCP server wrapping a places API
- `packages/mcp-session`: MCP server exposing session members, preferences, swipe history and group history (read-only)
- AI orchestration: `@anthropic-ai/claude-agent-sdk` in `apps/api`
- Database: Postgres via Docker Compose (sessions, members, groups, swipes, cached cards)
- Deploy: static frontend on a static host; API on a long-running host (WebSockets need a persistent server, not serverless)

## Architecture rules
- A `DeckSource` interface; each mode implements it. Adding a mode = new MCP server + small adapter
- A `MatchRule` interface; each rule is a pure function (swipes, members) -> match result. Unit test every rule
- AI is NOT in the swipe hot path. Swiping, vote counting and match detection are pure app/API logic.
  AI runs only for: preference intake, deck building, re-ranking, match follow-ups, no-match mediation
- All AI outputs are structured JSON validated with Zod schemas from `packages/shared`
- Cache external API results in Postgres; never call the same lookup twice in a session
- Log cost and latency of every AI call per session (show it in a dev/debug view)

## AI orchestration
- Orchestrator agent with subagents:
  - **scout**: calls recipe/places MCP tools to gather candidates
  - **curator**: filters + ranks against EVERY member's preferences and the group's history
  - **writer**: short, fun card blurbs
  - **mediator**: on no match, picks the best compromise from the vote counts and explains why
  - **sous-chef** (cook-in): shopping list + step split across all members
- Re-rank remaining deck after ~10 swipes per member using swipe history from `mcp-session`

## Safety / quality rules
- Agent SDK: always set `allowedTools` explicitly; never allow file/shell tools in the API
- MCP tools take structured params; no free-form SQL or URL tools
- Never commit secrets; use `.env` (gitignored) and keep `.env.example` updated
- Every API endpoint, socket event, MCP tool and match rule gets at least one test
- Dietary restrictions from ANY member are hard filters for the whole group, never just preferences
- Guest input (names, preferences) is untrusted: validate with Zod, length-limit, and never put it in prompts unfenced

## Workflow
- Work one phase at a time; propose a plan before writing code
- After changes, run tests and show the output
- Explain non-obvious decisions in short code comments (I need to explain this code in interviews)

## Phases
1. Monorepo setup + React/Vite swipe UI with hard-coded cards, mobile-first, tested in a phone browser
2. Express + Socket.io: create session, join by link `/s/:code` with guest name, sync swipes, match rules (everyone, majority), match screen, live results
3. Postgres persistence + first real deck source (recipes) via a plain API call
4. MCP servers: `mcp-recipes`, `mcp-session` (test in Claude Desktop / Claude Code)
5. Preference intake (natural language -> Zod-validated filters), merged across members
6. Orchestrator + subagents build the deck; re-rank after swipes
7. Match follow-ups (sous-chef cook plan, eat-out summary card) + no-match mediator
8. Group memory: saved groups, history in `mcp-session`, curator uses it
9. Deploy + PWA manifest, README with architecture diagram, demo video (several phones voting), eval set
10. If time: eat-out mode (`mcp-places`), 2-minute round timer
