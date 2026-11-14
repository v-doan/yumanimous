import type { Card, Member, SessionView } from '@yumanimous/shared';

export const deck: Card[] = [
  { id: 'soup', title: 'Tomato Soup', tags: [], blurb: 'Cosy.' },
  { id: 'salad', title: 'Green Salad', tags: [], blurb: 'Crunchy.' },
  { id: 'stew', title: 'Bean Stew', tags: [], blurb: 'Hearty.' },
];

export const member = (id: string, overrides: Partial<Member> = {}): Member => ({
  id,
  name: id.charAt(0).toUpperCase() + id.slice(1),
  isHost: false,
  connected: true,
  swipedCount: 0,
  preferences: null,
  joinedAt: 0,
  ...overrides,
});

export const sessionView = (overrides: Partial<SessionView> = {}): SessionView => ({
  code: 'ABCDEF',
  mode: 'cook-in',
  matchRule: 'everyone',
  status: 'swiping',
  deck,
  members: [member('vy', { isHost: true }), member('sam')],
  swipes: [],
  matches: [],
  finished: false,
  deckFilters: null,
  uncovered: [],
  shoppingLists: [],
  suggestion: null,
  mediating: false,
  ...overrides,
});
