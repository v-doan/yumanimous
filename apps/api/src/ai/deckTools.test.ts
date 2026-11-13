import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Card } from '@yumanimous/shared';
import { createDeckTools, type DeckToolsOptions } from './deckTools.js';

const card = (id: string, title = id): Card => ({
  id,
  title,
  tags: ['30 min'],
  blurb: `${title}!`,
});

let client: Client;

async function connect(opts: DeckToolsOptions) {
  const tools = createDeckTools(opts);
  const [a, b] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test', version: '0' });
  await Promise.all([tools.server.connect(b), client.connect(a)]);
  return tools;
}

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const res = (await client.callTool({ name, arguments: args })) as CallToolResult;
  const text = res.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
  return { isError: res.isError ?? false, text, json: res.isError ? null : JSON.parse(text) };
};

afterEach(async () => {
  await client?.close();
});

describe('deck tools', () => {
  it('the scout’s search has no way to set or drop diet and allergen rules', async () => {
    await connect({ pool: [], searchMore: null });
    const { tools } = await client.listTools();
    const search = tools.find((t) => t.name === 'search_candidates')!;
    expect(Object.keys(search.inputSchema.properties ?? {}).sort()).toEqual(['cuisine', 'query']);
  });

  it('lists the pool, optionally filtered by ids', async () => {
    await connect({ pool: [card('a', 'Soup'), card('b', 'Salad')], searchMore: null });
    expect((await call('list_candidates')).json.count).toBe(2);
    const one = await call('list_candidates', { cardIds: ['b'] });
    expect(one.json.candidates).toEqual([{ cardId: 'b', title: 'Salad', tags: ['30 min'] }]);
  });

  it('adds search results to the candidates the deck may use', async () => {
    const searchMore = vi.fn(async () => [card('a'), card('c'), card('d')]);
    const tools = await connect({ pool: [card('a')], searchMore });

    const res = await call('search_candidates', { cuisine: 'Thai', query: 'noodles' });
    expect(searchMore).toHaveBeenCalledWith({ cuisine: 'Thai', query: 'noodles' });
    expect(res.json).toEqual({ found: 3, added: 2, total: 3 });
    expect([...tools.candidates.keys()].sort()).toEqual(['a', 'c', 'd']);
  });

  it('caps searches per deck to protect the recipe quota', async () => {
    const searchMore = vi.fn(async () => []);
    await connect({ pool: [], searchMore, maxSearches: 2 });
    await call('search_candidates', { query: 'one' });
    await call('search_candidates', { query: 'two' });
    const third = await call('search_candidates', { query: 'three' });
    expect(third.isError).toBe(true);
    expect(third.text).toContain('Search limit reached');
    expect(searchMore).toHaveBeenCalledTimes(2);
  });

  it('reports a failed search without leaking details', async () => {
    await connect({
      pool: [],
      searchMore: vi.fn(async () => {
        throw new Error('spoonacular 402 key=secret');
      }),
    });
    const res = await call('search_candidates', { query: 'soup' });
    expect(res.isError).toBe(true);
    expect(res.text).not.toContain('secret');
  });

  it('rejects cuisines outside the allowed list', async () => {
    const searchMore = vi.fn(async () => []);
    await connect({ pool: [], searchMore });
    expect((await call('search_candidates', { cuisine: 'Martian' })).isError).toBe(true);
    expect(searchMore).not.toHaveBeenCalled();
  });

  it('the curator’s order keeps only real, distinct candidates', async () => {
    const tools = await connect({ pool: [card('a'), card('b'), card('c')], searchMore: null });
    const res = await call('submit_order', { cardIds: ['b', 'ghost', 'a', 'b'] });
    expect(res.json).toEqual({ accepted: 2, rejected: ['ghost'] });
    expect(tools.picks().map((p) => p.cardId)).toEqual(['b', 'a']);
  });

  it('the writer sees the chosen cards and can only blurb those', async () => {
    const tools = await connect({ pool: [card('a', 'Soup'), card('b', 'Stew')], searchMore: null });
    await call('submit_order', { cardIds: ['b'] });
    expect((await call('list_chosen')).json.cards).toEqual([
      { cardId: 'b', title: 'Stew', tags: ['30 min'] },
    ]);

    const res = await call('submit_blurbs', {
      blurbs: [
        { cardId: 'b', blurb: 'Hearty and warm.' },
        { cardId: 'a', blurb: 'Not chosen, so ignored.' },
      ],
    });
    expect(res.json).toEqual({ accepted: 1, rejected: ['a'], missing: [] });
    expect(tools.picks()).toEqual([{ cardId: 'b', blurb: 'Hearty and warm.' }]);
  });

  it('a card without a blurb is handed over with an empty one (the card keeps its own)', async () => {
    const tools = await connect({ pool: [card('a'), card('b')], searchMore: null });
    await call('submit_order', { cardIds: ['a', 'b'] });
    const res = await call('submit_blurbs', { blurbs: [{ cardId: 'a', blurb: 'Tasty.' }] });
    expect(res.json.missing).toEqual(['b']);
    expect(tools.picks()).toEqual([
      { cardId: 'a', blurb: 'Tasty.' },
      { cardId: 'b', blurb: '' },
    ]);
  });

  it('rejects oversized submissions before storing anything', async () => {
    const tools = await connect({ pool: [card('a')], searchMore: null });
    const tooMany = Array.from({ length: 41 }, (_, i) => `id${i}`);
    expect((await call('submit_order', { cardIds: tooMany })).isError).toBe(true);
    expect(tools.picks()).toEqual([]);
  });
});
