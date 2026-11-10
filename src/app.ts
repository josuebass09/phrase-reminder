import { createHash, timingSafeEqual } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { createMiddleware } from 'hono/factory';
import { secureHeaders } from 'hono/secure-headers';
import { ACCESS_TOKEN_LIFETIME_SECONDS, createAccessToken, readAccessToken } from './auth.js';
import {
  addPhrase,
  claimUnowned,
  countUsers,
  createUser,
  deletePhrase,
  findUser,
  findUserByEmail,
  isValidEmail,
  listRecent,
  listToday,
  MAX_PHRASE_LENGTH,
  normalizeEmail,
  saveSubscription,
  updatePhrase,
  type Db,
  type DeviceSubscription,
  type User,
} from './db.js';
import { checkNewPassword, dummyHash, hashPassword, MAX_PASSWORD_LENGTH, verifyPassword } from './passwords.js';

/** Shorter invite codes would be easy to guess, so they leave sign-up closed. */
export const MIN_SIGNUP_CODE_LENGTH = 12;

export interface AppConfig {
  db: Db;
  /** Signs access tokens. Changing it logs out every device. */
  tokenSecret: string;
  vapidPublicKey: string;
  /** Origins of the separate app allowed to call /api, such as https://app.up.railway.app. */
  appOrigins?: string[];
  /**
   * The invite code that lets people create an account from the app. Without one
   * of at least MIN_SIGNUP_CODE_LENGTH characters, sign-up is closed.
   */
  signupCode?: string;
}

type AppEnv = { Variables: { user: User } };

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

function sameSecret(a: string, b: string): boolean {
  // Hashing gives both sides equal length, which timingSafeEqual requires.
  const hash = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(hash(a), hash(b));
}

/** Postgres refused a duplicate value, such as an email that two sign-ups claimed at once. */
function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === '23505';
}

const INVALID_TEXT = { error: `Phrase must be 1 to ${MAX_PHRASE_LENGTH} characters` };
const NOT_FOUND = { error: 'Phrase not found' };
const WRONG_LOGIN = { error: 'Wrong email or password' };

export function createApp({
  db,
  tokenSecret,
  vapidPublicKey,
  appOrigins = [],
  signupCode = '',
}: AppConfig): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const signupOpen = signupCode.length >= MIN_SIGNUP_CODE_LENGTH;

  /** The body for a new session, the same after logging in and after signing up. */
  async function sessionFor(user: User) {
    const { token, expiresAt } = await createAccessToken(tokenSecret, user.id);
    return {
      token,
      expiresAt: expiresAt.toISOString(),
      // Seconds from now, for clients whose clock may be off.
      expiresIn: ACCESS_TOKEN_LIFETIME_SECONDS,
      user: { id: user.id, email: user.email },
    };
  }

  // The user must still exist: deleting one locks out their tokens at once.
  const requireUser = createMiddleware<AppEnv>(async (c, next) => {
    const authorization = c.req.header('authorization') ?? '';
    const userId = authorization.startsWith('Bearer ')
      ? await readAccessToken(tokenSecret, authorization.slice(7))
      : null;
    const user = userId === null ? null : await findUser(db, userId);
    if (!user) return c.json({ error: 'Not logged in' }, 401);
    c.set('user', user);
    await next();
  });

  if (appOrigins.length > 0) {
    app.use(
      '/api/*',
      cors({
        origin: appOrigins,
        allowMethods: ['GET', 'POST', 'PATCH', 'DELETE'],
        allowHeaders: ['Authorization', 'Content-Type'],
        maxAge: 86_400,
      }),
    );
  }

  // Only JSON is served here; the app has its own domain and policy.
  app.use(
    secureHeaders({
      contentSecurityPolicy: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
    }),
  );

  // Public: the app needs both before anyone logs in.
  app.get('/api/config', (c) => c.json({ vapidPublicKey, signupOpen }));

  app.post('/api/login', async (c) => {
    const body = await c.req.json().catch(() => null);
    const email = typeof body?.email === 'string' ? normalizeEmail(body.email) : '';
    const password = typeof body?.password === 'string' ? body.password : '';
    if (!email || !password) return c.json({ error: 'Email and password are required' }, 400);
    if (password.length > MAX_PASSWORD_LENGTH) return c.json(WRONG_LOGIN, 401);

    const user = await findUserByEmail(db, email);
    const matches = await verifyPassword(password, user?.passwordHash ?? (await dummyHash()));
    if (!user || !matches) return c.json(WRONG_LOGIN, 401);

    return c.json(await sessionFor(user));
  });

  app.post('/api/signup', async (c) => {
    if (!signupOpen) return c.json({ error: 'Sign-up is closed' }, 403);

    const body = await c.req.json().catch(() => null);
    const email = typeof body?.email === 'string' ? normalizeEmail(body.email) : '';
    const password = typeof body?.password === 'string' ? body.password : '';
    const code = typeof body?.code === 'string' ? body.code.trim() : '';
    if (!email || !password || !code) return c.json({ error: 'Email, password, and invite code are required' }, 400);

    // The code comes first, so without it nobody learns which emails have an account.
    if (!sameSecret(code, signupCode)) return c.json({ error: 'Wrong invite code' }, 403);
    if (!isValidEmail(email)) return c.json({ error: 'Enter a valid email' }, 400);
    const passwordProblem = checkNewPassword(password);
    if (passwordProblem) return c.json({ error: `${passwordProblem} for the password` }, 400);
    if (await findUserByEmail(db, email)) return c.json({ error: 'An account with that email already exists' }, 409);

    let user: User;
    try {
      user = await createUser(db, email, await hashPassword(password));
    } catch (error) {
      if (isUniqueViolation(error)) return c.json({ error: 'An account with that email already exists' }, 409);
      throw error;
    }
    // The first account gets what was saved before accounts existed.
    if ((await countUsers(db)) === 1) await claimUnowned(db, user.id);

    return c.json(await sessionFor(user), 201);
  });

  app.get('/api/me', requireUser, (c) => c.json(c.get('user')));

  app.get('/api/phrases', requireUser, async (c) => c.json(await listRecent(db, c.get('user').id)));

  app.get('/api/today', requireUser, async (c) => c.json(await listToday(db, c.get('user').id)));

  app.post('/api/phrases', requireUser, async (c) => {
    const text = await readPhraseText(c);
    if (!text) return c.json(INVALID_TEXT, 400);

    return c.json(await addPhrase(db, c.get('user').id, text), 201);
  });

  // Another user's phrase gets the same 404 as a missing one, so ids reveal nothing.
  app.patch('/api/phrases/:id', requireUser, async (c) => {
    const id = parsePhraseId(c.req.param('id'));
    if (id === null) return c.json(NOT_FOUND, 404);

    const text = await readPhraseText(c);
    if (!text) return c.json(INVALID_TEXT, 400);

    const phrase = await updatePhrase(db, c.get('user').id, id, text);
    return phrase ? c.json(phrase) : c.json(NOT_FOUND, 404);
  });

  app.delete('/api/phrases/:id', requireUser, async (c) => {
    const id = parsePhraseId(c.req.param('id'));
    if (id === null || !(await deletePhrase(db, c.get('user').id, id))) return c.json(NOT_FOUND, 404);

    return c.body(null, 204);
  });

  app.post('/api/push/subscribe', requireUser, async (c) => {
    const subscription = parseSubscription(await c.req.json().catch(() => null));
    if (!subscription) return c.json({ error: 'Invalid subscription' }, 400);

    await saveSubscription(db, c.get('user').id, subscription);
    return c.body(null, 204);
  });

  return app;
}
