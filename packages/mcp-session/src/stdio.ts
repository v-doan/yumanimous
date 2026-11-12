import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createPool } from '@yumanimous/db';
import { createSessionServer } from './server.js';

/**
 * Entry point for Claude Desktop / Claude Code (stdio transport). Needs DATABASE_URL.
 * stdout carries the MCP protocol, so every log line goes to stderr.
 */
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('[mcp-session] DATABASE_URL is not set; sessions live in Postgres.');
  process.exit(1);
}

// readOnly: every transaction on this pool is READ ONLY, enforced by Postgres.
const server = createSessionServer({ pool: createPool(url, { readOnly: true }) });
await server.connect(new StdioServerTransport());
console.error('[mcp-session] ready on stdio (read-only)');
