import { MembershipSchema, type Membership } from '@yumanimous/shared';

/**
 * A guest's identity per session lives in localStorage, so a refresh or a closed
 * tab rejoins as the same member. No account needed. Every access is wrapped in
 * try/catch because storage can be blocked (private mode, strict settings).
 */
const key = (code: string) => `yumanimous:member:${code}`;

export function loadIdentity(code: string): Membership | null {
  try {
    const raw = localStorage.getItem(key(code));
    if (!raw) return null;
    const parsed = MembershipSchema.safeParse(JSON.parse(raw));
    return parsed.success && parsed.data.code === code ? parsed.data : null;
  } catch {
    return null;
  }
}

export function saveIdentity(membership: Membership): void {
  try {
    localStorage.setItem(key(membership.code), JSON.stringify(membership));
  } catch {
    // Still works for this page load; it just won't survive a refresh.
  }
}

export function clearIdentity(code: string): void {
  try {
    localStorage.removeItem(key(code));
  } catch {
    // Nothing to clear.
  }
}
