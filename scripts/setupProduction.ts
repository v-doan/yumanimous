/**
 * `npm run setup:prod`: one-time production setup (run it again to rotate).
 *
 * Asks for three secrets with hidden typing, then:
 * 1. normalizes the Neon owner URL: direct host (not "-pooler", which can't carry the
 *    read-only setting or run migrations) and certificate-verified TLS;
 * 2. migrates, creates the least-privilege app and reader roles with fresh random
 *    passwords, and applies grants;
 * 3. hands every runtime secret to `fly secrets import` over a pipe.
 *
 * Nothing secret is printed, written to disk, or put on a command line (so it never
 * lands in shell history). The owner URL itself is NOT sent to Fly: only CI uses it.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import {
  applyGrants,
  APP_ROLE,
  connectionStringFor,
  ensureRoles,
  migrate,
  READER_ROLE,
} from '@yumanimous/db';

const APP = 'yumanimous';

/** Reads a line without echoing it (shows * per character). */
function askHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) return reject(new Error('Run this in a terminal (it needs hidden input).'));
    process.stderr.write(question);
    let value = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stderr.write('\n');
          return resolve(value.trim());
        }
        if (ch === '\u0003') {
          process.stderr.write('\n');
          process.exit(130); // Ctrl+C
        }
        if (ch === '\u007f' || ch === '\b') {
          if (value.length) {
            value = value.slice(0, -1);
            process.stderr.write('\b \b');
          }
          continue;
        }
        value += ch;
        process.stderr.write('*');
      }
    };
    stdin.on('data', onData);
  });
}

/**
 * Accepts what Neon's "Connect" dialog offers (a URL, or the `psql '...'` line) and
 * returns a URL on the direct host with sslmode=verify-full.
 */
export function normalizeOwnerUrl(input: string): string {
  const match = /postgres(?:ql)?:\/\/[^\s'"]+/.exec(input);
  if (!match) {
    throw new Error(
      'That doesn’t look like a connection string. In Neon, click Connect and copy the one ' +
        'starting with postgresql://',
    );
  }
  const url = new URL(match[0]);
  url.hostname = url.hostname.replace('-pooler.', '.');
  url.searchParams.set('sslmode', 'verify-full');
  return url.toString();
}

function flyBinary(): string {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
  const local = path.join(
    home,
    '.fly',
    'bin',
    process.platform === 'win32' ? 'flyctl.exe' : 'flyctl',
  );
  return existsSync(local) ? local : 'fly';
}

/** `fly secrets import`, fed on stdin (no shell, no command-line secrets). */
function flySecretsImport(lines: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(flyBinary(), ['secrets', 'import', '--stage', '--app', APP], {
      stdio: ['pipe', 'inherit', 'inherit'],
    });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`fly secrets import exited with ${code}`)),
    );
    child.stdin.end(lines);
  });
}

const step = (n: number, text: string) => process.stderr.write(`\n${n}. ${text}\n`);

/** Asks until the answer passes `check` (which returns a problem to show, or null). */
async function askUntil(check: (value: string) => string | null): Promise<string> {
  for (;;) {
    const value = await askHidden('   Paste it (hidden), then Enter: ');
    const problem = check(value);
    if (!problem) return value;
    process.stderr.write(`   ${problem} Try again.\n`);
  }
}

step(1, 'Neon owner connection string (Neon → Connect → copy the postgresql:// one).');
const ownerUrl = normalizeOwnerUrl(
  await askUntil((v) => {
    try {
      normalizeOwnerUrl(v);
      return null;
    } catch (err) {
      return (err as Error).message;
    }
  }),
);
process.stderr.write(`   Using host ${new URL(ownerUrl).hostname} with verified TLS.\n`);

step(2, 'Spoonacular API key (the new one).');
const spoonacular = await askUntil((v) =>
  /^[a-f0-9]{32}$/i.test(v) ? null : 'That isn’t a Spoonacular key (32 letters and digits).',
);
step(3, 'Anthropic API key (from the yumanimous-prod workspace).');
const anthropic = await askUntil((v) =>
  /^sk-ant-[\w-]{20,}$/.test(v) ? null : 'That isn’t an Anthropic key (it starts with sk-ant-).',
);

step(4, 'Setting up the database (migrations, roles, grants)…');
const passwords = {
  app: randomBytes(32).toString('base64url'),
  reader: randomBytes(32).toString('base64url'),
};
const pool = new pg.Pool({ connectionString: ownerUrl });
try {
  await migrate(pool);
  await ensureRoles(pool, passwords);
  await applyGrants(pool);
} finally {
  await pool.end();
}
process.stderr.write(`   Roles ${APP_ROLE} and ${READER_ROLE} are ready.\n`);

step(5, `Sending secrets to Fly (app "${APP}")…`);
await flySecretsImport(
  [
    `DATABASE_URL=${connectionStringFor(ownerUrl, APP_ROLE, passwords.app)}`,
    `DATABASE_READER_URL=${connectionStringFor(ownerUrl, READER_ROLE, passwords.reader)}`,
    `SPOONACULAR_API_KEY=${spoonacular}`,
    `ANTHROPIC_API_KEY=${anthropic}`,
  ].join('\n') + '\n',
);

process.stderr.write(
  '\nDone. Fly has DATABASE_URL, DATABASE_READER_URL, SPOONACULAR_API_KEY and ANTHROPIC_API_KEY.\n' +
    'The owner URL was not sent to Fly; put it in GitHub (environment "production",\n' +
    'secret DATABASE_OWNER_URL) for CI migrations.\n',
);
