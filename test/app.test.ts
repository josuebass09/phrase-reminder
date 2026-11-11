import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { createAccessToken } from '../src/auth.js';
import {
  addPhrase,
  listRecent,
  listSubscriptions,
  listUsers,
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
    expect(body.user).toEqual({ id: alice.id, email: 'alice@example.com', isAdmin: true });
    expect(body.expiresIn).toBe(12 * 3600);
    // Token times are whole seconds, so the expiry can fall up to a second before now + 12 hours.
    const expiresAt = new Date(body.expiresAt).getTime();
    expect(expiresAt).toBeGreaterThan(before + 12 * 3600_000 - 1000);
    expect(expiresAt).toBeLessThanOrEqual(after + 12 * 3600_000);

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
    expect(counts).toEqual({ translations: { used: 0, limit: 30 }, suggestions: { used: 2, limit: 2 } });
    expect((await ask(target, alice, { text: 'uno' })).status).toBe(200);
  });

  it('does not limit the admin, but still counts', async () => {
    const target = appWith(async () => OPTIONS, 1);

    for (const text of ['uno', 'dos']) expect((await ask(target, alice, { text })).status).toBe(200);

    expect(await usage(target, alice)).toEqual({ used: 2, limit: null });
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

  it('creates a regular account and logs it in for 12 hours', async () => {
    const response = await signup({ email: '  Carol@Example.com ', password: PASSWORD_FOR_NEW, code: await invite() });
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.user).toEqual({ id: expect.any(Number), email: 'carol@example.com', isAdmin: false });
    expect(body.expiresIn).toBe(12 * 3600);
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
