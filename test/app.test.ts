import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import {
  listRecent,
  listSubscriptions,
  markShown,
  MAX_PHRASE_LENGTH,
  type Db,
} from '../src/db.js';
import { clearTables, createTestDb, insertAged } from './helpers.js';

const PASSWORD = 'correct horse battery staple';

let db: Db;
let app: ReturnType<typeof createApp>;

function submitPassword(password: string, url = '/login') {
  return app.request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password }).toString(),
  });
}

async function logIn(): Promise<string> {
  const response = await submitPassword(PASSWORD);
  return response.headers.get('set-cookie')!.split(';')[0];
}

function postPhrase(body: string, cookie?: string) {
  return app.request('/api/phrases', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body,
  });
}

beforeAll(async () => {
  db = await createTestDb();
  app = createApp({
    db,
    password: PASSWORD,
    sessionSecret: 'test-secret',
    vapidPublicKey: 'test-public-key',
  });
});

beforeEach(() => clearTables(db));

describe('login', () => {
  it('sends visitors without a session to the login page', async () => {
    const response = await app.request('/');

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/login');
  });

  it('rejects a wrong password without setting a cookie', async () => {
    const response = await submitPassword('wrong');

    expect(response.status).toBe(401);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(await response.text()).toContain('Wrong password.');
  });

  it('sets a one-year, HttpOnly, secure cookie for the right password', async () => {
    const response = await submitPassword(PASSWORD, 'https://phrases.example/login');
    const cookie = response.headers.get('set-cookie')!;

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/');
    expect(cookie).toContain('Max-Age=31536000');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
  });

  it('accepts the session cookie on later requests', async () => {
    const response = await app.request('/', { headers: { Cookie: await logIn() } });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('id="phrase-form"');
  });

  it('rejects a forged session cookie', async () => {
    const response = await app.request('/', { headers: { Cookie: 'session=ok' } });

    expect(response.status).toBe(302);
  });
});

describe('POST /api/phrases', () => {
  it('rejects requests without a session and saves nothing', async () => {
    const response = await postPhrase(JSON.stringify({ text: 'Hello' }));

    expect(response.status).toBe(401);
    expect(await listRecent(db)).toEqual([]);
  });

  it('saves the trimmed phrase and returns it', async () => {
    const response = await postPhrase(JSON.stringify({ text: "  I'll keep you posted.  " }), await logIn());
    const phrase = await response.json();

    expect(response.status).toBe(201);
    expect(phrase.text).toBe("I'll keep you posted.");
    expect(new Date(phrase.createdAt).getTime()).not.toBeNaN();
    expect((await listRecent(db)).map((p) => p.text)).toEqual(["I'll keep you posted."]);
  });

  it.each([
    ['blank text', JSON.stringify({ text: '   ' })],
    ['text over the limit', JSON.stringify({ text: 'x'.repeat(MAX_PHRASE_LENGTH + 1) })],
    ['a non-string value', JSON.stringify({ text: 42 })],
    ['invalid JSON', 'not json'],
  ])('rejects %s', async (_name, body) => {
    const response = await postPhrase(body, await logIn());

    expect(response.status).toBe(400);
    expect(await listRecent(db)).toEqual([]);
  });
});

describe('POST /api/push/subscribe', () => {
  const subscription = {
    endpoint: 'https://push.example/device',
    expirationTime: null,
    keys: { p256dh: 'public-key', auth: 'auth-secret' },
  };

  function postSubscription(body: string, cookie?: string) {
    return app.request('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body,
    });
  }

  it('rejects requests without a session and saves nothing', async () => {
    const response = await postSubscription(JSON.stringify(subscription));

    expect(response.status).toBe(401);
    expect(await listSubscriptions(db)).toEqual([]);
  });

  it('saves a browser subscription', async () => {
    const response = await postSubscription(JSON.stringify(subscription), await logIn());

    expect(response.status).toBe(204);
    expect(await listSubscriptions(db)).toEqual([
      { endpoint: subscription.endpoint, p256dh: 'public-key', auth: 'auth-secret' },
    ]);
  });

  it.each([
    ['a non-HTTPS endpoint', JSON.stringify({ ...subscription, endpoint: 'http://push.example/device' })],
    ['missing keys', JSON.stringify({ endpoint: subscription.endpoint })],
    ['empty keys', JSON.stringify({ ...subscription, keys: { p256dh: '', auth: '' } })],
    ['invalid JSON', 'not json'],
  ])('rejects %s', async (_name, body) => {
    const response = await postSubscription(body, await logIn());

    expect(response.status).toBe(400);
    expect(await listSubscriptions(db)).toEqual([]);
  });
});

describe('Today', () => {
  async function sendPhrase(text: string) {
    await insertAged(db, text, 20);
    const [phrase] = await listRecent(db, 1);
    await markShown(db, [phrase.id]);
  }

  it('rejects GET /api/today without a session', async () => {
    const response = await app.request('/api/today');

    expect(response.status).toBe(401);
  });

  it('returns the phrases from the latest reminder', async () => {
    await sendPhrase('It slipped my mind.');

    const response = await app.request('/api/today', { headers: { Cookie: await logIn() } });
    const phrases = await response.json();

    expect(response.status).toBe(200);
    expect(phrases.map((p: { text: string }) => p.text)).toEqual(['It slipped my mind.']);
    expect(phrases[0].id).toEqual(expect.any(Number));
    expect(new Date(phrases[0].createdAt).getTime()).not.toBeNaN();
  });

  it('shows the section on the page when a reminder went out', async () => {
    await sendPhrase('It slipped my mind.');

    const html = await (await app.request('/', { headers: { Cookie: await logIn() } })).text();

    expect(html).toContain('<section id="today" class="group">');
    expect(html).toMatch(/id="today-phrases"[^>]*>.*It slipped my mind\./);
  });

  it('hides the section when no reminder went out', async () => {
    const html = await (await app.request('/', { headers: { Cookie: await logIn() } })).text();

    expect(html).toContain('<section id="today" class="group" hidden>');
  });
});

describe('GET /', () => {
  it('gives the page the public push key', async () => {
    const html = await (await app.request('/', { headers: { Cookie: await logIn() } })).text();

    expect(html).toContain('data-vapid-key="test-public-key"');
  });

  it('escapes saved phrases so they cannot inject HTML', async () => {
    const cookie = await logIn();
    await postPhrase(JSON.stringify({ text: '<script>alert(1)</script>' }), cookie);

    const html = await (await app.request('/', { headers: { Cookie: cookie } })).text();

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('uses the Android style on Android and the iOS style elsewhere', async () => {
    const cookie = await logIn();
    const htmlFor = async (userAgent: string) =>
      (await app.request('/', { headers: { Cookie: cookie, 'User-Agent': userAgent } })).text();

    expect(await htmlFor('Mozilla/5.0 (Linux; Android 14)')).toContain('data-platform="android"');
    expect(await htmlFor('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)')).toContain('data-platform="ios"');
  });

  it('only allows scripts and styles from the app itself', async () => {
    const response = await app.request('/login');

    expect(response.headers.get('content-security-policy')).toContain("default-src 'self'");
  });
});
