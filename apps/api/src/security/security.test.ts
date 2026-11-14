import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { io as connect, type Socket } from 'socket.io-client';
import type {
  AckResult,
  ClientToServerEvents,
  Membership,
  ServerToClientEvents,
} from '@yumanimous/shared';
import { ConfigError, loadConfig } from '../config.js';
import { createServer } from '../createServer.js';
import { clientIp, DEFAULT_LIMITS, TokenBucket, WindowCounter, type Limits } from './limits.js';

type Client = Socket<ServerToClientEvents, ClientToServerEvents>;

describe('limit primitives', () => {
  it('a token bucket allows a burst, then the refill rate', () => {
    let t = 0;
    const bucket = new TokenBucket(3, 1, () => t);
    expect([bucket.take(), bucket.take(), bucket.take(), bucket.take()]).toEqual([
      true,
      true,
      true,
      false,
    ]);
    t = 1000;
    expect(bucket.take()).toBe(true);
    expect(bucket.take()).toBe(false);
  });

  it('a window counter caps hits per key and resets with the window', () => {
    let t = 0;
    const counter = new WindowCounter(2, 1000, () => t);
    expect([counter.take('a'), counter.take('a'), counter.take('a')]).toEqual([true, true, false]);
    expect(counter.take('b')).toBe(true);
    t = 1000;
    expect(counter.take('a')).toBe(true);
  });

  it('takes the client IP from the trusted end of X-Forwarded-For only', () => {
    // A client can put anything on the left; Fly appends the real address on the right.
    expect(clientIp('6.6.6.6, 1.2.3.4', '10.0.0.1', 1)).toBe('1.2.3.4');
    expect(clientIp('1.2.3.4', '10.0.0.1', 1)).toBe('1.2.3.4');
    // No trusted proxy: the header is ignored entirely.
    expect(clientIp('6.6.6.6', '10.0.0.1', 0)).toBe('10.0.0.1');
  });
});

describe('production config guard', () => {
  const good = {
    NODE_ENV: 'production',
    PUBLIC_ORIGIN: 'https://yumanimous.fly.dev',
    DATABASE_URL: 'postgres://app:pw@db.neon.tech/app?sslmode=verify-full',
    DATABASE_READER_URL: 'postgres://reader:pw@db.neon.tech/app?sslmode=verify-full',
    ANTHROPIC_API_KEY: 'test-key',
    WEB_STATIC_DIR: '/app/web',
  };

  it('accepts a safe production config, with limits and a daily AI cap always on', () => {
    const config = loadConfig(good);
    expect(config.limits).toEqual(DEFAULT_LIMITS);
    expect(config.trustedProxies).toBe(1);
    expect(config.runMigrations).toBe(false);
    expect(config.debugRoutes).toBe(false);
    expect(config.ai?.dailyBudgetUsd).toBe(0.5);
  });

  it.each([
    ['DEBUG_ROUTES on', { DEBUG_ROUTES: 'true' }, 'DEBUG_ROUTES must be false'],
    ['AI_TRACE on', { AI_TRACE: 'true' }, 'AI_TRACE must be false'],
    ['no public origin', { PUBLIC_ORIGIN: undefined }, 'PUBLIC_ORIGIN is required'],
    ['http origin', { PUBLIC_ORIGIN: 'http://yumanimous.fly.dev' }, 'https origin'],
    ['origin with a path', { PUBLIC_ORIGIN: 'https://x.dev/app' }, 'https origin'],
    [
      'TLS without verification',
      { DATABASE_URL: 'postgres://a:b@db/app?sslmode=require' },
      'DATABASE_URL must use sslmode=verify-full',
    ],
    ['no reader role with AI on', { DATABASE_READER_URL: undefined }, 'DATABASE_READER_URL'],
    ['no web app', { WEB_STATIC_DIR: undefined }, 'WEB_STATIC_DIR is required'],
  ])('refuses to start with %s', (_name, change, message) => {
    expect(() => loadConfig({ ...good, ...change })).toThrow(ConfigError);
    expect(() => loadConfig({ ...good, ...change })).toThrow(message);
  });

  it('lists every problem at once', () => {
    try {
      loadConfig({ NODE_ENV: 'production', DEBUG_ROUTES: 'true' });
      expect.unreachable();
    } catch (err) {
      expect((err as ConfigError).problems.length).toBeGreaterThanOrEqual(4);
    }
  });

  it('leaves limits off in development unless asked', () => {
    expect(loadConfig({}).limits).toBeUndefined();
    expect(loadConfig({ RATE_LIMITS: 'true' }).limits).toEqual(DEFAULT_LIMITS);
  });
});

describe('the deployed server', () => {
  const ORIGIN = 'https://yumanimous.test';
  let server: Awaited<ReturnType<typeof createServer>> | undefined;
  const clients: Client[] = [];

  afterEach(async () => {
    for (const c of clients.splice(0)) c.disconnect();
    await server?.close();
    server = undefined;
  });

  function webDir() {
    const dir = mkdtempSync(path.join(tmpdir(), 'yum-web-'));
    writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>Yumanimous</title>');
    mkdirSync(path.join(dir, 'assets'));
    writeFileSync(path.join(dir, 'assets', 'app-abc123.js'), 'console.log(1)');
    return dir;
  }

  async function start(limits: Partial<Limits> = {}) {
    server = await createServer({
      port: 0,
      limits: { ...DEFAULT_LIMITS, ...limits },
      trustedProxies: 1,
      publicOrigin: ORIGIN,
      staticDir: webDir(),
      deckSource: {
        mode: 'cook-in',
        buildDeck: async () => [{ id: 'soup', title: 'Soup', tags: [], blurb: 'Warm.' }],
      },
    });
    return server;
  }

  /** As if through Fly: the edge appends the client's address to X-Forwarded-For. */
  const fromIp = (ip: string) => ({ 'X-Forwarded-For': ip });

  async function createSession(ip = '1.1.1.1') {
    return fetch(`${server!.url}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...fromIp(ip) },
      body: JSON.stringify({ hostName: 'Vy' }),
    });
  }

  it('sends strict security headers on every response', async () => {
    await start();
    for (const route of ['/', '/api/sessions/ABCDEF', '/health']) {
      const res = await fetch(`${server!.url}${route}`);
      const csp = res.headers.get('content-security-policy') ?? '';
      expect(csp, route).toContain("default-src 'self'");
      expect(csp).toContain("script-src 'self'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("object-src 'none'");
      expect(csp).toContain("connect-src 'self' wss://yumanimous.test");
      expect(csp).toContain('https://img.spoonacular.com');
      expect(csp).not.toContain('unsafe-inline');
      expect(csp).not.toContain('unsafe-eval');
      expect(res.headers.get('strict-transport-security')).toContain('max-age=31536000');
      expect(res.headers.get('referrer-policy')).toBe('no-referrer');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('x-powered-by')).toBeNull();
    }
  });

  it('serves the web app: routes get index.html uncached, hashed assets cached for a year', async () => {
    await start();
    const page = await fetch(`${server!.url}/s/ABCDEF`);
    expect(await page.text()).toContain('<title>Yumanimous</title>');
    expect(page.headers.get('cache-control')).toBe('no-cache');

    const asset = await fetch(`${server!.url}/assets/app-abc123.js`);
    expect(asset.headers.get('cache-control')).toContain('immutable');
    expect((await fetch(`${server!.url}/assets/missing.js`)).status).toBe(404);

    // API routes never fall back to the page, and debug routes don't exist.
    const api = await fetch(`${server!.url}/api/debug/ai`);
    expect(api.status).toBe(404);
    expect(await api.json()).toMatchObject({ error: 'not_found' });
  });

  it('never serves files outside the web app folder', async () => {
    await start();
    for (const probe of [
      '/../package.json',
      '/assets/../../package.json',
      '/%2e%2e/package.json',
    ]) {
      const res = await fetch(`${server!.url}${probe}`);
      expect(await res.text()).not.toContain('"workspaces"');
    }
  });

  it('limits session creation per client, keyed on the address the proxy saw', async () => {
    await start({ createPerHour: 2 });
    expect((await createSession('1.1.1.1')).status).toBe(201);
    // Forging extra addresses on the left doesn't make it a different client.
    expect((await createSession('6.6.6.6, 1.1.1.1')).status).toBe(201);
    const third = await createSession('7.7.7.7, 1.1.1.1');
    expect(third.status).toBe(429);
    expect(await third.json()).toMatchObject({ error: 'rate_limited' });
    // Someone else is unaffected.
    expect((await createSession('2.2.2.2')).status).toBe(201);
  });

  it('limits session previews (no guessing codes)', async () => {
    await start({ previewPerMin: 3 });
    const statuses = [];
    for (let i = 0; i < 4; i++) {
      const res = await fetch(`${server!.url}/api/sessions/ABCDEF`, { headers: fromIp('3.3.3.3') });
      statuses.push(res.status);
    }
    expect(statuses).toEqual([404, 404, 404, 429]);
  });

  it('refuses new sessions politely when too many are active', async () => {
    await start({ maxActiveSessions: 1 });
    expect((await createSession()).status).toBe(201);
    const busy = await createSession('4.4.4.4');
    expect(busy.status).toBe(503);
    expect(await busy.json()).toMatchObject({ error: 'busy' });
  });

  describe('sockets', () => {
    async function member(ip = '5.5.5.5') {
      const res = await createSession(ip);
      return (await res.json()) as Membership;
    }

    function open(m: Membership, headers: Record<string, string>) {
      const client: Client = connect(server!.url, {
        auth: { code: m.code, token: m.token },
        transports: ['websocket'],
        reconnection: false,
        forceNew: true,
        extraHeaders: headers,
      });
      clients.push(client);
      return new Promise<Client>((resolve, reject) => {
        client.once('connect', () => resolve(client));
        client.once('connect_error', reject);
      });
    }

    it('refuses a socket opened from another site', async () => {
      await start();
      const m = await member();
      await expect(open(m, { Origin: 'https://evil.example' })).rejects.toThrow();
      await expect(open(m, { Origin: ORIGIN })).resolves.toBeTruthy();
    });

    it('limits new connections per client', async () => {
      await start({ connectPerMin: 2 });
      const m = await member();
      await open(m, { Origin: ORIGIN, ...fromIp('8.8.8.8') });
      await open(m, { Origin: ORIGIN, ...fromIp('8.8.8.8') });
      await expect(open(m, { Origin: ORIGIN, ...fromIp('8.8.8.8') })).rejects.toThrow(
        'rate_limited',
      );
    });

    it('throttles a flood of swipes, and costly actions per client', async () => {
      await start({ swipeBurst: 2, swipesPerSecond: 0.001, costlyPerHour: 1 });
      const m = await member('9.9.9.9');
      const client = await open(m, { Origin: ORIGIN, ...fromIp('9.9.9.9') });

      expect(await client.emitWithAck('session:start')).toEqual({ ok: true });
      const swipe = () =>
        client.emitWithAck('swipe', { cardId: 'soup', direction: 'like' }) as Promise<AckResult>;
      expect(await swipe()).toEqual({ ok: true });
      expect(await swipe()).toEqual({ ok: true }); // A repeat swipe is ignored, still allowed.
      expect(await swipe()).toEqual({ ok: false, error: 'Slow down a little and try again.' });

      // A second costly action within the hour is refused, even from a new socket.
      const again = await open(m, { Origin: ORIGIN, ...fromIp('9.9.9.9') });
      expect(await again.emitWithAck('session:rebuild')).toMatchObject({
        ok: false,
        error: expect.stringContaining('in the last hour'),
      });
    });
  });
});

describe('agent runtime environment', () => {
  it('passes the Anthropic key, never database URLs or other secrets', async () => {
    const { agentEnv } = await import('../ai/agentRun.js');
    const env = agentEnv({
      ANTHROPIC_API_KEY: 'a',
      PATH: '/bin',
      HOME: '/tmp',
      DATABASE_URL: 'postgres://app:pw@db/app',
      DATABASE_READER_URL: 'postgres://reader:pw@db/app',
      DATABASE_OWNER_URL: 'postgres://owner:pw@db/app',
      SPOONACULAR_API_KEY: 's',
    });
    expect(env).toEqual({ ANTHROPIC_API_KEY: 'a', PATH: '/bin', HOME: '/tmp' });
  });
});
