import { describe, expect, it } from 'vitest';
import { CardSchema } from './card.js';
import { SwipeSchema } from './swipe.js';

const validCard = {
  id: 'shakshuka',
  title: 'Shakshuka',
  imageUrl: 'https://images.unsplash.com/photo-123?w=800',
  imageAlt: 'Eggs in tomato sauce',
  imageCredit: { name: 'Jane Doe', url: 'https://unsplash.com/@jane' },
  tags: ['vegetarian', '30 min'],
  blurb: 'Eggs poached in a spicy tomato sauce.',
};

describe('CardSchema', () => {
  it('accepts a valid card', () => {
    expect(CardSchema.parse(validCard)).toEqual(validCard);
  });

  it('accepts a card without an image (placeholder case)', () => {
    const { imageUrl: _url, imageAlt: _alt, imageCredit: _credit, ...noImage } = validCard;
    expect(CardSchema.safeParse(noImage).success).toBe(true);
  });

  it('rejects a blurb longer than 160 characters', () => {
    expect(CardSchema.safeParse({ ...validCard, blurb: 'x'.repeat(161) }).success).toBe(false);
  });

  it('rejects non-https image URLs', () => {
    expect(
      CardSchema.safeParse({ ...validCard, imageUrl: 'http://example.com/a.jpg' }).success,
    ).toBe(false);
    expect(CardSchema.safeParse({ ...validCard, imageUrl: 'javascript:alert(1)' }).success).toBe(
      false,
    );
  });

  it('rejects an empty title', () => {
    expect(CardSchema.safeParse({ ...validCard, title: '' }).success).toBe(false);
  });
});

describe('SwipeSchema', () => {
  it('accepts like and skip', () => {
    expect(SwipeSchema.safeParse({ cardId: 'a', direction: 'like' }).success).toBe(true);
    expect(SwipeSchema.safeParse({ cardId: 'a', direction: 'skip' }).success).toBe(true);
  });

  it('rejects unknown directions', () => {
    expect(SwipeSchema.safeParse({ cardId: 'a', direction: 'superlike' }).success).toBe(false);
  });
});
