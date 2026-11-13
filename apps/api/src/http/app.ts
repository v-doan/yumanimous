import express, { type ErrorRequestHandler, type RequestHandler } from 'express';
import { z } from 'zod';
import {
  CreateSessionRequestSchema,
  JoinSessionRequestSchema,
  SessionCodeSchema,
  type ApiError,
} from '@yumanimous/shared';
import type { AiCallLog, BudgetGuard } from '../ai/aiCallLog.js';
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
};

export interface AppOptions {
  /** Allowed browser origin when the web app is hosted elsewhere (production). */
  webOrigin?: string | undefined;
  /** Development only: AI cost and latency for the debug page. */
  debug?: { aiLog: AiCallLog; budget: BudgetGuard } | undefined;
}

export function createApp(service: SessionService, { webOrigin, debug }: AppOptions = {}) {
  const app = express();
  app.disable('x-powered-by');
  // Requests here are tiny (a name, a rule). A small cap stops oversized payloads early.
  app.use(express.json({ limit: '10kb' }));
  if (webOrigin) app.use(cors(webOrigin));

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  /** Host creates a session. The response holds the host's rejoin token. */
  app.post('/api/sessions', async (req, res) => {
    const input = CreateSessionRequestSchema.parse(req.body);
    res.status(201).json(await service.create(input));
  });

  /** What the join screen shows before someone picks a name. */
  app.get('/api/sessions/:code', async (req, res) => {
    res.json(await service.preview(parseCode(req.params.code)));
  });

  /** A guest joins with a display name. */
  app.post('/api/sessions/:code/members', async (req, res) => {
    const code = parseCode(req.params.code);
    const { name } = JoinSessionRequestSchema.parse(req.body);
    res.status(201).json(await service.join(code, name));
  });

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

  app.use(errorHandler);
  return app;
}

/** A malformed code can't exist, so it's reported as "not found", not "bad request". */
function parseCode(raw: string | undefined): string {
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
