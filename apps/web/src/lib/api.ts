import type { z } from 'zod';
import {
  ApiErrorSchema,
  MembershipSchema,
  SessionPreviewSchema,
  type CreateSessionRequest,
  type Membership,
  type SessionPreview,
} from '@yumanimous/shared';

/** Empty in dev (Vite proxies /api), the API's origin in production. */
export const API_URL = import.meta.env.VITE_API_URL ?? '';

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

/** Responses are validated too: a contract mismatch fails loudly here, not deep in the UI. */
async function request<S extends z.ZodType>(
  path: string,
  schema: S,
  init?: { method: 'POST'; body: unknown },
): Promise<z.infer<S>> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method: init?.method ?? 'GET',
      headers: init ? { 'Content-Type': 'application/json' } : undefined,
      body: init ? JSON.stringify(init.body) : undefined,
    });
  } catch {
    throw new ApiRequestError(0, 'network', 'Can’t reach the server. Check your connection.');
  }

  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const error = ApiErrorSchema.safeParse(body);
    if (error.success) {
      throw new ApiRequestError(res.status, error.data.error, error.data.message);
    }
    // A 5xx without our JSON error body means the request never reached the API
    // (e.g. the dev proxy can't connect because the API isn't running).
    throw res.status >= 500
      ? new ApiRequestError(res.status, 'unreachable', 'Can’t reach the server right now.')
      : new ApiRequestError(res.status, 'unknown', 'Something went wrong');
  }
  return schema.parse(body);
}

export const api = {
  createSession: (input: CreateSessionRequest): Promise<Membership> =>
    request('/api/sessions', MembershipSchema, { method: 'POST', body: input }),

  getPreview: (code: string): Promise<SessionPreview> =>
    request(`/api/sessions/${encodeURIComponent(code)}`, SessionPreviewSchema),

  joinSession: (code: string, name: string): Promise<Membership> =>
    request(`/api/sessions/${encodeURIComponent(code)}/members`, MembershipSchema, {
      method: 'POST',
      body: { name },
    }),
};
