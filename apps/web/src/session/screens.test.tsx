import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { deck, member, sessionView } from '../test/fixtures';
import { Lobby } from './Lobby';
import { MatchOverlay } from './MatchOverlay';
import { Results } from './Results';

describe('Lobby', () => {
  const lobby = sessionView({ status: 'lobby' });
  const noop = async () => {};
  const save = async () => true;

  it('shows the code and everyone who has joined', () => {
    render(<Lobby view={lobby} myId="sam" onStart={noop} onSavePreferences={save} />);
    expect(screen.getByText('ABCDEF')).toBeInTheDocument();
    expect(screen.getByText('Here so far (2)')).toBeInTheDocument();
    expect(screen.getByText('Sam (you)')).toBeInTheDocument();
  });

  it('lets the host start', async () => {
    const onStart = vi.fn(noop);
    render(<Lobby view={lobby} myId="vy" onStart={onStart} onSavePreferences={save} />);
    await userEvent.click(screen.getByRole('button', { name: 'Start swiping' }));
    expect(onStart).toHaveBeenCalledOnce();
  });

  it('tells guests who they are waiting for', () => {
    render(<Lobby view={lobby} myId="sam" onStart={noop} onSavePreferences={save} />);
    expect(screen.queryByRole('button', { name: /start/i })).not.toBeInTheDocument();
    expect(screen.getByText('Waiting for Vy to start…')).toBeInTheDocument();
  });
});

describe('Results', () => {
  it('ranks matches first, then by yums, and shows who is still swiping', () => {
    const view = sessionView({
      members: [member('vy', { isHost: true, swipedCount: 3 }), member('sam', { swipedCount: 1 })],
      swipes: [
        { cardId: 'soup', memberId: 'vy', direction: 'skip' },
        { cardId: 'salad', memberId: 'vy', direction: 'like' },
        { cardId: 'stew', memberId: 'vy', direction: 'like' },
        { cardId: 'stew', memberId: 'sam', direction: 'like' },
      ],
      matches: [{ cardId: 'stew', matchedAt: 1 }],
    });
    render(<Results view={view} myId="vy" onOpenList={() => {}} onAcceptSuggestion={() => {}} />);

    const items = within(screen.getByRole('list', { name: 'Leaderboard' })).getAllByRole(
      'listitem',
    );
    expect(items.map((li) => li.querySelector('span')?.textContent)).toEqual([
      'Bean Stew',
      'Green Salad',
      'Tomato Soup',
    ]);
    expect(items[0]).toHaveTextContent('2/2 yum');
    expect(items[0]).toHaveTextContent('Match');
    expect(items[2]).toHaveTextContent('Out');
    expect(screen.getByText('Waiting on Sam.')).toBeInTheDocument();
  });

  it('says so when the session finished without a match', () => {
    const view = sessionView({
      members: [member('vy', { swipedCount: 3 })],
      finished: true,
    });
    render(<Results view={view} myId="vy" onOpenList={() => {}} onAcceptSuggestion={() => {}} />);
    expect(screen.getByRole('heading', { name: 'No match this time' })).toBeInTheDocument();
  });
});

describe('MatchOverlay', () => {
  it('celebrates a unanimous match and offers next steps', async () => {
    const onKeepSwiping = vi.fn();
    const view = sessionView({
      swipes: [
        { cardId: 'soup', memberId: 'vy', direction: 'like' },
        { cardId: 'soup', memberId: 'sam', direction: 'like' },
      ],
    });
    render(
      <MatchOverlay
        card={deck[0]!}
        view={view}
        onKeepSwiping={onKeepSwiping}
        onSeeResults={() => {}}
        onShoppingList={() => {}}
      />,
    );
    expect(screen.getByRole('dialog', { name: 'It’s a match!' })).toBeInTheDocument();
    expect(screen.getByText('Everyone said yum')).toBeInTheDocument();

    const keep = screen.getByRole('button', { name: 'Keep swiping' });
    expect(keep).toHaveFocus();
    await userEvent.click(keep);
    expect(onKeepSwiping).toHaveBeenCalledOnce();
  });

  it('names who said yum for a majority match', () => {
    const view = sessionView({
      matchRule: 'majority',
      members: [member('vy'), member('sam'), member('kim')],
      swipes: [
        { cardId: 'soup', memberId: 'vy', direction: 'like' },
        { cardId: 'soup', memberId: 'kim', direction: 'like' },
      ],
    });
    render(
      <MatchOverlay
        card={deck[0]!}
        view={view}
        onKeepSwiping={() => {}}
        onSeeResults={() => {}}
        onShoppingList={() => {}}
      />,
    );
    expect(screen.getByText('Yum from Vy, Kim')).toBeInTheDocument();
  });
});
