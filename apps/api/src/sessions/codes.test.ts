import { describe, expect, it } from 'vitest';
import { SessionCodeSchema } from '@yumanimous/shared';
import { generateSessionCode, generateToken, hashToken, tokenMatches } from './codes.js';
import { InMemorySessionStore, type StoredSession } from './sessionStore.js';

describe('generateSessionCode', () => {
  it('always produces codes the shared schema accepts', () => {
    for (let i = 0; i < 500; i++) {
      expect(SessionCodeSchema.safeParse(generateSessionCode()).success).toBe(true);
    }
  });
});

describe('tokens', () => {
  it('are long, URL-safe and unique', () => {
    const a = generateToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateToken()).not.toBe(a);
  });

  it('match only their own hash', () => {
    const token = generateToken();
    expect(tokenMatches(token, hashToken(token))).toBe(true);
    expect(tokenMatches(generateToken(), hashToken(token))).toBe(false);
    expect(tokenMatches(token, 'not-a-hash')).toBe(false);
  });
});

describe('InMemorySessionStore', () => {
  const session = { code: 'ABCDEF', updatedAt: 0, members: [] } as unknown as StoredSession;

  it('refuses to create a second session with the same code', async () => {
    const store = new InMemorySessionStore();
    expect(await store.create(session)).toBe(true);
    expect(await store.create(session)).toBe(false);
  });

  it('returns copies, so callers cannot mutate stored state without save()', async () => {
    const store = new InMemorySessionStore();
    await store.create(session);
    const copy = await store.get('ABCDEF');
    copy!.members.push({} as never);
    expect((await store.get('ABCDEF'))!.members).toHaveLength(0);
  });
});
