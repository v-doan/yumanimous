import pg from 'pg';
import { migrate } from './migrate.js';

// `npm run db:migrate`. The API also migrates on startup; this is for running it on its own.
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is not set (see .env.example).');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString });
try {
  const ran = await migrate(pool);
  console.log(ran.length ? `Applied: ${ran.join(', ')}` : 'Database is up to date.');
} finally {
  await pool.end();
}
