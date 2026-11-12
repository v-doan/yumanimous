import { z } from 'zod';
import { createServer } from './createServer.js';

const env = z
  .object({
    PORT: z.coerce.number().int().positive().default(3001),
    // Only needed when the web app is served from a different origin (production).
    WEB_ORIGIN: z.url().optional(),
  })
  .parse(process.env);

const server = await createServer({ port: env.PORT, webOrigin: env.WEB_ORIGIN });
console.log(`API listening on ${server.url}`);

// Sessions live in memory until Phase 3, so drop ones idle for a day to cap memory.
const DAY = 24 * 60 * 60_000;
setInterval(() => void server.service.sweepIdle(DAY), 60 * 60_000).unref();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void server.close().then(() => process.exit(0));
  });
}
