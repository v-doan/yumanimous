import pg from 'pg';

/**
 * Least privilege in production (Phase 9). Three roles:
 *
 * - owner (Neon's default role): owns the schema, runs migrations once per deploy.
 * - app: reads and writes rows; cannot create, alter or drop anything.
 * - reader: SELECT only, and only what the agents' session tools (mcp-session)
 *   read. Rejoin token hashes are left out by a column-level grant, so even a
 *   query written by mistake can't return them.
 *
 * The app and reader roles are created with SQL by the owner, not in the Neon
 * console: console-made roles join `neon_superuser`, which would undo all of this.
 */
export const APP_ROLE = 'yumanimous_app';
export const READER_ROLE = 'yumanimous_reader';

/** What the reader may see: exactly the tables and columns mcp-session queries. */
const READER_TABLES = [
  'sessions',
  'session_cards',
  'cards',
  'member_preferences',
  'swipes',
  'matches',
] as const;
const READER_MEMBER_COLUMNS = ['id', 'seq', 'session_code', 'name', 'joined_at', 'disconnected_at'];

const ROLE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

interface Roles {
  app: string;
  reader: string;
}

function checkNames({ app, reader }: Roles) {
  for (const name of [app, reader]) {
    if (!ROLE_NAME.test(name)) throw new Error(`Not a safe role name: ${name}`);
  }
}

/**
 * Creates the two roles, or resets their passwords if they exist. Login only: no
 * superuser, no creating databases or roles, no inherited privileges.
 */
export async function ensureRoles(
  db: pg.Pool | pg.Client,
  passwords: { app: string; reader: string },
  roles: Roles = { app: APP_ROLE, reader: READER_ROLE },
): Promise<void> {
  checkNames(roles);
  for (const [role, password] of [
    [roles.app, passwords.app],
    [roles.reader, passwords.reader],
  ] as const) {
    const { rows } = await db.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
    const verb = rows.length ? 'ALTER' : 'CREATE';
    // Role names are checked above; the password is quoted as a literal (DDL can't
    // take bind parameters).
    await db.query(
      `${verb} ROLE ${role} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT ` +
        `NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 20 PASSWORD ${pg.escapeLiteral(password)}`,
    );
  }
}

/**
 * Grants for the current database. Idempotent: it runs on every deploy, after
 * migrations, so a table added by a new migration is granted (to the app only)
 * before the new version starts.
 */
export async function applyGrants(
  db: pg.Pool | pg.Client,
  roles: Roles = { app: APP_ROLE, reader: READER_ROLE },
): Promise<void> {
  checkNames(roles);
  const { app, reader } = roles;
  const statements = [
    // Nobody but the owner may create objects in the schema.
    'REVOKE CREATE ON SCHEMA public FROM PUBLIC',
    `GRANT USAGE ON SCHEMA public TO ${app}, ${reader}`,

    // App: rows only, every table except the migrations ledger.
    `REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${app}`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${app}`,
    `REVOKE ALL ON schema_migrations FROM ${app}`,
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${app}`,

    // Reader: a fixed list of tables, and members without token_hash.
    `REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${reader}`,
    `GRANT SELECT ON ${READER_TABLES.join(', ')} TO ${reader}`,
    `GRANT SELECT (${READER_MEMBER_COLUMNS.join(', ')}) ON members TO ${reader}`,
  ];
  for (const sql of statements) await db.query(sql);
}

/** A connection string for `role`, on the same host and database as `ownerUrl`. */
export function connectionStringFor(ownerUrl: string, role: string, password: string): string {
  const url = new URL(ownerUrl);
  url.username = role;
  url.password = password;
  return url.toString();
}
