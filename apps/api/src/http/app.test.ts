import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { MembershipSchema } from '@yumanimous/shared';
import { staticRecipeDeck } from '../deck/deckSource.js';
import { SessionService } from '../sessions/sessionService.js';
import { InMemorySessionStore } from '../sessions/sessionStore.js';
import { createApp } from './app.js';

let app: ReturnType<typeof createApp>;

beforeEach(() => {
  const service = new SessionService({
    store: new InMemorySessionStore(),
    deckSource: staticRecipeDeck,
  });
  app = createApp(service, { webOrigin: 'https://yumanimous.example' });
});

const createSession = async (body: object = { hostName: 'Vy' }) =>
  (await request(app).post('/api/sessions').send(body).expect(201)).body;

describe('GET /health', () => {
  it('responds ok', async () => {
    await request(app).get('/health').expect(200, { ok: true });
  });
});

describe('POST /api/sessions', () => {
  it('creates a session and returns the host membership', async () => {
    const body = await createSession({ hostName: '  Vy  ', matchRule: 'majority' });
    expect(MembershipSchema.parse(body)).toEqual(body);
  });

  it('rejects an invalid name with a readable message', async () => {
    const res = await request(app).post('/api/sessions').send({ hostName: '' }).expect(400);
    expect(res.body).toEqual({ error: 'invalid_request', message: 'Pick a name' });
  });

  it('rejects malformed JSON', async () => {
    await request(app)
      .post('/api/sessions')
      .set('Content-Type', 'application/json')
      .send('{"hostName":')
      .expect(400);
  });

  it('rejects oversized bodies', async () => {
    await request(app)
      .post('/api/sessions')
      .send({ hostName: 'Vy', padding: 'x'.repeat(20_000) })
      .expect(413);
  });
});

describe('GET /api/sessions/:code', () => {
  it('returns a preview, accepting a lowercase code', async () => {
    const { code } = await createSession();
    const res = await request(app).get(`/api/sessions/${code.toLowerCase()}`).expect(200);
    expect(res.body).toMatchObject({ code, hostName: 'Vy', memberCount: 1, status: 'lobby' });
  });

  it('404s for an unknown or malformed code', async () => {
    await request(app).get('/api/sessions/ZZZZZZ').expect(404);
    await request(app).get('/api/sessions/nope!').expect(404);
  });
});

describe('POST /api/sessions/:code/members', () => {
  it('joins a guest', async () => {
    const { code } = await createSession();
    const res = await request(app)
      .post(`/api/sessions/${code}/members`)
      .send({ name: 'Sam' })
      .expect(201);
    expect(res.body).toMatchObject({ code, memberId: expect.any(String) });
  });

  it('409s on a taken name', async () => {
    const { code } = await createSession();
    const res = await request(app)
      .post(`/api/sessions/${code}/members`)
      .send({ name: 'VY' })
      .expect(409);
    expect(res.body.error).toBe('name_taken');
  });

  it('404s for an unknown session', async () => {
    await request(app).post('/api/sessions/ZZZZZZ/members').send({ name: 'Sam' }).expect(404);
  });
});

describe('unknown routes and CORS', () => {
  it('404s with JSON for unknown API routes', async () => {
    const res = await request(app).get('/api/nope').expect(404);
    expect(res.body.error).toBe('not_found');
  });

  it('allows only the configured web origin', async () => {
    const allowed = await request(app).get('/health').set('Origin', 'https://yumanimous.example');
    expect(allowed.headers['access-control-allow-origin']).toBe('https://yumanimous.example');

    const other = await request(app).get('/health').set('Origin', 'https://evil.example');
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
  });
});
