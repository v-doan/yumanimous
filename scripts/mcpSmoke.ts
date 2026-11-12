/**
 * `npm run mcp:smoke [SESSION_CODE]`: starts each server listed in .mcp.json exactly
 * as Claude Code would (same command, same args, over stdio), lists its tools and
 * calls a few. A quick end-to-end check without opening an MCP client app.
 *
 * Costs about 1 Spoonacular point the first time (the search is cached after that).
 */
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

const config = JSON.parse(readFileSync('.mcp.json', 'utf8')) as {
  mcpServers: Record<string, { command: string; args: string[] }>;
};
const sessionCode = process.argv[2];

const calls: Record<string, [string, Record<string, unknown>][]> = {
  'yumanimous-recipes': [['search_recipes', { query: 'pasta', diets: ['vegetarian'], count: 3 }]],
  'yumanimous-session': sessionCode
    ? [
        ['get_session', { code: sessionCode }],
        ['get_vote_tally', { code: sessionCode }],
      ]
    : [],
};

for (const [name, { command, args }] of Object.entries(config.mcpServers)) {
  console.log(`\n=== ${name} ===`);
  const client = new Client({ name: 'mcp-smoke', version: '0.0.0' });
  await client.connect(new StdioClientTransport({ command, args, stderr: 'inherit' }));
  try {
    const { tools } = await client.listTools();
    for (const t of tools)
      console.log(`tool ${t.name}(${Object.keys(t.inputSchema.properties ?? {}).join(', ')})`);

    for (const [tool, input] of calls[name] ?? []) {
      const res = (await client.callTool({ name: tool, arguments: input })) as CallToolResult;
      const text = res.content.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('');
      console.log(`\n${tool}(${JSON.stringify(input)})${res.isError ? ' -> ERROR' : ''}`);
      console.log(text.length > 700 ? `${text.slice(0, 700)}…` : text);
    }
  } finally {
    await client.close();
  }
}
if (!sessionCode) console.log('\n(Pass a session code to also call the session tools.)');
