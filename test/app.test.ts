import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { createAccessToken } from '../src/auth.js';
import {
  addPhrase,
  listRecent,
  listSubscriptions,
  markShown,
  MAX_PHRASE_LENGTH,
  type Db,
  type User,
} from '../src/db.js';
import { hashPassword } from '../src/passwords.js';
import { clearTables, createTestDb, insertAged, insertUser } from './helpers.js';

const PASSWORD = 'correct horse battery staple';
const SECRET = 'test-secret-that-is-long-enough-for-hs256';

let db: Db;
let app: ReturnType<typeof createApp>;
let passwordHash: string;
let alice: User;
let bob: User;

function login(body: unknown) {
  return app.request('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function bearer(user: User): Promise<string> {
  return `Bearer ${(await createAccessToken(SECRET, user.id)).token}`;
}

/** Sends a request as a user, or with no Authorization header for null. */
async function requestAs(user: User | null, path: string, init: { method?: string; body?: string } = {}) {
  const headers: Record<string, string> = {};
  if (user) headers.Authorization = await bearer(user);
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  return app.request(path, { method: init.method ?? 'GET', headers, body: init.body });
}

const textOf = (phrases: { text: string }[]) => phrases.map((p) => p.text);

beforeAll(async () => {
  db = await createTestDb();
  passwordHash = await hashPassword(PASSWORD);
  app = createApp({ db, tokenSecret: SECRET, vapidPublicKey: 'test-public-key' });
});

beforeEach(async () => {
  await clearTables(db);
  alice = await insertUser(db, 'alice@example.com', passwordHash);
  bob = await insertUser(db, 'bob@example.com', passwordHash);
});

afterEach(() => vi.useRealTimers());

describe('POST /api/login', () => {
  it('returns a 12-hour access token, its expiry, and the user', async () => {
    const before = Date.now();
    const response = await login({ email: 'alice@example.com', password: PASSWORD });
    const after = Date.now();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.user).toEqual({ id: alice.id, email: 'alice@example.com' });
    expect(body.expiresIn).toBe(12 * 3600);
    // Token times are whole seconds, so the expiry can fall up to a second before now + 12 hours.
    const expiresAt = new Date(body.expiresAt).getTime();
    expect(expiresAt).toBeGreaterThan(before + 12 * 3600_000 - 1000);
    expect(expiresAt).toBeLessThanOrEqual(after + 12 * 3600_000);

    const me = await app.request('/api/me', { headers: { Authorization: `Bearer ${body.token}` } });
    expect(await me.json()).toEqual({ id: alice.id, email: 'alice@example.com' });
  });

  it('ignores case and spaces around the email', async () => {
    const response = await login({ email: '  Alice@Example.COM ', password: PASSWORD });

    expect(response.status).toBe(200);
  });

  it.each([
    ['a wrong password', { email: 'alice@example.com', password: 'wrong password' }],
    ['an unknown email', { email: 'nobody@example.com', password: PASSWORD }],
    ['a password over the limit', { email: 'alice@example.com', password: 'x'.repeat(201) }],
  ])('rejects %s with the same message', async (_name, body) => {
    const response = await login(body);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Wrong email or password' });
  });

  it.each([
    ['a missing email', { password: PASSWORD }],
    ['a missing password', { email: 'alice@example.com' }],
    ['a non-string password', { email: 'alice@example.com', password: 42 }],
    ['invalid JSON', 'not json'],
  ])('rejects %s as a bad request', async (_name, body) => {
    const response = await login(body);

    expect(response.status).toBe(400);
    expect(await response.json()).not.toHaveProperty('token');
  });
});

describe('access tokens', () => {
  it('stop working after 12 hours', async () => {
    // Only Date is faked: the in-process database relies on real timers.
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-10T12:00:00Z') });
    const authorization = await bearer(alice);

    vi.setSystemTime(new Date('2026-11-10T23:59:00Z'));
    expect((await app.request('/api/me', { headers: { Authorization: authorization } })).status).toBe(200);
    vi.setSystemTime(new Date('2026-11-11T00:00:01Z'));
    expect((await app.request('/api/me', { headers: { Authorization: authorization } })).status).toBe(401);
  });

  it.each([
    ['no Authorization header', undefined],
    ['another scheme', 'Basic YWxpY2U6cGFzc3dvcmQ='],
    ['a forged token', 'Bearer forged'],
  ])('are required: %s gets a 401', async (_name, authorization) => {
    const response = await app.request('/api/me', { headers: authorization ? { Authorization: authorization } : {} });

    expect(response.status).toBe(401);
  });

  it('must be signed with this server’s secret', async () => {
    const { token } = await createAccessToken('another-secret-that-is-also-long-enough', alice.id);

    const response = await app.request('/api/me', { headers: { Authorization: `Bearer ${token}` } });

    expect(response.status).toBe(401);
  });

  it('stop working when their user is deleted', async () => {
    const authorization = await bearer(alice);
    await db.query('DELETE FROM users WHERE id = $1', [alice.id]);

    const response = await app.request('/api/phrases', { headers: { Authorization: authorization } });

    expect(response.status).toBe(401);
  });
});

describe('GET /api/me', () => {
  it('returns the logged-in user without the password hash', async () => {
    const response = await requestAs(bob, '/api/me');

    expect(await response.json()).toEqual({ id: bob.id, email: 'bob@example.com' });
  });
});

describe('POST /api/phrases', () => {
  it('rejects requests without a token and saves nothing', async () => {
    const response = await requestAs(null, '/api/phrases', { method: 'POST', body: JSON.stringify({ text: 'Hello' }) });

    expect(response.status).toBe(401);
    expect(await listRecent(db, alice.id)).toEqual([]);
  });

  it("saves the trimmed phrase for the user and returns it", async () => {
    const response = await requestAs(alice, '/api/phrases', {
      method: 'POST',
      body: JSON.stringify({ text: "  I'll keep you posted.  " }),
    });
    const phrase = await response.json();

    expect(response.status).toBe(201);
    expect(phrase.text).toBe("I'll keep you posted.");
    expect(new Date(phrase.createdAt).getTime()).not.toBeNaN();
    expect(textOf(await listRecent(db, alice.id))).toEqual(["I'll keep you posted."]);
    expect(await listRecent(db, bob.id)).toEqual([]);
  });

  it.each([
    ['blank text', JSON.stringify({ text: '   ' })],
    ['text over the limit', JSON.stringify({ text: 'x'.repeat(MAX_PHRASE_LENGTH + 1) })],
    ['a non-string value', JSON.stringify({ text: 42 })],
    ['invalid JSON', 'not json'],
  ])('rejects %s', async (_name, body) => {
    const response = await requestAs(alice, '/api/phrases', { method: 'POST', body });

    expect(response.status).toBe(400);
    expect(await listRecent(db, alice.id)).toEqual([]);
  });
});

describe('GET /api/phrases', () => {
  it('rejects requests without a token', async () => {
    expect((await requestAs(null, '/api/phrases')).status).toBe(401);
  });

  it("returns only the user's phrases, newest first", async () => {
    await insertAged(db, alice.id, 'older', 2);
    await insertAged(db, alice.id, 'newer', 1);
    await insertAged(db, bob.id, "bob's", 0);

    const phrases = await (await requestAs(alice, '/api/phrases')).json();

    expect(textOf(phrases)).toEqual(['newer', 'older']);
    expect(phrases[0]).toEqual({ id: expect.any(Number), text: 'newer', createdAt: expect.any(String) });
  });
});

describe('PATCH /api/phrases/:id', () => {
  const fix = JSON.stringify({ text: '  It slipped my mind.  ' });

  it('rejects requests without a token and changes nothing', async () => {
    const phrase = await addPhrase(db, alice.id, 'It slipt my mind.');

    const response = await requestAs(null, `/api/phrases/${phrase.id}`, { method: 'PATCH', body: fix });

    expect(response.status).toBe(401);
    expect(textOf(await listRecent(db, alice.id))).toEqual(['It slipt my mind.']);
  });

  it('saves the trimmed text and returns the phrase', async () => {
    const phrase = await addPhrase(db, alice.id, 'It slipt my mind.');

    const response = await requestAs(alice, `/api/phrases/${phrase.id}`, { method: 'PATCH', body: fix });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      id: phrase.id,
      text: 'It slipped my mind.',
      createdAt: phrase.createdAt.toISOString(),
    });
  });

  it("returns 404 for another user's phrase and leaves it alone", async () => {
    const phrase = await addPhrase(db, alice.id, 'It slipt my mind.');

    const response = await requestAs(bob, `/api/phrases/${phrase.id}`, { method: 'PATCH', body: fix });

    expect(response.status).toBe(404);
    expect(textOf(await listRecent(db, alice.id))).toEqual(['It slipt my mind.']);
  });

  it.each([
    ['blank text', JSON.stringify({ text: '   ' })],
    ['text over the limit', JSON.stringify({ text: 'x'.repeat(MAX_PHRASE_LENGTH + 1) })],
    ['a non-string value', JSON.stringify({ text: 42 })],
    ['invalid JSON', 'not json'],
  ])('rejects %s', async (_name, body) => {
    const phrase = await addPhrase(db, alice.id, 'It slipt my mind.');

    const response = await requestAs(alice, `/api/phrases/${phrase.id}`, { method: 'PATCH', body });

    expect(response.status).toBe(400);
    expect(textOf(await listRecent(db, alice.id))).toEqual(['It slipt my mind.']);
  });

  it.each([
    ['a missing phrase', '999'],
    ['a non-numeric id', 'abc'],
    ['an id beyond the integer range', '99999999999'],
  ])('returns 404 for %s', async (_name, id) => {
    const response = await requestAs(alice, `/api/phrases/${id}`, { method: 'PATCH', body: fix });

    expect(response.status).toBe(404);
  });
});

describe('DELETE /api/phrases/:id', () => {
  it('rejects requests without a token and deletes nothing', async () => {
    const phrase = await addPhrase(db, alice.id, 'keep me');

    const response = await requestAs(null, `/api/phrases/${phrase.id}`, { method: 'DELETE' });

    expect(response.status).toBe(401);
    expect(await listRecent(db, alice.id)).toHaveLength(1);
  });

  it('deletes the phrase', async () => {
    const phrase = await addPhrase(db, alice.id, 'remove me');

    const response = await requestAs(alice, `/api/phrases/${phrase.id}`, { method: 'DELETE' });

    expect(response.status).toBe(204);
    expect(await listRecent(db, alice.id)).toEqual([]);
  });

  it("returns 404 for another user's phrase and keeps it", async () => {
    const phrase = await addPhrase(db, alice.id, 'keep me');

    const response = await requestAs(bob, `/api/phrases/${phrase.id}`, { method: 'DELETE' });

    expect(response.status).toBe(404);
    expect(await listRecent(db, alice.id)).toHaveLength(1);
  });

  it.each([
    ['a missing phrase', '999'],
    ['a non-numeric id', 'abc'],
  ])('returns 404 for %s', async (_name, id) => {
    const response = await requestAs(alice, `/api/phrases/${id}`, { method: 'DELETE' });

    expect(response.status).toBe(404);
  });
});

describe('GET /api/today', () => {
  async function sendPhrase(user: User, text: string) {
    await insertAged(db, user.id, text, 20);
    const [phrase] = await listRecent(db, user.id, 1);
    await markShown(db, [phrase.id]);
  }

  it('rejects requests without a token', async () => {
    expect((await requestAs(null, '/api/today')).status).toBe(401);
  });

  it("returns the phrases from the user's latest reminder", async () => {
    await sendPhrase(alice, 'It slipped my mind.');
    await sendPhrase(bob, "Bob's phrase.");

    const response = await requestAs(alice, '/api/today');
    const phrases = await response.json();

    expect(response.status).toBe(200);
    expect(textOf(phrases)).toEqual(['It slipped my mind.']);
    expect(phrases[0].id).toEqual(expect.any(Number));
    expect(new Date(phrases[0].createdAt).getTime()).not.toBeNaN();
  });
});

describe('POST /api/push/subscribe', () => {
  const subscription = {
    endpoint: 'https://push.example/device',
    expirationTime: null,
    keys: { p256dh: 'public-key', auth: 'auth-secret' },
  };

  const subscribe = (user: User | null, body: string) =>
    requestAs(user, '/api/push/subscribe', { method: 'POST', body });

  it('rejects requests without a token and saves nothing', async () => {
    const response = await subscribe(null, JSON.stringify(subscription));

    expect(response.status).toBe(401);
    expect(await listSubscriptions(db, alice.id)).toEqual([]);
  });

  it("saves the browser's subscription for the user", async () => {
    const response = await subscribe(alice, JSON.stringify(subscription));

    expect(response.status).toBe(204);
    expect(await listSubscriptions(db, alice.id)).toEqual([
      { endpoint: subscription.endpoint, p256dh: 'public-key', auth: 'auth-secret' },
    ]);
  });

  it('moves the device to whoever subscribes it next', async () => {
    await subscribe(alice, JSON.stringify(subscription));
    await subscribe(bob, JSON.stringify(subscription));

    expect(await listSubscriptions(db, alice.id)).toEqual([]);
    expect(await listSubscriptions(db, bob.id)).toHaveLength(1);
  });

  it.each([
    ['a non-HTTPS endpoint', JSON.stringify({ ...subscription, endpoint: 'http://push.example/device' })],
    ['missing keys', JSON.stringify({ endpoint: subscription.endpoint })],
    ['empty keys', JSON.stringify({ ...subscription, keys: { p256dh: '', auth: '' } })],
    ['invalid JSON', 'not json'],
  ])('rejects %s', async (_name, body) => {
    const response = await subscribe(alice, body);

    expect(response.status).toBe(400);
    expect(await listSubscriptions(db, alice.id)).toEqual([]);
  });
});

describe('GET /api/config', () => {
  it('gives the public push key without a token', async () => {
    const response = await app.request('/api/config');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ vapidPublicKey: 'test-public-key' });
  });

  it('forbids the response from loading anything or being framed', async () => {
    const response = await app.request('/api/config');

    expect(response.headers.get('content-security-policy')).toBe("default-src 'none'; frame-ancestors 'none'");
  });
});

describe('CORS', () => {
  const APP_ORIGIN = 'https://app.example';

  function preflight(target: ReturnType<typeof createApp>, origin: string) {
    return target.request('/api/phrases', {
      method: 'OPTIONS',
      headers: {
        Origin: origin,
        'Access-Control-Request-Method': 'PATCH',
        'Access-Control-Request-Headers': 'authorization,content-type',
      },
    });
  }

  function appWithOrigins(appOrigins?: string[]) {
    return createApp({ db, tokenSecret: SECRET, vapidPublicKey: 'k', appOrigins });
  }

  it('lets the configured app origin call the API', async () => {
    const response = await preflight(appWithOrigins([APP_ORIGIN]), APP_ORIGIN);

    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe(APP_ORIGIN);
    expect(response.headers.get('access-control-allow-headers')?.toLowerCase()).toContain('authorization');
    expect(response.headers.get('access-control-allow-methods')).toContain('PATCH');
  });

  it('does not allow other origins', async () => {
    const response = await preflight(appWithOrigins([APP_ORIGIN]), 'https://evil.example');

    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('allows no origin when none is configured', async () => {
    const response = await preflight(appWithOrigins(), APP_ORIGIN);

    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });
});
