import { existsSync } from 'node:fs';
import path from 'node:path';
import express, { type ErrorRequestHandler, type RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';
import helmet from 'helmet';
import { z } from 'zod';
import {
  CreateSessionRequestSchema,
  JoinSessionRequestSchema,
  SessionCodeSchema,
  type ApiError,
} from '@yumanimous/shared';
import type { AiCallLog, BudgetGuard } from '../ai/aiCallLog.js';
import type { Limits } from '../security/limits.js';
import {
  SessionError,
  type SessionErrorCode,
  type SessionService,
} from '../sessions/sessionService.js';

const STATUS_BY_ERROR: Record<SessionErrorCode, number> = {
  not_found: 404,
  full: 409,
  name_taken: 409,
  not_host: 403,
  not_member: 403,
  not_started: 409,
  unknown_card: 400,
  already_started: 409,
  // The recipe service is down, or the group's rules leave too few recipes.
  deck_unavailable: 503,
  not_allowed: 403,
  no_list: 404,
  busy: 503,
};

export interface AppOptions {
  /** Allowed browser origin when the web app is hosted elsewhere. */
  webOrigin?: string | undefined;
  /** Development only: AI cost and latency for the debug page. */
  debug?: { aiLog: AiCallLog; budget: BudgetGuard } | undefined;
  /** Rate limits; omitted in tests and local development. */
  limits?: Limits | undefined;
  /**
   * Proxies in front of the API (Fly's edge: 1). Express then takes the client IP
   * from that many hops back in X-Forwarded-For; anything further left is ignored,
   * since a client can put whatever it likes there.
   */
  trustedProxies?: number;
  /**
   * Production: the built web app, served from this same origin (no CORS needed,
   * and one strict Content Security Policy covers the whole site).
   */
  staticDir?: string | undefined;
  /** The site's public origin, e.g. https://yumanimous.fly.dev (for the CSP). */
  publicOrigin?: string | undefined;
}

/**
 * Where images may load from: Spoonacular's CDN (recipe photos) and Unsplash (the
 * hard-coded deck). Everything else must come from the site itself.
 */
const IMAGE_HOSTS = ['https://img.spoonacular.com', 'https://images.unsplash.com'];

export function createApp(
  service: SessionService,
  { webOrigin, debug, limits, trustedProxies = 0, staticDir, publicOrigin }: AppOptions = {},
) {
  const app = express();
  app.disable('x-powered-by');
  if (trustedProxies > 0) app.set('trust proxy', trustedProxies);

  app.use(securityHeaders(publicOrigin));
  // Requests here are tiny (a name, a rule). A small cap stops oversized payloads early.
  app.use(express.json({ limit: '10kb' }));
  if (webOrigin) app.use(cors(webOrigin));

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  const limit = (max: number, windowMs: number): RequestHandler =>
    limits
      ? rateLimit({
          windowMs,
          limit: max,
          standardHeaders: 'draft-8',
          legacyHeaders: false,
          handler: (_req, res) =>
            sendError(res, 429, {
              error: 'rate_limited',
              message: 'Too many tries from your network. Give it a minute and try again.',
            }),
        })
      : (_req, _res, next) => next();
  const MINUTE = 60_000;

  /** Host creates a session. The response holds the host's rejoin token. */
  app.post('/api/sessions', limit(limits?.createPerHour ?? 0, 60 * MINUTE), async (req, res) => {
    const input = CreateSessionRequestSchema.parse(req.body);
    res.status(201).json(await service.create(input));
  });

  /** What the join screen shows before someone picks a name. */
  app.get('/api/sessions/:code', limit(limits?.previewPerMin ?? 0, MINUTE), async (req, res) => {
    res.json(await service.preview(parseCode(req.params.code)));
  });

  /** A guest joins with a display name. */
  app.post(
    '/api/sessions/:code/members',
    limit(limits?.joinPer10Min ?? 0, 10 * MINUTE),
    async (req, res) => {
      const code = parseCode(req.params.code);
      const { name } = JoinSessionRequestSchema.parse(req.body);
      res.status(201).json(await service.join(code, name));
    },
  );

  if (debug) {
    /** Every logged AI run (optionally for one session) and this month's spend. */
    app.get('/api/debug/ai', async (req, res) => {
      const session =
        typeof req.query.session === 'string' ? parseCode(req.query.session) : undefined;
      const [calls, month] = await Promise.all([
        debug.aiLog.list({ ...(session ? { sessionCode: session } : {}), limit: 100 }),
        debug.budget.status(),
      ]);
      res.json({ month, calls });
    });
  }

  app.use('/api', (_req, res) => {
    sendError(res, 404, { error: 'not_found', message: 'No such endpoint' });
  });

  if (staticDir) serveWebApp(app, staticDir);

  app.use(errorHandler);
  return app;
}

/**
 * Headers for every response (Helmet). The CSP is the main backstop against script
 * injection: guest tokens live in localStorage, so injected script must never run.
 * Only the site's own scripts, styles and fonts load; images also from the recipe
 * CDNs; sockets only back to this site.
 */
function securityHeaders(publicOrigin: string | undefined): RequestHandler {
  const sockets = publicOrigin ? [publicOrigin.replace(/^http/, 'ws')] : [];
  return helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        fontSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', ...IMAGE_HOSTS],
        connectSrc: ["'self'", ...sockets],
        manifestSrc: ["'self'"],
        workerSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        // Only on https: on a plain-http local run it would break every request.
        upgradeInsecureRequests: publicOrigin?.startsWith('https:') ? [] : null,
      },
    },
    // Session codes are in page URLs: never send them to image hosts in a Referer.
    referrerPolicy: { policy: 'no-referrer' },
    strictTransportSecurity: { maxAge: 365 * 24 * 60 * 60, includeSubDomains: true },
    // Recipe photos come from other origins; the default would block them.
    crossOriginEmbedderPolicy: false,
  });
}

/**
 * The built web app. Vite's hashed assets never change, so they're cached for a
 * year; index.html is never cached, so a deploy reaches everyone on their next load.
 * Any other GET that isn't an API route gets index.html (client-side routes).
 */
function serveWebApp(app: express.Express, dir: string) {
  const root = path.resolve(dir);
  // Fail at startup, not on the first visitor, if the build is missing.
  if (!existsSync(path.join(root, 'index.html'))) {
    throw new Error(`No web app build at ${root} (index.html missing)`);
  }
  app.use(
    '/assets',
    express.static(path.join(root, 'assets'), {
      immutable: true,
      maxAge: '365d',
      index: false,
      fallthrough: false,
    }),
  );
  app.use(express.static(root, { index: false, maxAge: '1h' }));
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (req.path.startsWith('/api/') || req.path.startsWith('/socket.io/')) return next();
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(root, 'index.html'));
  });
}

/** A malformed code can't exist, so it's reported as "not found", not "bad request". */
function parseCode(raw: unknown): string {
  const result = SessionCodeSchema.safeParse(raw);
  if (!result.success) throw new SessionError('not_found', 'That session does not exist');
  return result.data;
}

// Express 5 forwards rejected promises from async handlers here automatically.
const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof SessionError) {
    return sendError(res, STATUS_BY_ERROR[err.code], { error: err.code, message: err.message });
  }
  if (err instanceof z.ZodError) {
    // The first issue is enough for a form; it's phrased for people (see shared schemas).
    const message = err.issues[0]?.message ?? 'Invalid request';
    return sendError(res, 400, { error: 'invalid_request', message });
  }
  // body-parser errors carry an HTTP status (400 bad JSON, 413 too large).
  const status = typeof err?.status === 'number' && err.status < 500 ? err.status : 500;
  if (status === 500) console.error(err);
  return sendError(res, status, {
    error: status === 500 ? 'internal' : 'invalid_request',
    message: status === 500 ? 'Something went wrong' : 'Invalid request',
  });
};

function sendError(res: express.Response, status: number, body: ApiError) {
  res.status(status).json(body);
}

/** Minimal CORS for one known origin; avoids a dependency for four headers. */
function cors(origin: string): RequestHandler {
  return (req, res, next) => {
    if (req.headers.origin === origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    }
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  };
}
