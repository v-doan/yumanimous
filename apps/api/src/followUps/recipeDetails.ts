import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { RecipeDetailsSchema, type RecipeDetails } from '@yumanimous/mcp-recipes';

/** Looks up one recipe's ingredients. The app uses MCP; tests use a fake. */
export type RecipeDetailsLookup = (recipeId: number) => Promise<RecipeDetails>;

/** A recipe can't be looked up. The message is safe to show to the group. */
export class RecipeLookupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecipeLookupError';
  }
}

const OutputSchema = z.object({ recipe: RecipeDetailsSchema });

/**
 * Reads recipes through the Phase 4 `mcp-recipes` server, connected in-process: the
 * same `get_recipe` tool Claude Desktop uses, with its Postgres cache (30 days), so
 * a recipe costs at most one API call however many lists are made from it.
 *
 * A factory, not one server: an McpServer serves one transport at a time, and two
 * sessions may ask at the same moment.
 */
export function mcpRecipeDetails(createServer: () => McpServer): RecipeDetailsLookup {
  return async (recipeId) => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createServer();
    const client = new Client({ name: 'yumanimous-api', version: '0.1.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const res = await client.callTool({ name: 'get_recipe', arguments: { recipeId } });
      if (res.isError) {
        const content = res.content as { type: string; text?: string }[];
        throw new RecipeLookupError(
          content.find((c) => c.type === 'text')?.text ?? 'Recipe lookup failed',
        );
      }
      // Validated again here: the client must not trust a server's output blindly.
      return OutputSchema.parse(res.structuredContent).recipe;
    } finally {
      await client.close();
      await server.close();
    }
  };
}
