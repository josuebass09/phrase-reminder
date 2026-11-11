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
  dailyUses,
  deletePhrase,
  findUser,
  findPhraseTranslation,
  findUserByEmail,
  finishInvite,
  getSettings,
  isInviteUsable,
  isValidEmail,
  listRecent,
  listToday,
  MAX_PHRASE_LENGTH,
  MAX_TRANSLATION_LENGTH,
  normalizeEmail,
  releaseDailyUse,
  reserveDailyUse,
  saveSubscription,
  saveTranslation,
  updateSettings,
  updatePhrase,
  type DailyCounter,
  type Db,
  type DeviceSubscription,
  type ReminderSettings,
  type User,
} from './db.js';
import { hashInviteCode, INVITE_LIFETIME_DAYS, newInviteCode } from './invites.js';
import { checkNewPassword, dummyHash, hashPassword, MAX_PASSWORD_LENGTH, verifyPassword } from './passwords.js';
import { isValidTime, isValidTimeZone, localClock, MAX_PHRASES_PER_DAY } from './schedule.js';
import { MAX_CONTEXT_LENGTH, type Suggester } from './suggest.js';
import type { Translator } from './translate.js';

export interface AppConfig {
  db: Db;
  /** Signs access tokens. Changing it logs out every device. */
  tokenSecret: string;
  vapidPublicKey: string;
  /** Origins of the separate app allowed to call /api, such as https://app.up.railway.app. */
  appOrigins?: string[];
  /** Translates phrases to Spanish. Without it, asking for a translation gets a 503. */
  translate?: Translator;
  /** New translations each user may ask for per local day. The admin has no limit. */
  translationsPerDay?: number;
  /** Gives the formal and informal ways to say a new phrase. Without it, suggestions get a 503. */
  suggest?: Suggester;
  /** Suggestions each user may ask for per local day. The admin has no limit. */
  suggestionsPerDay?: number;
}

export const DEFAULT_TRANSLATIONS_PER_DAY = 30;
// 20 users at 20 a day stay well inside the AI's free plan of about 1,000 requests a day.
export const DEFAULT_SUGGESTIONS_PER_DAY = 20;

/** Big enough to never stop anyone, for the admin, whose translations are still counted. */
const NO_LIMIT = 2_147_483_647;

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

/** The trimmed phrase text from a JSON body, or null if it's missing or too long. */
function phraseTextOf(body: any): string | null {
  const text = typeof body?.text === 'string' ? body.text.trim() : '';
  return text && text.length <= MAX_PHRASE_LENGTH ? text : null;
}

async function readPhraseText(c: Context): Promise<string | null> {
  return phraseTextOf(await c.req.json().catch(() => null));
}

/** Postgres refused a duplicate value, such as an email that two sign-ups claimed at once. */
function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === '23505';
}

/** Reads the settings to change from a JSON body: the changes, or what's wrong with them. */
function parseSettingsChanges(body: any): { changes: Partial<ReminderSettings> } | { error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Send the settings to change as a JSON object' };
  const changes: Partial<ReminderSettings> = {};
  if (body.remindersOn !== undefined) {
    if (typeof body.remindersOn !== 'boolean') return { error: 'remindersOn must be true or false' };
    changes.remindersOn = body.remindersOn;
  }
  if (body.reminderTime !== undefined) {
    if (typeof body.reminderTime !== 'string' || !isValidTime(body.reminderTime)) {
      return { error: 'reminderTime must be a 24-hour time such as 08:30' };
    }
    changes.reminderTime = body.reminderTime;
  }
  if (body.timeZone !== undefined) {
    if (typeof body.timeZone !== 'string' || !isValidTimeZone(body.timeZone)) {
      return { error: 'timeZone must be a time zone such as America/Costa_Rica' };
    }
    changes.timeZone = body.timeZone;
  }
  if (body.phrasesPerDay !== undefined) {
    const count = body.phrasesPerDay;
    if (!Number.isInteger(count) || count < 1 || count > MAX_PHRASES_PER_DAY) {
      return { error: `phrasesPerDay must be a whole number from 1 to ${MAX_PHRASES_PER_DAY}` };
    }
    changes.phrasesPerDay = count;
  }
  if (Object.keys(changes).length === 0) return { error: 'Nothing to change' };
  return { changes };
}

const INVALID_TEXT = { error: `Phrase must be 1 to ${MAX_PHRASE_LENGTH} characters` };
const INVALID_TRANSLATION = { error: `Translation must be text of up to ${MAX_TRANSLATION_LENGTH} characters` };
const INVALID_CONTEXT = { error: `Context must be text of up to ${MAX_CONTEXT_LENGTH} characters` };
const NOT_FOUND = { error: 'Phrase not found' };
const WRONG_LOGIN = { error: 'Wrong email or password' };
const UNUSABLE_INVITE = { error: 'This invite is not valid, was already used, or has expired' };
const EMAIL_TAKEN = { error: 'An account with that email already exists' };

export function createApp({
  db,
  tokenSecret,
  vapidPublicKey,
  appOrigins = [],
  translate,
  translationsPerDay = DEFAULT_TRANSLATIONS_PER_DAY,
  suggest,
  suggestionsPerDay = DEFAULT_SUGGESTIONS_PER_DAY,
}: AppConfig): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const perDay: Record<DailyCounter, number> = { translations: translationsPerDay, suggestions: suggestionsPerDay };

  /** The user's local day, from the time zone in their settings, for daily limits. */
  async function userDay(userId: number): Promise<string> {
    const settings = await getSettings(db, userId);
    return localClock(new Date(), settings?.timeZone ?? 'UTC').day;
  }

  /** Counts one use on the user's local day and returns that day, or null if they've reached the limit. */
  async function reserve(user: User, counter: DailyCounter): Promise<string | null> {
    const day = await userDay(user.id);
    const limit = user.isAdmin ? NO_LIMIT : perDay[counter];
    return (await reserveDailyUse(db, user.id, counter, day, limit)) ? day : null;
  }

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

  // What the user has used of each daily limit today, and the limit (null for the admin).
  app.get('/api/usage', requireUser, async (c) => {
    const user = c.get('user');
    const day = await userDay(user.id);
    const usage = async (counter: DailyCounter) => ({
      used: await dailyUses(db, user.id, counter, day),
      limit: user.isAdmin ? null : perDay[counter],
    });
    return c.json({ translations: await usage('translations'), suggestions: await usage('suggestions') });
  });

  app.get('/api/settings', requireUser, async (c) => c.json(await getSettings(db, c.get('user').id)));

  // Changes only the settings sent; the others stay as they are.
  app.patch('/api/settings', requireUser, async (c) => {
    const parsed = parseSettingsChanges(await c.req.json().catch(() => null));
    if ('error' in parsed) return c.json({ error: parsed.error }, 400);
    return c.json(await updateSettings(db, c.get('user').id, parsed.changes));
  });

  app.get('/api/phrases', requireUser, async (c) => c.json(await listRecent(db, c.get('user').id)));

  app.get('/api/today', requireUser, async (c) => c.json(await listToday(db, c.get('user').id)));

  app.post('/api/phrases', requireUser, async (c) => {
    const body = await c.req.json().catch(() => null);
    const text = phraseTextOf(body);
    if (!text) return c.json(INVALID_TEXT, 400);
    // Optional. A suggested phrase comes with its Spanish, so translating it later is free.
    const translation = body.translation ?? null;
    if (translation !== null && (typeof translation !== 'string' || translation.length > MAX_TRANSLATION_LENGTH)) {
      return c.json(INVALID_TRANSLATION, 400);
    }

    return c.json(await addPhrase(db, c.get('user').id, text, translation?.trim() || null), 201);
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

  // Translated on the first request, then served from the database.
  app.get('/api/phrases/:id/translation', requireUser, async (c) => {
    const userId = c.get('user').id;
    const id = parsePhraseId(c.req.param('id'));
    const phrase = id === null ? null : await findPhraseTranslation(db, userId, id);
    if (id === null || !phrase) return c.json(NOT_FOUND, 404);
    if (phrase.translation) return c.json({ translation: phrase.translation });
    if (!translate) return c.json({ error: "Translation isn't available" }, 503);

    // Only new translations count toward the daily limit; saved ones above are free.
    const day = await reserve(c.get('user'), 'translations');
    if (!day) return c.json({ error: `You've used today's ${translationsPerDay} translations. More tomorrow.` }, 429);

    let translation: string;
    try {
      translation = await translate(phrase.text);
    } catch (error) {
      await releaseDailyUse(db, userId, 'translations', day);
      console.error('Translation failed:', error);
      return c.json({ error: "Couldn't translate right now" }, 502);
    }
    await saveTranslation(db, userId, id, phrase.text, translation);
    return c.json({ translation });
  });

  // A formal and an informal way to say a new phrase in English. Nothing is saved
  // until the user picks one, which the app then saves as a phrase.
  app.post('/api/suggestions', requireUser, async (c) => {
    const body = await c.req.json().catch(() => null);
    const text = phraseTextOf(body);
    if (!text) return c.json(INVALID_TEXT, 400);
    // Optional: who it's for, where, or what it's about, so the options fit the situation.
    const context = body.context ?? '';
    if (typeof context !== 'string' || context.length > MAX_CONTEXT_LENGTH) return c.json(INVALID_CONTEXT, 400);
    if (!suggest) return c.json({ error: "Suggestions aren't available right now" }, 503);

    const user = c.get('user');
    const day = await reserve(user, 'suggestions');
    if (!day) return c.json({ error: `You've used today's ${suggestionsPerDay} suggestions. More tomorrow.` }, 429);

    try {
      return c.json(await suggest(text, context.trim() || undefined));
    } catch (error) {
      await releaseDailyUse(db, user.id, 'suggestions', day);
      console.error('Suggestions failed:', error);
      return c.json({ error: "Couldn't get an answer right now. Try again." }, 502);
    }
  });

  app.post('/api/push/subscribe', requireUser, async (c) => {
    const subscription = parseSubscription(await c.req.json().catch(() => null));
    if (!subscription) return c.json({ error: 'Invalid subscription' }, 400);

    await saveSubscription(db, c.get('user').id, subscription);
    return c.body(null, 204);
  });

  return app;
}
