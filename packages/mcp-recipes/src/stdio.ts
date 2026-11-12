import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  createPool,
  InMemoryApiCache,
  migrate,
  PostgresApiCache,
  type ApiCache,
} from '@yumanimous/db';
import { createRecipesServer } from './server.js';
import { SpoonacularClient } from './spoonacular.js';

/**
 * Entry point for Claude Desktop / Claude Code (stdio transport). Reads
 * SPOONACULAR_API_KEY and DATABASE_URL from the environment.
 *
 * stdout carries the MCP protocol, so every log line goes to stderr.
 */
const log = (message: string) => console.error(message);

const apiKey = process.env.SPOONACULAR_API_KEY || undefined;
if (!apiKey) log('[mcp-recipes] SPOONACULAR_API_KEY not set: only cached results will work.');

// Share the API's Postgres cache when available, so searches the app already paid
// for are free here too. Fall back to memory rather than refusing to start.
let cache: ApiCache = new InMemoryApiCache();
if (process.env.DATABASE_URL) {
  try {
    const pool = createPool(process.env.DATABASE_URL);
    await migrate(pool);
    cache = new PostgresApiCache(pool);
  } catch (err) {
    log(`[mcp-recipes] Postgres unavailable (${(err as Error).message}); caching in memory.`);
  }
}

const server = createRecipesServer({
  client: apiKey ? new SpoonacularClient({ apiKey }) : null,
  cache,
  log,
});
await server.connect(new StdioServerTransport());
log('[mcp-recipes] ready on stdio');
