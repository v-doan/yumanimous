import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { migrate } from './migrate.js';
import { applyGrants, APP_ROLE, connectionStringFor, ensureRoles, READER_ROLE } from './roles.js';

/**
 * One-time production setup (and password rotation): `npm run -s db:roles`.
 *
 * Reads DATABASE_OWNER_URL, migrates, creates the app and reader roles with fresh
 * random passwords, applies grants, and prints the two connection strings as
 * NAME=VALUE lines on stdout, made to be piped straight into `fly secrets import`,
 * so the passwords never have to be copied by hand. Messages go to stderr.
 */
const ownerUrl = process.env.DATABASE_OWNER_URL;
if (!ownerUrl) {
  console.error('Set DATABASE_OWNER_URL to the Neon owner connection string first.');
  process.exit(1);
}
if (!/[?&]sslmode=verify-full(&|$)/.test(ownerUrl)) {
  console.error('DATABASE_OWNER_URL must use sslmode=verify-full.');
  process.exit(1);
}

const password = () => randomBytes(32).toString('base64url');
const passwords = { app: password(), reader: password() };

const pool = new pg.Pool({ connectionString: ownerUrl });
try {
  await migrate(pool);
  await ensureRoles(pool, passwords);
  await applyGrants(pool);
  console.error(`Roles ${APP_ROLE} and ${READER_ROLE} are ready; grants applied.`);
  process.stdout.write(
    `DATABASE_URL=${connectionStringFor(ownerUrl, APP_ROLE, passwords.app)}\n` +
      `DATABASE_READER_URL=${connectionStringFor(ownerUrl, READER_ROLE, passwords.reader)}\n`,
  );
} finally {
  await pool.end();
}
