import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import type { Membership } from '@yumanimous/shared';
import { sessionView } from '../test/fixtures';
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
