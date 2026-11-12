import { useCallback, useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import type {
  AckResult,
  ClientToServerEvents,
  MemberPreferences,
  Membership,
  ServerToClientEvents,
  SessionView,
  SwipeDirection,
} from '@yumanimous/shared';
import { API_URL } from '../lib/api';
import { clearIdentity } from '../lib/identity';

type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

export type ConnectionStatus = 'connecting' | 'online' | 'reconnecting';
/** Why this member can no longer be in the session. */
export type EndReason = 'removed' | 'expired' | 'invalid-identity';

/**
 * One socket per session page. The server is the source of truth: every change
 * arrives as a full `session:state` snapshot. The only local state is the set of
 * swipes sent but not yet confirmed, so the deck advances instantly (optimistic UI).
 */
export function useSession(membership: Membership) {
  const { code, token } = membership;
  const socketRef = useRef<AppSocket | null>(null);
  const [view, setView] = useState<SessionView | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [ended, setEnded] = useState<EndReason | null>(null);
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [matchQueue, setMatchQueue] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // socket.io-client reconnects with backoff on its own; the same auth is resent,
    // so a dropped connection rejoins as the same member.
    const socket: AppSocket = io(API_URL || undefined, { auth: { code, token } });
    socketRef.current = socket;

    const end = (reason: EndReason) => {
      clearIdentity(code);
      setEnded(reason);
      socket.disconnect();
    };

    socket.on('connect', () => setStatus('online'));
    socket.on('disconnect', (reason) => {
      setStatus('reconnecting');
      // A server restart or deploy closes sockets with "io server disconnect", which
      // socket.io deliberately doesn't retry. Sessions now survive restarts (Phase 3),
      // so retry. When the server means it (member removed), `session:ended` arrives
      // first and `end()` has already disconnected us, so this doesn't fire then.
      if (reason === 'io server disconnect') socket.connect();
    });
    socket.on('session:state', setView);
    socket.on('session:match', ({ cardId }) => setMatchQueue((q) => [...q, cardId]));
    socket.on('session:ended', end);
    socket.on('connect_error', (err) => {
      // Auth failures are final (session gone, or this member was removed). Anything
      // else is a network problem, which socket.io keeps retrying.
      if (err.message === 'unauthorized') end('invalid-identity');
    });

    return () => {
      socket.removeAllListeners();
      socket.disconnect();
      socketRef.current = null;
    };
  }, [code, token]);

  const swipe = useCallback((cardId: string, direction: SwipeDirection) => {
    const socket = socketRef.current;
    if (!socket) return;
    setPending((p) => new Set(p).add(cardId));
    // While offline, socket.io buffers this and sends it after reconnecting.
    socket.emit('swipe', { cardId, direction }, (result: AckResult) => {
      setPending((p) => {
        const next = new Set(p);
        next.delete(cardId);
        return next;
      });
      if (!result.ok) setError(result.error);
    });
  }, []);

  const start = useCallback(async () => {
    const result = await socketRef.current?.emitWithAck('session:start');
    if (result && !result.ok) setError(result.error);
  }, []);

  /** Resolves true when saved, so the panel can show "Saved". */
  const setPreferences = useCallback(async (preferences: MemberPreferences) => {
    const result = await socketRef.current?.emitWithAck('preferences:set', preferences);
    if (result && !result.ok) setError(result.error);
    return result?.ok ?? false;
  }, []);

  const rebuild = useCallback(async () => {
    const result = await socketRef.current?.emitWithAck('session:rebuild');
    if (result && !result.ok) setError(result.error);
  }, []);

  const leave = useCallback(() => {
    socketRef.current?.emit('session:leave', () => {});
    clearIdentity(code);
    setEnded('removed');
  }, [code]);

  const dismissMatch = useCallback(() => setMatchQueue((q) => q.slice(1)), []);
  const clearError = useCallback(() => setError(null), []);

  return {
    view,
    status,
    ended,
    pending,
    currentMatch: matchQueue[0] ?? null,
    error,
    swipe,
    start,
    setPreferences,
    rebuild,
    leave,
    dismissMatch,
    clearError,
  };
}
