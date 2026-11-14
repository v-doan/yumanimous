import pg from 'pg';
import { migrate } from './migrate.js';
import { applyGrants, APP_ROLE, READER_ROLE } from './roles.js';

// `npm run db:migrate` locally (reads DATABASE_URL from the repo-root .env), and the
// production release step on Fly, which runs once per deploy as the schema owner
// (DATABASE_OWNER_URL), then re-applies the least-privilege grants so any table a
// new migration added is covered before the new version starts.
const ownerUrl = process.env.DATABASE_OWNER_URL;
const connectionString = ownerUrl ?? process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL (or DATABASE_OWNER_URL) is not set (see .env.example).');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString });
try {
  const ran = await migrate(pool);
  console.log(ran.length ? `Applied: ${ran.join(', ')}` : 'Database is up to date.');
  if (ownerUrl) {
    await applyGrants(pool);
    console.log(`Grants applied for ${APP_ROLE} and ${READER_ROLE}.`);
  }
} finally {
  await pool.end();
}
