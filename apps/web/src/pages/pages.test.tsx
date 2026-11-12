import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { clearIdentity, loadIdentity, saveIdentity } from '../lib/identity';
import { HomePage } from './HomePage';
import { SessionPage } from './SessionPage';

const TOKEN = 't'.repeat(43);

function renderAt(path: string) {
  const router = createMemoryRouter(
    [
      { path: '/', element: <HomePage /> },
      { path: '/s/:code', element: <SessionPage /> },
    ],
    { initialEntries: [path] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

const json = (status: number, body: unknown) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  localStorage.clear();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

describe('identity storage', () => {
  it('round-trips a membership per session code', () => {
    saveIdentity({ code: 'ABCDEF', memberId: 'm1', token: TOKEN });
    expect(loadIdentity('ABCDEF')).toEqual({ code: 'ABCDEF', memberId: 'm1', token: TOKEN });
    expect(loadIdentity('GHJKMN')).toBeNull();
    clearIdentity('ABCDEF');
    expect(loadIdentity('ABCDEF')).toBeNull();
  });

  it('ignores corrupted entries', () => {
    localStorage.setItem('yumanimous:member:ABCDEF', '{not json');
    expect(loadIdentity('ABCDEF')).toBeNull();
  });
});

describe('HomePage', () => {
  it('creates a session, stores the identity and goes to the session link', async () => {
    fetchMock.mockReturnValueOnce(json(201, { code: 'ABCDEF', memberId: 'host', token: TOKEN }));
    const router = renderAt('/');

    await userEvent.type(screen.getByLabelText('Your name'), 'Vy');
    await userEvent.click(screen.getByLabelText(/majority/i));
    await userEvent.click(screen.getByRole('button', { name: 'Create session' }));

    await vi.waitFor(() => expect(router.state.location.pathname).toBe('/s/ABCDEF'));
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/sessions');
    expect(JSON.parse(init.body)).toEqual({ hostName: 'Vy', matchRule: 'majority' });
    expect(loadIdentity('ABCDEF')?.memberId).toBe('host');
  });

  it('says the server is unreachable when the dev proxy cannot reach the API', async () => {
    fetchMock.mockReturnValueOnce(Promise.resolve(new Response('', { status: 500 })));
    renderAt('/');
    await userEvent.type(screen.getByLabelText('Your name'), 'Vy');
    await userEvent.click(screen.getByRole('button', { name: 'Create session' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Can’t reach the server');
  });

  it('validates the name before calling the API', async () => {
    renderAt('/');
    await userEvent.click(screen.getByRole('button', { name: 'Create session' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Pick a name');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('joins by code, normalising case', async () => {
    const router = renderAt('/');
    fetchMock.mockReturnValue(new Promise(() => {})); // Join screen preview stays loading.
    await userEvent.type(screen.getByLabelText('Session code'), 'abc234');
    await userEvent.click(screen.getByRole('button', { name: 'Join' }));
    expect(router.state.location.pathname).toBe('/s/ABC234');
  });
});

describe('SessionPage join screen', () => {
  const preview = {
    code: 'ABCDEF',
    mode: 'cook-in',
    matchRule: 'everyone',
    status: 'lobby',
    hostName: 'Vy',
    memberCount: 1,
    full: false,
  };

  it('shows who invited you and surfaces a taken name', async () => {
    fetchMock
      .mockReturnValueOnce(json(200, preview))
      .mockReturnValueOnce(
        json(409, { error: 'name_taken', message: 'Someone already has that name here' }),
      );
    renderAt('/s/ABCDEF');

    expect(await screen.findByRole('heading', { name: 'Vy invited you' })).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Your name'), 'Vy');
    await userEvent.click(screen.getByRole('button', { name: 'Join' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Someone already has that name');
  });

  it('shows a friendly page for an unknown session', async () => {
    fetchMock.mockReturnValueOnce(json(404, { error: 'not_found', message: 'nope' }));
    renderAt('/s/ZZZZZZ');
    expect(
      await screen.findByRole('heading', { name: 'That session doesn’t exist' }),
    ).toBeInTheDocument();
  });

  it('treats a malformed code as not found without calling the API', () => {
    renderAt('/s/nope!');
    expect(screen.getByRole('heading', { name: 'That session doesn’t exist' })).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
