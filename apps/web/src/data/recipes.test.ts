import { describe, expect, it } from 'vitest';
import { CardSchema } from '@yumanimous/shared';
import { recipes } from './recipes';

describe('hard-coded recipes', () => {
  it('has 10 cards', () => {
    expect(recipes).toHaveLength(10);
  });

  it.each(recipes.map((r) => [r.id, r] as const))('%s matches CardSchema', (_id, recipe) => {
    expect(() => CardSchema.parse(recipe)).not.toThrow();
  });

  it('has unique ids', () => {
    expect(new Set(recipes.map((r) => r.id)).size).toBe(recipes.length);
  });
});
