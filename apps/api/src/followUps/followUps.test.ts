import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { InMemoryApiCache } from '@yumanimous/db';
import { createRecipesServer, type RecipeDetails } from '@yumanimous/mcp-recipes';
import type { Card } from '@yumanimous/shared';
import { BudgetGuard, InMemoryAiCallLog } from '../ai/aiCallLog.js';
import { AiRunner } from '../ai/aiRunner.js';
import type { AiUsage } from '../ai/agentRun.js';
import {
  createShoppingTools,
  type FollowUpAgent,
  type ScaledIngredient,
} from '../ai/followUpAgents.js';
import { FollowUpError, FollowUpService } from './followUps.js';
import { mcpRecipeDetails, RecipeLookupError } from './recipeDetails.js';
import type { LinePlan } from './shoppingList.js';
import type { MediatorPick } from './mediator.js';

const usage: AiUsage = {
  model: 'test-model',
  costUsd: 0.004,
  inputTokens: 100,
  outputTokens: 50,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  durationMs: 1200,
  numTurns: 3,
};

const recipe: RecipeDetails = {
  recipeId: 42,
  cardId: 'spoonacular:42',
  title: 'Garlic Noodles',
  servings: 2,
  readyInMinutes: 20,
  facts: {
    vegetarian: true,
    vegan: false,
    glutenFree: false,
    dairyFree: false,
    diets: [],
    cuisines: [],
    readyInMinutes: 20,
    servings: 2,
    license: null,
  },
  ingredients: [
    { name: 'noodles', amount: 200, unit: 'g', original: '200g noodles', aisle: 'Pasta and Rice' },
    { name: 'garlic', amount: 3, unit: 'cloves', original: '3 cloves garlic', aisle: 'Produce' },
    { name: 'salt', amount: 0, unit: '', original: 'salt', aisle: 'Spices and Seasonings' },
  ],
  steps: [],
  sourceUrl: null,
};

const card: Card = { id: 'spoonacular:42', title: 'Garlic Noodles', tags: [], blurb: 'Yum.' };

const goodPlan: LinePlan[] = [
  { name: 'Noodles', aisle: 'Pantry', covers: [0], likelyAtHome: false },
  { name: 'Garlic', aisle: 'Produce', covers: [1], likelyAtHome: false },
  { name: 'Salt', aisle: 'Spices', covers: [2], likelyAtHome: true },
];

function setup({
  plan = goodPlan as LinePlan[] | null,
  pick = { cardId: 'b', reason: 'Close to the top, and everyone can eat it.' } as MediatorPick,
  budgetUsd = 8,
  fail = false,
} = {}) {
  const seen: { shopping: ScaledIngredient[][]; mediator: number } = { shopping: [], mediator: 0 };
  const agent: FollowUpAgent = {
    model: 'test-model',
    planShoppingList: async (req) => {
      seen.shopping.push(req.ingredients);
      if (fail) throw new Error('boom');
      return { plan, usage };
    },
    pickCompromise: async () => {
      seen.mediator++;
      if (fail) throw new Error('boom');
      return { pick, usage };
    },
  };
  const log = new InMemoryAiCallLog();
  const runner = new AiRunner({
    log,
    budget: new BudgetGuard(log, budgetUsd),
    model: 'test-model',
    warn: () => {},
  });
  const service = new FollowUpService({
    recipeDetails: async (id) => {
      if (id !== 42) throw new RecipeLookupError('No recipe with that id');
      return recipe;
    },
    ai: { agent, runner },
  });
  return { service, log, seen };
}

const contenders = [
  { cardId: 'a', title: 'A', yums: 2 },
  { cardId: 'b', title: 'B', yums: 1 },
  { cardId: 'c', title: 'C', yums: 0 },
];

describe('FollowUpService: shopping list', () => {
  it('hands the sous-chef amounts already scaled by code, and keeps its grouping', async () => {
    const { service, log, seen } = setup();
    const result = await service.shoppingList({ sessionCode: 'S', card, servings: 4 });

    expect(seen.shopping[0]!.map((i) => i.quantity)).toEqual(['400 g', '6 cloves', '']);
    expect(result.source).toBe('ai');
    expect(result.recipeServings).toBe(2);
    expect(result.lines.map((l) => [l.name, l.quantity, l.have])).toEqual([
      ['Noodles', '400 g', false],
      ['Garlic', '6 cloves', false],
      ['Salt', '', true],
    ]);
    expect((await log.list({ limit: 5 }))[0]).toMatchObject({ kind: 'shopping', status: 'ok' });
  });

  it('uses the plain list when the agent never hands in a valid one', async () => {
    const { service, log } = setup({ plan: null });
    const result = await service.shoppingList({ sessionCode: 'S', card, servings: 2 });
    expect(result.source).toBe('fallback');
    expect(result.lines).toHaveLength(3);
    expect((await log.list({ limit: 5 }))[0]).toMatchObject({ status: 'fallback' });
  });

  it('re-checks coverage even if the agent returned a bad plan', async () => {
    const { service } = setup({ plan: goodPlan.slice(0, 2) });
    expect((await service.shoppingList({ sessionCode: 'S', card, servings: 2 })).source).toBe(
      'fallback',
    );
  });

  it('skips the AI over budget, and when it fails', async () => {
    const over = setup({ budgetUsd: 0 });
    expect((await over.service.shoppingList({ sessionCode: 'S', card, servings: 2 })).source).toBe(
      'fallback',
    );
    expect(over.seen.shopping).toHaveLength(0);
    expect((await over.log.list({ limit: 5 }))[0]).toMatchObject({ status: 'skipped' });

    const failing = setup({ fail: true });
    expect(
      (await failing.service.shoppingList({ sessionCode: 'S', card, servings: 2 })).source,
    ).toBe('fallback');
    expect((await failing.log.list({ limit: 5 }))[0]).toMatchObject({ status: 'error' });
  });

  it('refuses cards without a recipe, and reports lookups that fail', async () => {
    const { service } = setup();
    const plain = { ...card, id: 'soup' };
    await expect(
      service.shoppingList({ sessionCode: 'S', card: plain, servings: 2 }),
    ).rejects.toThrow(FollowUpError);
    const missing = { ...card, id: 'spoonacular:7' };
    await expect(
      service.shoppingList({ sessionCode: 'S', card: missing, servings: 2 }),
    ).rejects.toThrow('No recipe with that id');
  });
});

describe('FollowUpService: mediator', () => {
  it('uses a pick within one yum of the top', async () => {
    const { service, log } = setup();
    expect(await service.mediate({ sessionCode: 'S', contenders, memberCount: 3 })).toMatchObject({
      cardId: 'b',
      source: 'ai',
    });
    expect((await log.list({ limit: 5 }))[0]).toMatchObject({ kind: 'mediator', status: 'ok' });
  });

  it('falls back to the top card when the pick breaks the rules', async () => {
    const { service } = setup({ pick: { cardId: 'c', reason: 'Nobody liked it but trust me.' } });
    expect(await service.mediate({ sessionCode: 'S', contenders, memberCount: 3 })).toMatchObject({
      cardId: 'a',
      source: 'fallback',
    });
  });

  it('falls back without calling the AI over budget', async () => {
    const { service, seen } = setup({ budgetUsd: 0 });
    expect((await service.mediate({ sessionCode: 'S', contenders, memberCount: 3 }))?.source).toBe(
      'fallback',
    );
    expect(seen.mediator).toBe(0);
  });
});

describe('the sous-chef’s tools', () => {
  let client: Client;
  afterEach(() => client?.close());

  const ingredients: ScaledIngredient[] = [
    { index: 0, name: 'noodles', quantity: '400 g', aisle: 'Pasta and Rice' },
    { index: 1, name: 'garlic', quantity: '6 cloves', aisle: 'Produce' },
  ];

  async function connect() {
    const tools = createShoppingTools(ingredients);
    const [a, b] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'test', version: '0' });
    await Promise.all([tools.server.connect(b), client.connect(a)]);
    return tools;
  }
  const submit = async (lines: unknown[]) =>
    (await client.callTool({
      name: 'submit_shopping_list',
      arguments: { lines },
    })) as CallToolResult;
  const text = (res: CallToolResult) =>
    res.content.map((c) => (c.type === 'text' ? c.text : '')).join('');

  it('lists the scaled ingredients', async () => {
    await connect();
    const res = (await client.callTool({
      name: 'list_ingredients',
      arguments: {},
    })) as CallToolResult;
    expect(JSON.parse(text(res))).toEqual({ count: 2, ingredients });
  });

  it('refuses a list that drops an ingredient, says why, and accepts the fix', async () => {
    const tools = await connect();
    const bad = await submit([
      { name: 'Noodles', aisle: 'Pantry', covers: [0], likelyAtHome: false },
    ]);
    expect(bad.isError).toBe(true);
    expect(text(bad)).toContain('Not covered by any line: 1.');
    expect(tools.plan()).toBeNull();

    const good = await submit([
      { name: 'Noodles', aisle: 'Pantry', covers: [0], likelyAtHome: false },
      { name: 'Garlic', aisle: 'Produce', covers: [1], likelyAtHome: false },
    ]);
    expect(good.isError).toBeFalsy();
    expect(tools.plan()).toHaveLength(2);
  });

  it('stops accepting after three tries', async () => {
    const tools = await connect();
    const bad = [{ name: 'X', aisle: 'Other', covers: [9], likelyAtHome: false }];
    for (let i = 0; i < 3; i++) await submit(bad);
    const late = await submit([
      { name: 'Noodles', aisle: 'Pantry', covers: [0], likelyAtHome: false },
      { name: 'Garlic', aisle: 'Produce', covers: [1], likelyAtHome: false },
    ]);
    expect(text(late)).toContain('No more submissions');
    expect(tools.plan()).toBeNull();
  });
});

describe('recipes through mcp-recipes', () => {
  it('reads a cached recipe via the get_recipe tool, without an API key', async () => {
    const cache = new InMemoryApiCache();
    await cache.set('spoonacular:recipe:v1:42', recipe, 60_000);
    const lookup = mcpRecipeDetails(() =>
      createRecipesServer({ client: null, cache, log: () => {} }),
    );
    expect((await lookup(42)).ingredients).toHaveLength(3);
  });

  it('turns a tool error into a readable lookup error', async () => {
    const lookup = mcpRecipeDetails(() =>
      createRecipesServer({ client: null, cache: new InMemoryApiCache(), log: () => {} }),
    );
    await expect(lookup(7)).rejects.toThrow(RecipeLookupError);
  });
});
