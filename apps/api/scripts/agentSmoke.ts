/**
 * `npm run agent:smoke -w @yumanimous/api`: one tiny real Agent SDK run that checks
 * the whole harness on this machine before anything is built on it:
 * API key -> orchestrator -> subagent delegation -> in-process MCP tool ->
 * structured JSON output -> cost reporting. Capped at $0.05; expect well under 1¢.
 */
import { query } from '@anthropic-ai/claude-agent-sdk';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

const MODEL = 'claude-haiku-5-5';

const server = new McpServer({ name: 'smoke', version: '0.0.0' });
server.registerTool(
  'pick_numbers',
  { description: 'Returns the candidate numbers.', inputSchema: {} },
  async () => ({ content: [{ type: 'text', text: JSON.stringify({ numbers: [3, 11, 7] }) }] }),
);

const started = Date.now();
for await (const message of query({
  prompt: 'Ask the picker agent for the candidate numbers, then return the largest one.',
  options: {
    model: MODEL,
    systemPrompt: 'You are a test harness. Delegate to the picker agent, then answer.',
    // Locked down: no built-in tools except delegation, no settings files, no prompts.
    tools: ['Agent'],
    allowedTools: ['Agent', 'mcp__smoke__pick_numbers'],
    permissionMode: 'dontAsk',
    settingSources: [],
    // Only our MCP servers: never the developer's .mcp.json, plugins, or claude.ai
    // connectors that the local Claude Code login would otherwise pull in.
    strictMcpConfig: true,
    settings: { disableClaudeAiConnectors: true },
    agents: {
      picker: {
        description: 'Fetches the candidate numbers.',
        prompt: 'Call pick_numbers and report the numbers it returns.',
        tools: ['mcp__smoke__pick_numbers'],
        model: MODEL,
      },
    },
    mcpServers: { smoke: { type: 'sdk', name: 'smoke', instance: server } },
    outputFormat: {
      type: 'json_schema',
      // Zod 4 stamps a draft-2020-12 "$schema" URL the SDK's validator doesn't know.
      schema: (({ $schema: _drop, ...rest }) => rest)(
        z.toJSONSchema(z.object({ largest: z.number().int() })),
      ),
    },
    maxTurns: 8,
    maxBudgetUsd: 0.05,
    effort: 'low',
  },
})) {
  if (message.type === 'system' && message.subtype === 'init') {
    console.log('tools available:', message.tools.join(', '));
    console.log('mcp servers:', JSON.stringify(message.mcp_servers));
    console.log('credential used:', message.apiKeySource);
  }
  if (message.type === 'assistant') {
    for (const block of message.message.content) {
      if (block.type === 'tool_use')
        console.log('tool call ->', block.name, JSON.stringify(block.input));
    }
  }
  if (message.type === 'result') {
    console.log(
      '\nresult:',
      message.subtype,
      `(${message.num_turns} turns, ${Date.now() - started} ms)`,
    );
    if (message.subtype === 'success')
      console.log('structured_output:', JSON.stringify(message.structured_output));
    else console.log('errors:', message.errors);
    console.log('cost (SDK estimate): $' + message.total_cost_usd.toFixed(5));
    for (const [model, usage] of Object.entries(message.modelUsage)) {
      console.log(
        `  ${model}: in ${usage.inputTokens}, out ${usage.outputTokens}, cache read ${usage.cacheReadInputTokens}, $${usage.costUSD.toFixed(5)}`,
      );
    }
  }
}
