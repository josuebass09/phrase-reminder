import { createHash, timingSafeEqual } from 'node:crypto';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono, type Context } from 'hono';
import { getSignedCookie, setSignedCookie } from 'hono/cookie';
import { secureHeaders } from 'hono/secure-headers';
import {
  addPhrase,
  deletePhrase,
  listRecent,
  listToday,
  MAX_PHRASE_LENGTH,
  saveSubscription,
  updatePhrase,
  type Db,
  type DeviceSubscription,
} from './db.js';
import { renderApp, renderLogin, type Platform } from './page.js';

const SESSION_COOKIE = 'session';
const SESSION_VALUE = 'ok';
const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

export interface AppConfig {
  db: Db;
  password: string;
  sessionSecret: string;
  vapidPublicKey: string;
}

/** Reads a browser's PushSubscription JSON. Push endpoints must be HTTPS. */
function parseSubscription(body: any): DeviceSubscription | null {
  const endpoint = body?.endpoint;
  const p256dh = body?.keys?.p256dh;
  const auth = body?.keys?.auth;
  const isValid =
    typeof endpoint === 'string' &&
    endpoint.startsWith('https://') &&
    typeof p256dh === 'string' &&
    p256dh.length > 0 &&
    typeof auth === 'string' &&
    auth.length > 0;
  return isValid ? { endpoint, p256dh, auth } : null;
}

const MAX_PHRASE_ID = 2_147_483_647; // Postgres SERIAL is a 32-bit integer.

/** Reads a phrase id from the URL. Anything that can't be a stored id is null. */
function parsePhraseId(value: string): number | null {
  if (!/^\d{1,10}$/.test(value)) return null;
  const id = Number(value);
  return id >= 1 && id <= MAX_PHRASE_ID ? id : null;
}

/** Reads the trimmed phrase text from a JSON body, or null if it's missing or too long. */
async function readPhraseText(c: Context): Promise<string | null> {
  const body = await c.req.json().catch(() => null);
  const text = typeof body?.text === 'string' ? body.text.trim() : '';
  return text && text.length <= MAX_PHRASE_LENGTH ? text : null;
}

const INVALID_TEXT = { error: `Phrase must be 1 to ${MAX_PHRASE_LENGTH} characters` };
const NOT_FOUND = { error: 'Phrase not found' };

function samePassword(a: string, b: string): boolean {
  // Hashing gives both sides equal length, which timingSafeEqual requires.
  const hash = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(hash(a), hash(b));
}

function platformOf(c: Context): Platform {
  return /android/i.test(c.req.header('user-agent') ?? '') ? 'android' : 'ios';
}

export function createApp({ db, password, sessionSecret, vapidPublicKey }: AppConfig): Hono {
  const app = new Hono();

  const isLoggedIn = async (c: Context) =>
    (await getSignedCookie(c, sessionSecret, SESSION_COOKIE)) === SESSION_VALUE;

  app.use(
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        baseUri: ["'none'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
      },
    }),
  );

  app.get('/login', (c) => c.html(renderLogin(platformOf(c))));

  app.post('/login', async (c) => {
    const body = await c.req.parseBody();
    if (!samePassword(String(body.password ?? ''), password)) {
      return c.html(renderLogin(platformOf(c), 'Wrong password.'), 401);
    }
    await setSignedCookie(c, SESSION_COOKIE, SESSION_VALUE, sessionSecret, {
      httpOnly: true,
      // Browsers can refuse Secure cookies over http://localhost during development.
      secure: new URL(c.req.url).hostname !== 'localhost',
      sameSite: 'Lax',
      path: '/',
      maxAge: ONE_YEAR_SECONDS,
    });
    return c.redirect('/');
  });

  app.get('/', async (c) => {
    if (!(await isLoggedIn(c))) return c.redirect('/login');
    return c.html(
      renderApp({
        platform: platformOf(c),
        recent: await listRecent(db),
        today: await listToday(db),
        vapidPublicKey,
      }),
    );
  });

  app.get('/api/today', async (c) => {
    if (!(await isLoggedIn(c))) return c.json({ error: 'Not logged in' }, 401);
    return c.json(await listToday(db));
  });

  app.post('/api/phrases', async (c) => {
    if (!(await isLoggedIn(c))) return c.json({ error: 'Not logged in' }, 401);

    const text = await readPhraseText(c);
    if (!text) return c.json(INVALID_TEXT, 400);

    return c.json(await addPhrase(db, text), 201);
  });

  app.patch('/api/phrases/:id', async (c) => {
    if (!(await isLoggedIn(c))) return c.json({ error: 'Not logged in' }, 401);

    const id = parsePhraseId(c.req.param('id'));
    if (id === null) return c.json(NOT_FOUND, 404);

    const text = await readPhraseText(c);
    if (!text) return c.json(INVALID_TEXT, 400);

    const phrase = await updatePhrase(db, id, text);
    return phrase ? c.json(phrase) : c.json(NOT_FOUND, 404);
  });

  app.delete('/api/phrases/:id', async (c) => {
    if (!(await isLoggedIn(c))) return c.json({ error: 'Not logged in' }, 401);

    const id = parsePhraseId(c.req.param('id'));
    if (id === null || !(await deletePhrase(db, id))) return c.json(NOT_FOUND, 404);

    return c.body(null, 204);
  });

  app.post('/api/push/subscribe', async (c) => {
    if (!(await isLoggedIn(c))) return c.json({ error: 'Not logged in' }, 401);

    const subscription = parseSubscription(await c.req.json().catch(() => null));
    if (!subscription) return c.json({ error: 'Invalid subscription' }, 400);

    await saveSubscription(db, subscription);
    return c.body(null, 204);
  });

  app.use('/*', serveStatic({ root: './public' }));

  return app;
}
