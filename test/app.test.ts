import { sign } from 'hono/jwt';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { createAccessToken, hashRefreshToken } from '../src/auth.js';
import {
  addPhrase,
  listRecent,
  recordAiUse,
  recordCronRun,
  reserveDailyUse,
  saveSubscription,
  listSubscriptions,
  listUsers,
  markShown,
  MAX_PHRASE_LENGTH,
  type Db,
  type User,
} from '../src/db.js';
import { hashPassword } from '../src/passwords.js';
import { localClock } from '../src/schedule.js';
import { MAX_RECORDING_BYTES, NoAudioError, NoSpeechError, type Pronouncer, type Pronunciation } from '../src/pronounce.js';
import { clearTables, createTestDb, insertAged, insertUser, openSession } from './helpers.js';

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

/** Logs the user in on a new session, as logging in does, without the slow password check. */
async function bearer(user: User): Promise<string> {
  const { sessionId } = await openSession(db, user.id);
  return `Bearer ${(await createAccessToken(SECRET, user.id, sessionId)).token}`;
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
  it('returns an hour-long access token, its expiry, a refresh token, and the user', async () => {
    const before = Date.now();
    const response = await login({ email: 'alice@example.com', password: PASSWORD });
    const after = Date.now();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.user).toEqual({ id: alice.id, email: 'alice@example.com', isAdmin: true });
    expect(body.expiresIn).toBe(3600);
    expect(body.refreshToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // Token times are whole seconds, so the expiry can fall up to a second before now + an hour.
    const expiresAt = new Date(body.expiresAt).getTime();
    expect(expiresAt).toBeGreaterThan(before + 3600_000 - 1000);
    expect(expiresAt).toBeLessThanOrEqual(after + 3600_000);

    const me = await app.request('/api/me', { headers: { Authorization: `Bearer ${body.token}` } });
    expect(await me.json()).toEqual({ id: alice.id, email: 'alice@example.com', isAdmin: true });
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
  it('stop working after an hour', async () => {
    const authorization = await bearer(alice);
    // Only Date is faked, and only after the session is open: the in-process database
    // relies on real timers, and keeps its own clock for the session's end.
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 59 * 60_000 });
    expect((await app.request('/api/me', { headers: { Authorization: authorization } })).status).toBe(200);
    vi.setSystemTime(Date.now() + 2 * 60_000);
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
    const { sessionId } = await openSession(db, alice.id);
    const { token } = await createAccessToken('another-secret-that-is-also-long-enough', alice.id, sessionId);

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

describe('sessions', () => {
  async function logIn() {
    return (await login({ email: 'alice@example.com', password: PASSWORD })).json();
  }

  const refresh = (refreshToken: unknown) =>
    app.request('/api/session/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });

  const me = (token: string) => app.request('/api/me', { headers: { Authorization: `Bearer ${token}` } });

  const endOf = async (refreshToken: string) =>
    new Date(
      (await db.query('SELECT expires_at FROM sessions WHERE token_hash = $1', [hashRefreshToken(refreshToken)])).rows[0]
        .expires_at,
    ).getTime();

  it('renew with the refresh token, which gets a new pair and stops working itself', async () => {
    const first = await logIn();

    const response = await refresh(first.refreshToken);
    const second = await response.json();

    expect(response.status).toBe(200);
    expect(second.user).toEqual({ id: alice.id, email: 'alice@example.com', isAdmin: true });
    expect(second.expiresIn).toBe(3600);
    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect((await me(second.token)).status).toBe(200);
    expect((await me(first.token)).status).toBe(200); // The same session, until its hour is up.
    expect((await refresh(first.refreshToken)).status).toBe(401);
    expect((await refresh(second.refreshToken)).status).toBe(200);
  });

  it('last 60 days from their last renewal', async () => {
    const { refreshToken } = await logIn();
    await db.query("UPDATE sessions SET expires_at = now() + interval '1 day'");

    const renewed = await (await refresh(refreshToken)).json();

    const end = await endOf(renewed.refreshToken);
    expect(end).toBeGreaterThan(Date.now() + 59 * 86_400_000);
    expect(end).toBeLessThanOrEqual(Date.now() + 60 * 86_400_000 + 1000);
  });

  it('end once 60 days pass without a renewal, access token included', async () => {
    const { token, refreshToken } = await logIn();
    await db.query("UPDATE sessions SET expires_at = now() - interval '1 second'");

    expect((await refresh(refreshToken)).status).toBe(401);
    expect((await me(token)).status).toBe(401);
  });

  it('end on logging out, access token included, and logging out needs only the refresh token', async () => {
    const { token, refreshToken } = await logIn();
    const other = await logIn();

    const response = await app.request('/api/logout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });

    expect(response.status).toBe(204);
    expect((await me(token)).status).toBe(401);
    expect((await refresh(refreshToken)).status).toBe(401);
    expect((await me(other.token)).status).toBe(200); // Another device stays logged in.
  });

  it.each([
    ['an unknown token', JSON.stringify({ refreshToken: 'nope' })],
    ['no token', '{}'],
    ['invalid JSON', 'not json'],
  ])('log out fine with %s', async (_name, body) => {
    const response = await app.request('/api/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });

    expect(response.status).toBe(204);
  });

  it.each([['an unknown token', 'nope'], ['no token', undefined], ['a number', 42]])(
    'refuse to renew with %s',
    async (_name, refreshToken) => {
      const response = await refresh(refreshToken);

      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'Not logged in' });
    },
  );

  it('end when a replaced refresh token comes back over a minute later, as a stolen copy would', async () => {
    const first = await logIn();
    const second = await (await refresh(first.refreshToken)).json();
    await db.query("UPDATE sessions SET rotated_at = now() - interval '2 minutes'");

    expect((await refresh(first.refreshToken)).status).toBe(401);

    expect((await refresh(second.refreshToken)).status).toBe(401);
    expect((await me(second.token)).status).toBe(401);
  });

  it('stay open when a replaced refresh token comes back within the minute, as from two windows at once', async () => {
    const first = await logIn();
    const second = await (await refresh(first.refreshToken)).json();

    expect((await refresh(first.refreshToken)).status).toBe(401);

    expect((await refresh(second.refreshToken)).status).toBe(200);
  });

  it('all end for the user, and only them, on DELETE /api/sessions', async () => {
    const phone = await logIn();
    const laptop = await logIn();
    const bobs = await bearer(bob);

    const response = await app.request('/api/sessions', { method: 'DELETE', headers: { Authorization: `Bearer ${phone.token}` } });

    expect(response.status).toBe(204);
    expect((await me(phone.token)).status).toBe(401);
    expect((await me(laptop.token)).status).toBe(401);
    expect((await refresh(laptop.refreshToken)).status).toBe(401);
    expect((await app.request('/api/me', { headers: { Authorization: bobs } })).status).toBe(200);
  });

  it('accept access tokens from before sessions until they expire', async () => {
    const old = await sign({ sub: String(alice.id), iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 60 }, SECRET, 'HS256');

    expect((await me(old)).status).toBe(200);
  });
});

describe('GET /api/me', () => {
  it('returns the logged-in user without the password hash', async () => {
    const response = await requestAs(bob, '/api/me');

    expect(await response.json()).toEqual({ id: bob.id, email: 'bob@example.com', isAdmin: false });
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

  it('saves a translation sent with the phrase, so translating it later is free', async () => {
    const translate = vi.fn(async () => 'should not be called');
    const target = createApp({ db, tokenSecret: SECRET, vapidPublicKey: 'k', translate });
    const response = await requestAs(alice, '/api/phrases', {
      method: 'POST',
      body: JSON.stringify({ text: 'Could you take a look?', translation: ' ¿Podrías revisarlo? ' }),
    });
    const { id } = await response.json();

    const translation = await target.request(`/api/phrases/${id}/translation`, { headers: { Authorization: await bearer(alice) } });

    expect(response.status).toBe(201);
    expect(await translation.json()).toEqual({ translation: '¿Podrías revisarlo?' });
    expect(translate).not.toHaveBeenCalled();
  });

  it.each([
    ['a non-string translation', { text: 'Hello.', translation: 42 }],
    ['a translation over the limit', { text: 'Hello.', translation: 'x'.repeat(1001) }],
  ])('rejects %s and saves nothing', async (_name, body) => {
    const response = await requestAs(alice, '/api/phrases', { method: 'POST', body: JSON.stringify(body) });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Translation must be text of up to 1000 characters' });
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
    expect(phrases[0]).toEqual({
      id: expect.any(Number),
      text: 'newer',
      createdAt: expect.any(String),
      translation: null,
      lastScore: null,
    });
  });
});

describe('GET /api/phrases, searching and paging', () => {
  const texts = async (query: string) => textOf(await (await requestAs(alice, `/api/phrases${query}`)).json());

  it("gives each phrase's Spanish, once someone asked for it", async () => {
    const phrase = await addPhrase(db, alice.id, 'It slipped my mind.', 'Se me olvidó.');

    const [listed] = await (await requestAs(alice, '/api/phrases')).json();

    expect(listed).toMatchObject({ id: phrase.id, translation: 'Se me olvidó.' });
  });

  it('finds phrases by their text or Spanish, ignoring case, and only the user’s', async () => {
    await addPhrase(db, alice.id, 'It slipped my mind.', 'Se me olvidó.');
    await addPhrase(db, alice.id, "I'll keep you posted.");
    await addPhrase(db, alice.id, 'Mind the gap.');
    await addPhrase(db, bob.id, 'Never mind.');

    expect(await texts('?q=MIND')).toEqual(['Mind the gap.', 'It slipped my mind.']);
    expect(await texts('?q=olvid')).toEqual(['It slipped my mind.']);
    expect(await texts('?q=%20%20')).toHaveLength(3); // Blank means no search.
  });

  it('takes % and _ in a search literally', async () => {
    await addPhrase(db, alice.id, '100% sure');
    await addPhrase(db, alice.id, '100 percent sure');
    await addPhrase(db, alice.id, 'snake_case');

    expect(await texts('?q=100%25')).toEqual(['100% sure']);
    expect(await texts('?q=e_c')).toEqual(['snake_case']);
  });

  it('gives the next 50 after a phrase, so all of them can be reached', async () => {
    for (let i = 0; i < 52; i++) await insertAged(db, alice.id, `phrase ${i}`, 60 - i);

    const first = await (await requestAs(alice, '/api/phrases')).json();
    const next = await (await requestAs(alice, `/api/phrases?before=${first.at(-1).id}`)).json();

    expect(first).toHaveLength(50);
    expect(textOf(first).slice(0, 2)).toEqual(['phrase 51', 'phrase 50']);
    expect(textOf(next)).toEqual(['phrase 1', 'phrase 0']);
  });

  it.each([
    ['a search over 100 characters', `?q=${'x'.repeat(101)}`],
    ['a before that is not an id', '?before=abc'],
  ])('rejects %s', async (_name, query) => {
    expect((await requestAs(alice, `/api/phrases${query}`)).status).toBe(400);
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
      translation: null,
      lastScore: null,
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
    const [phrase] = await listRecent(db, user.id, { limit: 1 });
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

describe('/api/phrases/:id/review', () => {
  async function sendPhrase(user: User, text: string) {
    await insertAged(db, user.id, text, 20);
    const [phrase] = await listRecent(db, user.id, { limit: 1 });
    await markShown(db, [phrase.id]);
    return phrase.id;
  }
  const review = (user: User, id: number, as: unknown) =>
    requestAs(user, `/api/phrases/${id}/review`, { method: 'POST', body: JSON.stringify({ as }) });
  const todayOf = async (user: User) => textOf(await (await requestAs(user, '/api/today')).json());
  const answers = async (id: number) =>
    (await db.query('SELECT kind FROM activity WHERE phrase_id = $1 ORDER BY kind', [id])).rows.map((row) => row.kind);

  it("takes a phrase off Today once it's reviewed, keeping whether it was read or remembered", async () => {
    const id = await sendPhrase(alice, 'It slipped my mind.');
    await sendPhrase(alice, 'Keep me posted.');

    expect((await review(alice, id, 'remembered')).status).toBe(204);

    expect(await todayOf(alice)).toEqual(['Keep me posted.']);
    expect(await answers(id)).toEqual(['phrase_remembered']);
    expect(textOf(await listRecent(db, alice.id))).toContain('It slipped my mind.'); // Only off Today.
  });

  it('keeps one answer a day per phrase: the latest', async () => {
    const id = await sendPhrase(alice, 'It slipped my mind.');

    await review(alice, id, 'remembered');
    await review(alice, id, 'read');

    expect(await answers(id)).toEqual(['phrase_read']);
  });

  it('puts the phrase back on Today, and forgets the answer, when undone', async () => {
    const id = await sendPhrase(alice, 'It slipped my mind.');
    await review(alice, id, 'read');

    const response = await requestAs(alice, `/api/phrases/${id}/review`, { method: 'DELETE' });

    expect(response.status).toBe(204);
    expect(await todayOf(alice)).toEqual(['It slipped my mind.']);
    expect(await answers(id)).toEqual([]);
  });

  it('brings a reviewed phrase back when a later reminder sends it again', async () => {
    const id = await sendPhrase(alice, 'It slipped my mind.');
    await review(alice, id, 'remembered');
    await db.query("UPDATE phrases SET reviewed_at = now() - interval '1 day'"); // Reviewed yesterday.

    await markShown(db, [id]);

    expect(await todayOf(alice)).toEqual(['It slipped my mind.']);
  });

  it.each(['seen', 'constructor', undefined])('refuses %s as an answer', async (as) => {
    const id = await sendPhrase(alice, 'It slipped my mind.');

    expect((await review(alice, id, as)).status).toBe(400);
    expect(await todayOf(alice)).toEqual(['It slipped my mind.']);
  });

  it("answers 404 for another user's phrase, both ways", async () => {
    const id = await sendPhrase(bob, "Bob's phrase.");

    expect((await review(alice, id, 'read')).status).toBe(404);
    expect((await requestAs(alice, `/api/phrases/${id}/review`, { method: 'DELETE' })).status).toBe(404);
    expect(await todayOf(bob)).toEqual(["Bob's phrase."]);
  });
});

describe('GET /api/phrases/:id/translation', () => {
  function appWith(translate?: (text: string) => Promise<string>) {
    return createApp({ db, tokenSecret: SECRET, vapidPublicKey: 'k', translate });
  }

  async function ask(target: ReturnType<typeof createApp>, user: User | null, id: number | string) {
    const headers: Record<string, string> = user ? { Authorization: await bearer(user) } : {};
    return target.request(`/api/phrases/${id}/translation`, { headers });
  }

  it('translates the phrase once and then serves the saved translation', async () => {
    const translate = vi.fn(async (text: string) => `es: ${text}`);
    const target = appWith(translate);
    const phrase = await addPhrase(db, alice.id, "I'll keep you posted.");

    const first = await ask(target, alice, phrase.id);
    const second = await ask(target, alice, phrase.id);

    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ translation: "es: I'll keep you posted." });
    expect(await second.json()).toEqual({ translation: "es: I'll keep you posted." });
    expect(translate).toHaveBeenCalledTimes(1);
  });

  it('translates again after the phrase is edited', async () => {
    const translate = vi.fn(async (text: string) => `es: ${text}`);
    const target = appWith(translate);
    const phrase = await addPhrase(db, alice.id, 'It slipt my mind.');
    await ask(target, alice, phrase.id);

    await requestAs(alice, `/api/phrases/${phrase.id}`, { method: 'PATCH', body: JSON.stringify({ text: 'It slipped my mind.' }) });
    const response = await ask(target, alice, phrase.id);

    expect(await response.json()).toEqual({ translation: 'es: It slipped my mind.' });
    expect(translate).toHaveBeenCalledTimes(2);
  });

  it("returns 404 for another user's phrase, a missing one, or a bad id, without translating", async () => {
    const translate = vi.fn(async () => 'nope');
    const target = appWith(translate);
    const phrase = await addPhrase(db, alice.id, 'mine');

    const statuses = [
      (await ask(target, bob, phrase.id)).status,
      (await ask(target, alice, 999)).status,
      (await ask(target, alice, 'abc')).status,
    ];

    expect(statuses).toEqual([404, 404, 404]);
    expect(translate).not.toHaveBeenCalled();
  });

  it('requires a token', async () => {
    const phrase = await addPhrase(db, alice.id, 'mine');

    expect((await ask(appWith(async () => 'x'), null, phrase.id)).status).toBe(401);
  });

  it('answers 502 and saves nothing when the translation service fails', async () => {
    const translate = vi.fn().mockRejectedValueOnce(new Error('quota')).mockResolvedValueOnce('Hola.');
    const target = appWith(translate);
    const phrase = await addPhrase(db, alice.id, 'Hello.');
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});

    const failed = await ask(target, alice, phrase.id);
    const retried = await ask(target, alice, phrase.id);
    quiet.mockRestore();

    expect(failed.status).toBe(502);
    expect(await failed.json()).toEqual({ error: "Couldn't translate right now" });
    expect(await retried.json()).toEqual({ translation: 'Hola.' });
  });

  describe('daily limit', () => {
    const limited = (translate = vi.fn(async (text: string) => `es: ${text}`)) =>
      createApp({ db, tokenSecret: SECRET, vapidPublicKey: 'k', translate, translationsPerDay: 2 });
    const usage = async (target: ReturnType<typeof createApp>, user: User) =>
      (await (await target.request('/api/usage', { headers: { Authorization: await bearer(user) } })).json()).translations;

    it('allows each user that many new translations a day, then answers 429', async () => {
      const target = limited();
      const [one, two, three] = [await addPhrase(db, bob.id, 'one'), await addPhrase(db, bob.id, 'two'), await addPhrase(db, bob.id, 'three')];

      const statuses = [(await ask(target, bob, one.id)).status, (await ask(target, bob, two.id)).status];
      const third = await ask(target, bob, three.id);

      expect(statuses).toEqual([200, 200]);
      expect(third.status).toBe(429);
      expect(await third.json()).toEqual({ error: "You've used today's 2 translations. More tomorrow." });
      expect(await usage(target, bob)).toEqual({ used: 2, limit: 2 });
    });

    it('keeps serving saved translations once the limit is reached', async () => {
      const target = limited();
      const one = await addPhrase(db, bob.id, 'one');
      await ask(target, bob, one.id);
      await ask(target, bob, (await addPhrase(db, bob.id, 'two')).id);

      const again = await ask(target, bob, one.id);

      expect(again.status).toBe(200);
      expect(await again.json()).toEqual({ translation: 'es: one' });
    });

    it('does not count a translation that failed', async () => {
      const translate = vi.fn().mockRejectedValueOnce(new Error('down')).mockResolvedValue('uno');
      const target = limited(translate);
      const one = await addPhrase(db, bob.id, 'one');
      const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});

      await ask(target, bob, one.id);
      quiet.mockRestore();

      expect(await usage(target, bob)).toEqual({ used: 0, limit: 2 });
    });

    it('starts over on the user\'s next day', async () => {
      const target = limited();
      await ask(target, bob, (await addPhrase(db, bob.id, 'one')).id);
      await ask(target, bob, (await addPhrase(db, bob.id, 'two')).id);
      await db.query("UPDATE users SET translations_day = '2000-01-01' WHERE id = $1", [bob.id]); // As if that was yesterday.

      expect((await ask(target, bob, (await addPhrase(db, bob.id, 'three')).id)).status).toBe(200);
      expect(await usage(target, bob)).toEqual({ used: 1, limit: 2 });
    });

    it('does not limit the admin, but still counts', async () => {
      const target = limited();
      for (const text of ['one', 'two', 'three']) {
        expect((await ask(target, alice, (await addPhrase(db, alice.id, text)).id)).status).toBe(200);
      }

      expect(await usage(target, alice)).toEqual({ used: 3, limit: null });
    });

    it('defaults to 30 a day', async () => {
      expect(await usage(appWith(async () => 'x'), bob)).toEqual({ used: 0, limit: 30 });
    });
  });

  it('answers 503 when no translator is set up', async () => {
    const phrase = await addPhrase(db, alice.id, 'Hello.');

    expect((await ask(appWith(), alice, phrase.id)).status).toBe(503);
  });
});

describe('POST /api/suggestions', () => {
  const OPTIONS = {
    formal: { text: 'Could you please take a look?' },
    informal: { text: 'Can you take a look?' },
  };

  function appWith(suggest?: (text: string) => Promise<typeof OPTIONS>, suggestionsPerDay?: number) {
    return createApp({ db, tokenSecret: SECRET, vapidPublicKey: 'k', suggest, suggestionsPerDay });
  }

  async function ask(target: ReturnType<typeof createApp>, user: User | null, body: unknown) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (user) headers.Authorization = await bearer(user);
    const payload = typeof body === 'string' ? body : JSON.stringify(body);
    return target.request('/api/suggestions', { method: 'POST', headers, body: payload });
  }

  const usage = async (target: ReturnType<typeof createApp>, user: User) =>
    (await (await target.request('/api/usage', { headers: { Authorization: await bearer(user) } })).json()).suggestions;

  it('gives a formal and an informal option for the trimmed text, and saves no phrase', async () => {
    const suggest = vi.fn(async () => OPTIONS);

    const response = await ask(appWith(suggest), bob, { text: '  ¿Puedes revisarlo?  ' });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(OPTIONS);
    expect(suggest).toHaveBeenCalledWith('¿Puedes revisarlo?', undefined);
    expect(await listRecent(db, bob.id)).toEqual([]);
  });

  it('passes the trimmed context to the AI, and none when it is blank', async () => {
    const suggest = vi.fn(async () => OPTIONS);
    const target = appWith(suggest);

    await ask(target, bob, { text: 'Hola', context: '  Email to a client  ' });
    await ask(target, bob, { text: 'Hola', context: '   ' });
    await ask(target, bob, { text: 'Hola', context: null });

    expect(suggest.mock.calls).toEqual([
      ['Hola', 'Email to a client'],
      ['Hola', undefined],
      ['Hola', undefined],
    ]);
  });

  it.each([
    ['a non-string context', { text: 'Hola', context: 42 }],
    ['a context over the limit', { text: 'Hola', context: 'x'.repeat(301) }],
  ])('rejects %s without asking the AI', async (_name, body) => {
    const suggest = vi.fn(async () => OPTIONS);

    const response = await ask(appWith(suggest), bob, body);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Context must be text of up to 300 characters' });
    expect(suggest).not.toHaveBeenCalled();
  });

  it.each([
    ['blank text', { text: '  ' }],
    ['text over the limit', { text: 'x'.repeat(MAX_PHRASE_LENGTH + 1) }],
    ['invalid JSON', 'not json'],
  ])('rejects %s without asking the AI or counting it', async (_name, body) => {
    const suggest = vi.fn(async () => OPTIONS);
    const target = appWith(suggest);

    expect((await ask(target, bob, body)).status).toBe(400);
    expect(suggest).not.toHaveBeenCalled();
    expect(await usage(target, bob)).toEqual({ used: 0, limit: 20 });
  });

  it('requires a token', async () => {
    expect((await ask(appWith(async () => OPTIONS), null, { text: 'Hola' })).status).toBe(401);
  });

  it('answers 503 when no AI is set up', async () => {
    const response = await ask(appWith(), bob, { text: 'Hola' });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Suggestions aren't available right now" });
  });

  it('answers 502 and does not count it when the AI fails', async () => {
    const target = appWith(vi.fn().mockRejectedValue(new Error('Groq answered HTTP 500')));
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await ask(target, bob, { text: 'Hola' });
    quiet.mockRestore();

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "Couldn't get an answer right now. Try again." });
    expect(await usage(target, bob)).toEqual({ used: 0, limit: 20 });
  });

  it('allows each user that many a day, then answers 429, apart from translations', async () => {
    const target = appWith(async () => OPTIONS, 2);

    const statuses = [(await ask(target, bob, { text: 'uno' })).status, (await ask(target, bob, { text: 'dos' })).status];
    const third = await ask(target, bob, { text: 'tres' });
    const counts = await (await target.request('/api/usage', { headers: { Authorization: await bearer(bob) } })).json();

    expect(statuses).toEqual([200, 200]);
    expect(third.status).toBe(429);
    expect(await third.json()).toEqual({ error: "You've used today's 2 suggestions. More tomorrow." });
    expect(counts).toEqual({
      translations: { used: 0, limit: 30 },
      suggestions: { used: 2, limit: 2 },
      pronunciations: { used: 0, limit: 20 },
    });
    expect((await ask(target, alice, { text: 'uno' })).status).toBe(200);
  });

  it('does not limit the admin, but still counts', async () => {
    const target = appWith(async () => OPTIONS, 1);

    for (const text of ['uno', 'dos']) expect((await ask(target, alice, { text })).status).toBe(200);

    expect(await usage(target, alice)).toEqual({ used: 2, limit: null });
  });
});

describe('POST /api/phrases/:id/pronunciation', () => {
  const RESULT: Pronunciation = {
    score: 8,
    words: [
      { text: 'It', ok: true },
      { text: 'slipped', ok: false },
      { text: 'my', ok: true },
      { text: 'mind.', ok: true },
    ],
    heard: 'It slept my mind.',
    tip: 'Say "slipped" with a short "i", as in "sit".',
  };

  function appWith(pronounce?: Pronouncer, pronunciationsPerDay?: number) {
    return createApp({ db, tokenSecret: SECRET, vapidPublicKey: 'k', pronounce, pronunciationsPerDay });
  }

  async function speak(
    target: ReturnType<typeof createApp>,
    user: User | null,
    id: number | string,
    { type = 'audio/webm;codecs=opus', body = 'fake audio' as BodyInit, language }: { type?: string; body?: BodyInit; language?: string } = {},
  ) {
    const headers: Record<string, string> = { 'Content-Type': type };
    if (user) headers.Authorization = await bearer(user);
    if (language) headers['Accept-Language'] = language;
    return target.request(`/api/phrases/${id}/pronunciation`, { method: 'POST', headers, body });
  }

  const usage = async (target: ReturnType<typeof createApp>, user: User) =>
    (await (await target.request('/api/usage', { headers: { Authorization: await bearer(user) } })).json()).pronunciations;

  const lastScore = async (user: User) => (await listRecent(db, user.id))[0].lastScore;

  it('scores the recording, passes on the audio and the language, and saves the score with the phrase', async () => {
    const phrase = await addPhrase(db, bob.id, 'It slipped my mind.');
    const pronounce = vi.fn(async () => RESULT);
    const target = appWith(pronounce);

    const response = await speak(target, bob, phrase.id, { language: 'es-CR,es;q=0.9' });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(RESULT);
    expect(pronounce).toHaveBeenCalledWith('It slipped my mind.', { bytes: expect.any(ArrayBuffer), type: 'audio/webm' }, 'es');
    const [, recording] = pronounce.mock.calls[0] as unknown as Parameters<Pronouncer>;
    expect(new TextDecoder().decode(recording.bytes)).toBe('fake audio');
    expect(await lastScore(bob)).toBe(8);
    expect(await usage(target, bob)).toEqual({ used: 1, limit: 20 });
    const { rows } = await db.query('SELECT kind, phrase_id AS "phraseId" FROM activity WHERE user_id = $1', [bob.id]);
    expect(rows).toEqual([{ kind: 'phrase_scored', phraseId: phrase.id }]);
  });

  it('keeps the score when the text stays the same, and drops it when the text changes', async () => {
    const phrase = await addPhrase(db, bob.id, 'It slipped my mind.');
    await speak(appWith(async () => RESULT), bob, phrase.id);
    const edit = (text: string) => requestAs(bob, `/api/phrases/${phrase.id}`, { method: 'PATCH', body: JSON.stringify({ text }) });

    expect(await (await edit('It slipped my mind.')).json()).toMatchObject({ lastScore: 8 });
    expect(await (await edit('It totally slipped my mind.')).json()).toMatchObject({ lastScore: null });
  });

  it.each([
    ["another user's phrase", async () => (await addPhrase(db, alice.id, 'Hello')).id],
    ['a missing phrase', async () => 999],
    ['an id that cannot exist', async () => 'abc'],
  ])('answers 404 for %s without scoring or counting it', async (_name, idOf) => {
    const pronounce = vi.fn(async () => RESULT);
    const target = appWith(pronounce);

    const response = await speak(target, bob, await idOf());

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Phrase not found' });
    expect(pronounce).not.toHaveBeenCalled();
    expect(await usage(target, bob)).toEqual({ used: 0, limit: 20 });
  });

  it.each([
    ['JSON', { type: 'application/json', body: '{"text":"hi"}' }],
    ['audio Groq cannot read', { type: 'audio/aiff' }],
    ['an empty recording', { body: '' }],
  ])('rejects %s without scoring or counting it', async (_name, options) => {
    const phrase = await addPhrase(db, bob.id, 'Hello');
    const pronounce = vi.fn(async () => RESULT);
    const target = appWith(pronounce);

    const response = await speak(target, bob, phrase.id, options);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Send the recording as audio' });
    expect(pronounce).not.toHaveBeenCalled();
    expect(await usage(target, bob)).toEqual({ used: 0, limit: 20 });
  });

  it('answers 413 for a recording over the size limit', async () => {
    const phrase = await addPhrase(db, bob.id, 'Hello');
    const pronounce = vi.fn(async () => RESULT);

    const response = await speak(appWith(pronounce), bob, phrase.id, { body: new Uint8Array(MAX_RECORDING_BYTES + 1) });

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: 'The recording is too long. Say just the phrase.' });
    expect(pronounce).not.toHaveBeenCalled();
  });

  it('requires a token', async () => {
    const phrase = await addPhrase(db, bob.id, 'Hello');

    expect((await speak(appWith(async () => RESULT), null, phrase.id)).status).toBe(401);
  });

  it('answers 503 when no scoring is set up', async () => {
    const phrase = await addPhrase(db, bob.id, 'Hello');

    const response = await speak(appWith(), bob, phrase.id);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Pronunciation scores aren't available right now" });
  });

  it('answers 422 for a recording with nobody speaking, and does not count it or save a score', async () => {
    const phrase = await addPhrase(db, bob.id, 'Hello');
    const target = appWith(vi.fn().mockRejectedValue(new NoSpeechError()));

    const response = await speak(target, bob, phrase.id, { language: 'es' });

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: 'No te escuché. Acércate al micrófono e inténtalo de nuevo.' });
    expect(await usage(target, bob)).toEqual({ used: 0, limit: 20 });
    expect(await lastScore(bob)).toBeNull();
  });

  it('answers 422 for a recording with no sound, says to reload, and does not count it', async () => {
    const phrase = await addPhrase(db, bob.id, 'Hello');
    const target = appWith(vi.fn().mockRejectedValue(new NoAudioError()));
    const quiet = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const response = await speak(target, bob, phrase.id, { language: 'es' });

    expect(response.status).toBe(422);
    expect((await response.json()).error).toContain('recarga la página');
    expect(quiet).toHaveBeenCalledWith(expect.stringMatching(/^Recording without audio: audio\/\S+, \d+ bytes$/));
    quiet.mockRestore();
    expect(await usage(target, bob)).toEqual({ used: 0, limit: 20 });
    expect(await lastScore(bob)).toBeNull();
  });

  it('answers 502 and does not count it when scoring fails', async () => {
    const phrase = await addPhrase(db, bob.id, 'Hello');
    const target = appWith(vi.fn().mockRejectedValue(new Error('Groq answered HTTP 500')));
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await speak(target, bob, phrase.id);
    quiet.mockRestore();

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "Couldn't score it right now. Try again." });
    expect(await usage(target, bob)).toEqual({ used: 0, limit: 20 });
  });

  it('allows each user that many a day, then answers 429, but does not limit the admin', async () => {
    const target = appWith(async () => RESULT, 1);
    const bobs = await addPhrase(db, bob.id, 'Hello');
    const alices = await addPhrase(db, alice.id, 'Hello');

    expect((await speak(target, bob, bobs.id)).status).toBe(200);
    const second = await speak(target, bob, bobs.id);
    for (let i = 0; i < 2; i++) expect((await speak(target, alice, alices.id)).status).toBe(200);

    expect(second.status).toBe(429);
    expect(await second.json()).toEqual({ error: "You've used today's 1 pronunciation scores. More tomorrow." });
    expect(await usage(target, alice)).toEqual({ used: 2, limit: null });
  });
});

describe('POST /api/activity', () => {
  const report = (user: User | null, body: unknown) =>
    requestAs(user, '/api/activity', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) });

  const activity = async (user: User) =>
    (
      await db.query('SELECT day, kind, phrase_id AS "phraseId" FROM activity WHERE user_id = $1 ORDER BY kind, phrase_id', [
        user.id,
      ])
    ).rows;

  it("records each kind once on the user's local day, and each phrase kind once per phrase", async () => {
    await requestAs(bob, '/api/settings', { method: 'PATCH', body: JSON.stringify({ timeZone: 'Pacific/Kiritimati' }) });
    const first = await addPhrase(db, bob.id, 'one');
    const second = await addPhrase(db, bob.id, 'two');

    const statuses = [];
    for (const body of [
      { kind: 'today_viewed' },
      { kind: 'today_viewed' },
      { kind: 'reminder_opened' },
      { kind: 'phrase_heard', phraseId: first.id },
      { kind: 'phrase_heard', phraseId: first.id },
      { kind: 'phrase_heard', phraseId: second.id },
      { kind: 'phrase_translated', phraseId: first.id },
    ]) {
      statuses.push((await report(bob, body)).status);
    }

    expect(statuses).toEqual([204, 204, 204, 204, 204, 204, 204]);
    const day = localClock(new Date(), 'Pacific/Kiritimati').day;
    expect(await activity(bob)).toEqual([
      { day, kind: 'phrase_heard', phraseId: first.id },
      { day, kind: 'phrase_heard', phraseId: second.id },
      { day, kind: 'phrase_translated', phraseId: first.id },
      { day, kind: 'reminder_opened', phraseId: null },
      { day, kind: 'today_viewed', phraseId: null },
    ]);
  });

  it.each([
    ['an unknown kind', { kind: 'reminder_sent' }, 400],
    ['no kind', {}, 400],
    ['invalid JSON', 'not json', 400],
    ['a phrase with a kind that has none', { kind: 'today_viewed', phraseId: 1 }, 400],
    ['a phrase kind without a phrase', { kind: 'phrase_heard' }, 404],
    ['a phrase id that is a string', { kind: 'phrase_heard', phraseId: '1' }, 404],
    ['a missing phrase', { kind: 'phrase_heard', phraseId: 999 }, 404],
  ])('refuses %s and records nothing', async (_name, body, status) => {
    await addPhrase(db, bob.id, 'one');

    expect((await report(bob, body)).status).toBe(status);
    expect(await activity(bob)).toEqual([]);
  });

  it("refuses another user's phrase", async () => {
    const theirs = await addPhrase(db, alice.id, 'theirs');

    expect((await report(bob, { kind: 'phrase_heard', phraseId: theirs.id })).status).toBe(404);
    expect(await activity(bob)).toEqual([]);
  });

  it('requires a token', async () => {
    expect((await report(null, { kind: 'today_viewed' })).status).toBe(401);
  });
});

describe('messages for people', () => {
  it('come in the language the app asks for, and in English otherwise', async () => {
    const signup = (language?: string) =>
      app.request('/api/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(language ? { 'Accept-Language': language } : {}) },
        body: JSON.stringify({ email: 'new@example.com', password: 'a long enough password', code: 'nope' }),
      });

    expect(await (await signup('es')).json()).toEqual({ error: 'Esta invitación no es válida, ya se usó o venció' });
    expect(await (await signup('es-CR,es;q=0.9,en;q=0.8')).json()).toEqual({
      error: 'Esta invitación no es válida, ya se usó o venció',
    });
    expect(await (await signup('fr-FR,en;q=0.5')).json()).toEqual({
      error: 'This invite is not valid, was already used, or has expired',
    });
    expect(await (await signup()).json()).toEqual({ error: 'This invite is not valid, was already used, or has expired' });
  });

  it("say today's limit in Spanish", async () => {
    const target = createApp({
      db,
      tokenSecret: SECRET,
      vapidPublicKey: 'k',
      suggest: async () => ({ formal: { text: 'a' }, informal: { text: 'b' } }),
      suggestionsPerDay: 1,
    });
    const ask = async () =>
      target.request('/api/suggestions', {
        method: 'POST',
        headers: { Authorization: await bearer(bob), 'Content-Type': 'application/json', 'Accept-Language': 'es' },
        body: JSON.stringify({ text: 'Hola' }),
      });

    await ask();
    const limited = await ask();

    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: 'Ya usaste las 1 sugerencias de hoy. Mañana tendrás más.' });
  });
});

describe('GET /api/usage', () => {
  it('requires a token', async () => {
    expect((await requestAs(null, '/api/usage')).status).toBe(401);
  });

  it('starts every user at zero, with the default limits', async () => {
    expect(await (await requestAs(bob, '/api/usage')).json()).toEqual({
      translations: { used: 0, limit: 30 },
      suggestions: { used: 0, limit: 20 },
      pronunciations: { used: 0, limit: 20 },
    });
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

describe('/api/settings', () => {
  const patch = (user: User | null, body: unknown) =>
    requestAs(user, '/api/settings', { method: 'PATCH', body: typeof body === 'string' ? body : JSON.stringify(body) });

  it('returns the defaults for a new user', async () => {
    const response = await requestAs(alice, '/api/settings');

    expect(await response.json()).toEqual({
      remindersOn: true,
      reminderTime: '12:00',
      timeZone: 'America/Costa_Rica',
      phrasesPerDay: 3,
      language: null,
    });
  });

  it('changes only the settings sent, for that user only', async () => {
    const response = await patch(alice, { reminderTime: '08:30', timeZone: 'Europe/Madrid' });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      remindersOn: true,
      reminderTime: '08:30',
      timeZone: 'Europe/Madrid',
      phrasesPerDay: 3,
      language: null,
    });
    await patch(alice, { remindersOn: false, phrasesPerDay: 5 });
    expect(await (await requestAs(alice, '/api/settings')).json()).toMatchObject({
      remindersOn: false,
      reminderTime: '08:30',
      phrasesPerDay: 5,
    });
    expect((await (await requestAs(bob, '/api/settings')).json()).reminderTime).toBe('12:00');
  });

  it.each([
    ['a time in the wrong format', { reminderTime: '8:30 PM' }, 'reminderTime must be a 24-hour time such as 08:30'],
    ['an unknown time zone', { timeZone: 'Mars/Olympus_Mons' }, 'timeZone must be a time zone such as America/Costa_Rica'],
    ['too many phrases', { phrasesPerDay: 6 }, 'phrasesPerDay must be a whole number from 1 to 5'],
    ['a fraction of a phrase', { phrasesPerDay: 2.5 }, 'phrasesPerDay must be a whole number from 1 to 5'],
    ['a non-boolean switch', { remindersOn: 'yes' }, 'remindersOn must be true or false'],
    ['an unknown language', { language: 'fr' }, 'language must be en or es'],
    ['nothing to change', { color: 'blue' }, 'Nothing to change'],
    ['invalid JSON', 'not json', 'Send the settings to change as a JSON object'],
  ])('rejects %s and changes nothing', async (_name, body, error) => {
    const response = await patch(alice, body);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error });
    expect((await (await requestAs(alice, '/api/settings')).json()).reminderTime).toBe('12:00');
  });

  it("saves the app's language", async () => {
    const response = await patch(alice, { language: 'es' });

    expect((await response.json()).language).toBe('es');
    expect((await (await requestAs(alice, '/api/settings')).json()).language).toBe('es');
  });

  it('requires a token', async () => {
    expect((await requestAs(null, '/api/settings')).status).toBe(401);
    expect((await patch(null, { phrasesPerDay: 1 })).status).toBe(401);
  });
});

describe('POST /api/invites', () => {
  it('gives the admin a single-use code that lasts 7 days, and stores only its hash', async () => {
    const before = Date.now();
    const response = await requestAs(alice, '/api/invites', { method: 'POST' });
    const { code, expiresAt } = await response.json();

    expect(response.status).toBe(201);
    expect(code).toMatch(/^[\w-]{22}$/);
    const lifetime = new Date(expiresAt).getTime() - before;
    expect(Math.round(lifetime / 3600_000)).toBe(7 * 24);
    const { rows } = await db.query('SELECT code_hash, created_by FROM invites');
    expect(rows).toEqual([{ code_hash: expect.any(String), created_by: alice.id }]);
    expect(rows[0].code_hash).not.toBe(code);
  });

  it('gives a different code each time', async () => {
    const first = await (await requestAs(alice, '/api/invites', { method: 'POST' })).json();
    const second = await (await requestAs(alice, '/api/invites', { method: 'POST' })).json();

    expect(first.code).not.toBe(second.code);
  });

  it('is only for the admin', async () => {
    const response = await requestAs(bob, '/api/invites', { method: 'POST' });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Only the admin can invite people' });
  });

  it('requires a token', async () => {
    expect((await requestAs(null, '/api/invites', { method: 'POST' })).status).toBe(401);
  });
});

describe('POST /api/signup', () => {
  const PASSWORD_FOR_NEW = 'a long enough password';
  const UNUSABLE = { error: 'This invite is not valid, was already used, or has expired' };

  async function invite(): Promise<string> {
    const { code } = await (await requestAs(alice, '/api/invites', { method: 'POST' })).json();
    return code;
  }

  function signup(body: unknown) {
    return app.request('/api/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  }

  const emails = async () => (await listUsers(db)).map((user) => user.email);

  it('creates a regular account and logs it in, with a session to renew', async () => {
    const response = await signup({ email: '  Carol@Example.com ', password: PASSWORD_FOR_NEW, code: await invite() });
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.user).toEqual({ id: expect.any(Number), email: 'carol@example.com', isAdmin: false });
    expect(body.refreshToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.expiresIn).toBe(3600);
    const me = await app.request('/api/me', { headers: { Authorization: `Bearer ${body.token}` } });
    expect(await me.json()).toEqual(body.user);
    expect((await login({ email: 'carol@example.com', password: PASSWORD_FOR_NEW })).status).toBe(200);
  });

  it('records who used the invite', async () => {
    const response = await signup({ email: 'carol@example.com', password: PASSWORD_FOR_NEW, code: await invite() });
    const { user } = await response.json();

    const { rows } = await db.query('SELECT used_by, used_at FROM invites');
    expect(rows).toEqual([{ used_by: user.id, used_at: expect.any(Date) }]);
  });

  it('accepts each invite only once', async () => {
    const code = await invite();
    await signup({ email: 'carol@example.com', password: PASSWORD_FOR_NEW, code });

    const response = await signup({ email: 'dave@example.com', password: PASSWORD_FOR_NEW, code });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual(UNUSABLE);
    expect(await emails()).not.toContain('dave@example.com');
  });

  it('refuses an expired invite', async () => {
    const code = await invite();
    await db.query("UPDATE invites SET expires_at = now() - interval '1 second'");

    const response = await signup({ email: 'carol@example.com', password: PASSWORD_FOR_NEW, code });

    expect(response.status).toBe(403);
    expect(await emails()).not.toContain('carol@example.com');
  });

  it('refuses a made-up code before saying anything about the email', async () => {
    const madeUp = await signup({ email: 'carol@example.com', password: PASSWORD_FOR_NEW, code: 'made-up-code' });
    const taken = await signup({ email: 'alice@example.com', password: PASSWORD_FOR_NEW, code: 'made-up-code' });

    expect([madeUp.status, taken.status]).toEqual([403, 403]);
    expect(await taken.json()).toEqual(UNUSABLE);
    expect(await emails()).not.toContain('carol@example.com');
  });

  it('refuses an email that already has an account, and keeps the invite usable', async () => {
    const code = await invite();

    const response = await signup({ email: 'ALICE@example.com', password: PASSWORD_FOR_NEW, code });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'An account with that email already exists' });
    expect((await signup({ email: 'carol@example.com', password: PASSWORD_FOR_NEW, code })).status).toBe(201);
  });

  it.each([
    ['an invalid email', { email: 'carol', password: PASSWORD_FOR_NEW }, 'Enter a valid email'],
    ['a short password', { email: 'carol@example.com', password: 'too short' }, 'Use at least 12 characters for the password'],
    ['a long password', { email: 'carol@example.com', password: 'x'.repeat(201) }, 'Use at most 200 characters for the password'],
  ])('rejects %s and keeps the invite usable', async (_name, account, error) => {
    const code = await invite();

    const response = await signup({ ...account, code });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error });
    expect((await signup({ email: 'carol@example.com', password: PASSWORD_FOR_NEW, code })).status).toBe(201);
  });

  it.each([
    ['a missing code', { email: 'carol@example.com', password: PASSWORD_FOR_NEW }],
    ['invalid JSON', 'not json'],
  ])('rejects %s', async (_name, body) => {
    const response = await signup(body);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Email, password, and invite code are required' });
  });
});

describe('admin', () => {
  const ADMIN_ROUTES = [
    ['GET', '/api/admin/ai'],
    ['GET', '/api/admin/users'],
    ['GET', '/api/admin/system'],
    ['DELETE', '/api/admin/users/2/sessions'],
  ] as const;

  it.each(ADMIN_ROUTES)('%s %s is only for the admin', async (method, path) => {
    expect((await requestAs(null, path, { method })).status).toBe(401);
    const refused = await requestAs(bob, path, { method });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: 'Only the admin can see this' });
  });

  it("gives each service's requests for the last 30 UTC days, what Groq said is left, and the users' limits", async () => {
    const now = new Date();
    const yesterday = new Date(now.getTime() - 86_400_000);
    await recordAiUse(db, { service: 'groq_chat', ok: true, rateLimited: false, units: 400, quota: { limit: 1000, left: 990 } });
    await recordAiUse(db, { service: 'groq_chat', ok: false, rateLimited: true, units: 0 });
    await recordAiUse(db, { service: 'mymemory', ok: true, rateLimited: false, units: 20 }, yesterday);
    await addPhrase(db, bob.id, 'Hello there'); // 11 characters.
    await addPhrase(db, bob.id, 'Hi'); // 2.

    const response = await requestAs(alice, '/api/admin/ai');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.history).toHaveLength(30);
    expect(body.history.at(-1)).toEqual({
      day: now.toISOString().slice(0, 10),
      groq_chat: { calls: 2, failures: 1, rateLimited: 1, units: 400 },
      groq_speech: { calls: 0, failures: 0, rateLimited: 0, units: 0 },
      mymemory: { calls: 0, failures: 0, rateLimited: 0, units: 0 },
    });
    expect(body.history.at(-2).mymemory).toEqual({ calls: 1, failures: 0, rateLimited: 0, units: 20 });
    expect(body.quotas).toEqual({ groq_chat: { limit: 1000, left: 990, checkedAt: expect.any(String) }, groq_speech: null });
    expect(body).toMatchObject({
      mymemoryCharsPerDay: 5000,
      available: { groq: false, mymemory: false },
      perUserPerDay: { suggestions: 20, translations: 30, pronunciations: 20 },
      limitedUsers: 1, // Bob; Alice is the admin.
      averagePhraseLength: 7,
    });
  });

  it('lists every user with their activity, devices, sessions, and what they used today', async () => {
    const { timeZone } = (await (await requestAs(bob, '/api/settings')).json()) as { timeZone: string };
    const today = localClock(new Date(), timeZone).day;
    await addPhrase(db, bob.id, 'Hello');
    await saveSubscription(db, bob.id, { endpoint: 'https://push.example/bob', p256dh: 'key', auth: 'auth' });
    await reserveDailyUse(db, bob.id, 'suggestions', today, 20);
    await reserveDailyUse(db, bob.id, 'suggestions', today, 20);
    await reserveDailyUse(db, bob.id, 'translations', '2000-01-01', 30); // Another day: not today's.

    const users = await (await requestAs(alice, '/api/admin/users')).json();

    expect(users.map((user: { email: string; isAdmin: boolean }) => [user.email, user.isAdmin])).toEqual([
      ['alice@example.com', true],
      ['bob@example.com', false],
    ]);
    expect(users[1]).toMatchObject({
      id: bob.id,
      phrases: 1,
      devices: 1,
      sessions: 1, // From asking for the settings above.
      remindersOn: true,
      today: { suggestions: 2, translations: 0, pronunciations: 0 },
    });
    expect(new Date(users[1].lastActiveAt).getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(new Date(users[1].createdAt).getTime()).toBeGreaterThan(0);
  });

  it("logs a user out of every device, keeping their phrases, but not the admin, who uses Settings", async () => {
    const bobsToken = await bearer(bob);
    await addPhrase(db, bob.id, 'Hello');

    const response = await requestAs(alice, `/api/admin/users/${bob.id}/sessions`, { method: 'DELETE' });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ended: 1 });
    expect((await app.request('/api/phrases', { headers: { Authorization: bobsToken } })).status).toBe(401);
    expect(textOf(await listRecent(db, bob.id))).toEqual(['Hello']);

    const own = await requestAs(alice, `/api/admin/users/${alice.id}/sessions`, { method: 'DELETE' });
    expect(own.status).toBe(400);
    expect((await requestAs(alice, '/api/admin/users/999/sessions', { method: 'DELETE' })).status).toBe(404);
  });

  it("gives the cron's last runs and deliveries, the database's size, and the deployed versions", async () => {
    const versioned = createApp({ db, tokenSecret: SECRET, vapidPublicKey: 'test-public-key', version: 'abc1234' });
    const now = Date.now();
    const run = { users: 1, devices: 2, delivered: 2, removed: 0, errors: 0, firstError: null, version: 'def5678' };
    await recordCronRun(db, { ...run, startedAt: new Date(now - 3 * 3600_000), finishedAt: new Date(now - 3 * 3600_000 + 900) });
    await recordCronRun(db, {
      ...run,
      delivered: 1,
      removed: 1,
      errors: 1,
      firstError: 'Push service down',
      startedAt: new Date(now - 15 * 60_000),
      finishedAt: new Date(now - 15 * 60_000 + 900),
    });

    const response = await versioned.request('/api/admin/system', { headers: { Authorization: await bearer(alice) } });
    const { cron, database, versions, reminders } = await response.json();

    expect(response.status).toBe(200);
    expect(new Date(cron.lastRunAt).getTime()).toBe(now - 15 * 60_000);
    expect(cron).toMatchObject({ runsLastDay: 2, failedRunsLastDay: 1, removedLastWeek: 1 });
    expect(cron.lastError).toEqual({ at: expect.any(String), message: 'Push service down' });
    expect(cron.deliveries).toHaveLength(7);
    expect(cron.deliveries.reduce((sum: number, day: { delivered: number }) => sum + day.delivered, 0)).toBe(3);
    expect(database.bytes).toBeGreaterThan(0);
    expect(database.tables.map((table: { name: string }) => table.name)).toContain('phrases');
    expect(versions).toEqual({ api: 'abc1234', cron: 'def5678' });
    expect(reminders).toEqual({ usersOn: 0, devices: 0 });
  });
});
