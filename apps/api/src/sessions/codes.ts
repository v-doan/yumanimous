import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { SESSION_CODE_ALPHABET, SESSION_CODE_LENGTH } from '@yumanimous/shared';

/** crypto.randomInt is uniform, unlike `Math.random() * n`, and not predictable. */
export function generateSessionCode(): string {
  let code = '';
  for (let i = 0; i < SESSION_CODE_LENGTH; i++) {
    code += SESSION_CODE_ALPHABET[randomInt(SESSION_CODE_ALPHABET.length)];
  }
  return code;
}

export const generateMemberId = (): string => randomUUID();

/** 256 bits of randomness: the member's rejoin key, kept in their browser's localStorage. */
export const generateToken = (): string => randomBytes(32).toString('base64url');

/**
 * Only a hash of each token is stored, like a password. If the store (Postgres from
 * Phase 3) ever leaks, the hashes can't be used to impersonate a member. A plain
 * SHA-256 is enough here because the token is random, not a human-chosen password.
 */
export const hashToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

/** Constant-time compare, so response timing can't reveal how much of a hash matched. */
export function tokenMatches(token: string, storedHash: string): boolean {
  const a = Buffer.from(hashToken(token), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
