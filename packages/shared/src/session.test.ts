import { describe, expect, it } from 'vitest';
import { GuestNameSchema } from './member.js';
import { CreateSessionRequestSchema, SessionCodeSchema } from './session.js';
import { SocketAuthSchema } from './events.js';

describe('GuestNameSchema', () => {
  it('trims whitespace', () => {
    expect(GuestNameSchema.parse('  Sam  ')).toBe('Sam');
  });

  it('allows emoji, including ZWJ sequences', () => {
    expect(GuestNameSchema.safeParse('Mai 👩‍🍳').success).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['only spaces', '   '],
    ['too long', 'x'.repeat(25)],
    ['control character', 'Sam\u0000'],
    ['newline', 'Sam\nAdmin'],
    ['bidi override (name spoofing)', 'Sam‮nimda'],
  ])('rejects %s', (_label, name) => {
    expect(GuestNameSchema.safeParse(name).success).toBe(false);
  });
});

describe('SessionCodeSchema', () => {
  it('normalises lowercase and whitespace', () => {
    expect(SessionCodeSchema.parse(' abc234 ')).toBe('ABC234');
  });

  it.each(['ABC12', 'ABC2345', 'ABCDE0', 'ABCDEO', 'ABCDEI', 'ABCDEL', 'ABCDE1', 'ABC-23'])(
    'rejects %s',
    (code) => {
      expect(SessionCodeSchema.safeParse(code).success).toBe(false);
    },
  );
});

describe('CreateSessionRequestSchema', () => {
  it('defaults the match rule to everyone', () => {
    expect(CreateSessionRequestSchema.parse({ hostName: 'Vy' }).matchRule).toBe('everyone');
  });

  it('rejects unknown match rules', () => {
    expect(
      CreateSessionRequestSchema.safeParse({ hostName: 'Vy', matchRule: 'dictator' }).success,
    ).toBe(false);
  });
});

describe('SocketAuthSchema', () => {
  it('rejects a short token', () => {
    expect(SocketAuthSchema.safeParse({ code: 'ABCDEF', token: 'short' }).success).toBe(false);
  });
});
