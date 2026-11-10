import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { createMiddleware } from 'hono/factory';
import { secureHeaders } from 'hono/secure-headers';
import { ACCESS_TOKEN_LIFETIME_SECONDS, createAccessToken, readAccessToken } from './auth.js';
import {
  addPhrase,
  claimInvite,
  createInvite,
  createUser,
  deletePhrase,
  findUser,
  findUserByEmail,
  finishInvite,
  isInviteUsable,
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
import { hashInviteCode, INVITE_LIFETIME_DAYS, newInviteCode } from './invites.js';
import { checkNewPassword, dummyHash, hashPassword, MAX_PASSWORD_LENGTH, verifyPassword } from './passwords.js';

export interface AppConfig {
  db: Db;
  /** Signs access tokens. Changing it logs out every device. */
  tokenSecret: string;
  vapidPublicKey: string;
  /** Origins of the separate app allowed to call /api, such as https://app.up.railway.app. */
  appOrigins?: string[];
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

/** Postgres refused a duplicate value, such as an email that two sign-ups claimed at once. */
function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === '23505';
}

const INVALID_TEXT = { error: `Phrase must be 1 to ${MAX_PHRASE_LENGTH} characters` };
const NOT_FOUND = { error: 'Phrase not found' };
const WRONG_LOGIN = { error: 'Wrong email or password' };
const UNUSABLE_INVITE = { error: 'This invite is not valid, was already used, or has expired' };
const EMAIL_TAKEN = { error: 'An account with that email already exists' };

export function createApp({ db, tokenSecret, vapidPublicKey, appOrigins = [] }: AppConfig): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  /** The body for a new session, the same after logging in and after signing up. */
  async function sessionFor(user: User) {
    const { token, expiresAt } = await createAccessToken(tokenSecret, user.id);
    return {
      token,
      expiresAt: expiresAt.toISOString(),
      // Seconds from now, for clients whose clock may be off.
      expiresIn: ACCESS_TOKEN_LIFETIME_SECONDS,
      user: { id: user.id, email: user.email, isAdmin: user.isAdmin },
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

  // The push key is public by design; the app needs it before anyone logs in.
  app.get('/api/config', (c) => c.json({ vapidPublicKey }));

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

  // Sign-up needs an invite from an admin. Each invite creates one account.
  app.post('/api/signup', async (c) => {
    const body = await c.req.json().catch(() => null);
    const email = typeof body?.email === 'string' ? normalizeEmail(body.email) : '';
    const password = typeof body?.password === 'string' ? body.password : '';
    const code = typeof body?.code === 'string' ? body.code.trim() : '';
    if (!email || !password || !code) return c.json({ error: 'Email, password, and invite code are required' }, 400);

    // The invite comes first, so without one nobody learns which emails have an account.
    const codeHash = hashInviteCode(code);
    if (!(await isInviteUsable(db, codeHash))) return c.json(UNUSABLE_INVITE, 403);
    if (!isValidEmail(email)) return c.json({ error: 'Enter a valid email' }, 400);
    const passwordProblem = checkNewPassword(password);
    if (passwordProblem) return c.json({ error: `${passwordProblem} for the password` }, 400);
    if (await findUserByEmail(db, email)) return c.json(EMAIL_TAKEN, 409);

    // Claimed before the account exists, so two sign-ups can't share it.
    const inviteId = await claimInvite(db, codeHash);
    if (inviteId === null) return c.json(UNUSABLE_INVITE, 403);
    let user: User;
    try {
      user = await createUser(db, email, await hashPassword(password));
    } catch (error) {
      await finishInvite(db, inviteId, null);
      if (isUniqueViolation(error)) return c.json(EMAIL_TAKEN, 409);
      throw error;
    }
    await finishInvite(db, inviteId, user.id);

    return c.json(await sessionFor(user), 201);
  });

  // Returns the code once. Only its hash is stored, so it can't be shown again.
  app.post('/api/invites', requireUser, async (c) => {
    const user = c.get('user');
    if (!user.isAdmin) return c.json({ error: 'Only the admin can invite people' }, 403);

    const code = newInviteCode();
    const { expiresAt } = await createInvite(db, user.id, hashInviteCode(code), INVITE_LIFETIME_DAYS);
    return c.json({ code, expiresAt }, 201);
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
