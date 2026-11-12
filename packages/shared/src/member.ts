import { z } from 'zod';
import { MemberPreferencesSchema } from './preferences.js';

// Control characters and bidi overrides. The overrides (U+202A-202E, U+2066-2069)
// can make a name render backwards to spoof another member, so they are rejected.
// Emoji (including ZWJ sequences like family emoji) are allowed on purpose.
const UNSAFE_CHARS = /[\p{Cc}‪-‮⁦-⁩]/u;

/** A guest's display name. Untrusted input: trimmed, length-limited, no control characters. */
export const GuestNameSchema = z
  .string()
  .trim()
  .min(1, 'Pick a name')
  .max(24, 'Keep it under 24 characters')
  .refine((name) => !UNSAFE_CHARS.test(name), 'That name has characters we cannot show');

export type GuestName = z.infer<typeof GuestNameSchema>;

export const MemberIdSchema = z.string().min(1).max(64);

/** A member as every client sees them. Never includes the member's rejoin token. */
export const MemberSchema = z.object({
  id: MemberIdSchema,
  name: GuestNameSchema,
  isHost: z.boolean(),
  /** False while a member is offline but still inside the rejoin grace period. */
  connected: z.boolean(),
  /** How many cards this member has swiped, for the "who is still swiping" view. */
  swipedCount: z.number().int().min(0),
  /**
   * Confirmed food rules, or null if not set. Shared with the group on purpose: the
   * deck is filtered for everyone's rules, so everyone can see why.
   */
  preferences: MemberPreferencesSchema.nullable(),
  joinedAt: z.number().int(),
});

export type Member = z.infer<typeof MemberSchema>;
