import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import type { Membership } from '@yumanimous/shared';
import { member, sessionView } from '../test/fixtures';
import { SessionRoom } from './SessionRoom';
import { useSession } from './useSession';

// The socket layer is tested on the server; here only the room's UI is under test.
vi.mock('./useSession', () => ({ useSession: vi.fn() }));

const membership: Membership = { code: 'ABCDEF', memberId: 'vy', token: 't'.repeat(43) };
const leave = vi.fn();

function mockSession(overrides: Partial<ReturnType<typeof useSession>> = {}) {
  vi.mocked(useSession).mockReturnValue({
    view: sessionView({ status: 'lobby' }),
    status: 'online',
    ended: null,
    pending: new Set(),
    currentMatch: null,
    error: null,
    deckProgress: null,
    notice: null,
    clearNotice: () => {},
    swipe: () => {},
    start: async () => {},
    setPreferences: async () => true,
    rebuild: async () => {},
    makeList: async () => {},
    toggleLine: async () => {},
    setServings: async () => {},
    acceptSuggestion: async () => {},
    playAgain: async () => {},
    leave,
    dismissMatch: () => {},
    clearError: () => {},
    ...overrides,
  });
}

const renderRoom = () =>
  render(
    <MemoryRouter>
      <SessionRoom membership={membership} onLostIdentity={() => {}} />
    </MemoryRouter>,
  );

beforeEach(() => {
  leave.mockReset();
  mockSession();
});

describe('Leave', () => {
  it('asks in the app’s own dialog, then leaves', async () => {
    renderRoom();
    await userEvent.click(screen.getByRole('button', { name: 'Leave' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Leave this session?' });
    expect(leave).not.toHaveBeenCalled();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Leave' }));
    expect(leave).toHaveBeenCalledOnce();
  });

  it('stays when cancelled', async () => {
    renderRoom();
    await userEvent.click(screen.getByRole('button', { name: 'Leave' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(leave).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('works even where window.confirm is suppressed (returns false at once)', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderRoom();
    await userEvent.click(screen.getByRole('button', { name: 'Leave' }));
    await userEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Leave' }),
    );
    expect(leave).toHaveBeenCalledOnce();
  });

  it('shows the goodbye screen once left', () => {
    mockSession({ ended: 'removed' });
    renderRoom();
    expect(screen.getByRole('heading', { name: 'You left the session' })).toBeInTheDocument();
  });
});

describe('Shopping list', () => {
  const recipe = { id: 'spoonacular:1', title: 'Garlic Noodles', tags: [], blurb: 'Yum.' };

  it('asks how many are eating (default: everyone here), then makes and opens the list', async () => {
    const makeList = vi.fn(async () => {});
    mockSession({
      view: sessionView({
        deck: [recipe],
        swipes: [
          { cardId: recipe.id, memberId: 'vy', direction: 'like' },
          { cardId: recipe.id, memberId: 'sam', direction: 'like' },
        ],
        matches: [{ cardId: recipe.id, matchedAt: 1 }],
        finished: true,
      }),
      makeList,
    });
    renderRoom();
    await userEvent.click(screen.getByRole('button', { name: 'Make shopping list' }));
    const dialog = screen.getByRole('dialog', { name: 'How many are eating?' });
    expect(within(dialog).getByText('2 servings')).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Make list' }));
    expect(makeList).toHaveBeenCalledWith(recipe.id, 2);
  });

  it('opens an existing list straight away', async () => {
    mockSession({
      view: sessionView({
        deck: [recipe],
        matches: [{ cardId: recipe.id, matchedAt: 1 }],
        members: [],
        shoppingLists: [
          {
            cardId: recipe.id,
            title: recipe.title,
            servings: 2,
            recipeServings: 2,
            status: 'building',
            source: null,
            createdBy: 'vy',
            ingredients: [],
            lines: [],
            error: null,
          },
        ],
      }),
    });
    renderRoom();
    await userEvent.click(screen.getByRole('button', { name: 'Results' }));
    await userEvent.click(screen.getByRole('button', { name: 'View shopping list' }));
    expect(screen.getByRole('status')).toHaveTextContent('Making the list…');
  });
});

describe('Play again (Phase 8)', () => {
  const decided = {
    swipes: [
      { cardId: 'soup', memberId: 'vy', direction: 'like' as const },
      { cardId: 'soup', memberId: 'sam', direction: 'like' as const },
    ],
    matches: [{ cardId: 'soup', matchedAt: 1 }],
    canPlayAgain: true,
  };

  it('lets the host start another round after confirming', async () => {
    const playAgain = vi.fn(async () => {});
    mockSession({
      view: sessionView({ ...decided, members: [member('vy', { isHost: true }), member('sam')] }),
      playAgain,
    });
    renderRoom();
    await userEvent.click(screen.getByRole('button', { name: 'Results' }));
    await userEvent.click(screen.getByRole('button', { name: 'Play again' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Play another round?' });
    expect(playAgain).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Play again' }));
    expect(playAgain).toHaveBeenCalledOnce();
  });

  it('tells guests the host can start another round', async () => {
    mockSession({
      view: sessionView({ ...decided, members: [member('vy'), member('sam', { isHost: true })] }),
    });
    renderRoom();
    await userEvent.click(screen.getByRole('button', { name: 'Results' }));
    expect(screen.queryByRole('button', { name: 'Play again' })).not.toBeInTheDocument();
    expect(
      screen.getByText('The host can start another round with a fresh deck.'),
    ).toBeInTheDocument();
  });

  it('shows the round from round 2', () => {
    mockSession({ view: sessionView({ round: 2 }) });
    renderRoom();
    expect(screen.getByText(/Round 2/)).toBeInTheDocument();
  });

  it('a new round goes back to the deck from the results', async () => {
    mockSession({ view: sessionView({ ...decided }) });
    const { rerender } = renderRoom();
    await userEvent.click(screen.getByRole('button', { name: 'Results' }));
    expect(screen.getByRole('heading', { name: 'Live results' })).toBeInTheDocument();

    mockSession({ view: sessionView({ round: 2 }) });
    rerender(
      <MemoryRouter>
        <SessionRoom membership={membership} onLostIdentity={() => {}} />
      </MemoryRouter>,
    );
    expect(screen.queryByRole('heading', { name: 'Live results' })).not.toBeInTheDocument();
  });
});
