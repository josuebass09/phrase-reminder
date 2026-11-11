import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { createMiddleware } from 'hono/factory';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import {
  ACCESS_TOKEN_LIFETIME_SECONDS,
  createAccessToken,
  hashRefreshToken,
  newRefreshToken,
  readAccessToken,
} from './auth.js';
import {
  addPhrase,
  AI_SERVICES,
  aiQuotas,
  aiUsageSince,
  capacityFacts,
  claimInvite,
  cronRunsSince,
  databaseStats,
  deliveriesByDay,
  createInvite,
  createSession,
  createUser,
  dailyUses,
  deletePhrase,
  endSessionByToken,
  endSessionIfReused,
  endUserSessions,
  findUser,
  findUserInSession,
  findPhraseTranslation,
  findUserByEmail,
  forgetActivity,
  finishInvite,
  getSettings,
  isInviteUsable,
  isValidEmail,
  listRecent,
  listToday,
  listUsersForAdmin,
  markReviewed,
  recordActivity,
  MAX_PHRASE_LENGTH,
  MAX_TRANSLATION_LENGTH,
  normalizeEmail,
  releaseDailyUse,
  reserveDailyUse,
  rotateSession,
  saveScore,
  saveSubscription,
  saveTranslation,
  updateSettings,
  updatePhrase,
  type ActivityKind,
  type DailyCounter,
  type Db,
  type DeviceSubscription,
  type ReminderSettings,
  type User,
} from './db.js';
import { hashInviteCode, INVITE_LIFETIME_DAYS, newInviteCode } from './invites.js';
import { isLanguage, languageFrom, messagesFor, type Messages } from './messages.js';
import { checkNewPassword, dummyHash, hashPassword, MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, verifyPassword } from './passwords.js';
import { MAX_RECORDING_BYTES, NoAudioError, NoSpeechError, recordingType, type Pronouncer, type Pronunciation } from './pronounce.js';
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
  /** Scores how the user says a phrase aloud. Without it, asking for a score gets a 503. */
  pronounce?: Pronouncer;
  /** Pronunciation scores each user may ask for per local day. The admin has no limit. */
  pronunciationsPerDay?: number;
  /** MyMemory's free characters a day for this server: about 5,000, or 50,000 with a contact email. */
  mymemoryCharsPerDay?: number;
  /** The commit running, from Railway, for the admin to tell which version is deployed. */
  version?: string | null;
}

export const DEFAULT_TRANSLATIONS_PER_DAY = 30;
// 20 users at 20 a day stay well inside the AI's free plan of about 1,000 requests a day.
export const DEFAULT_SUGGESTIONS_PER_DAY = 20;
// Each score is a speech request, plus a chat request for the tip when words were missed,
// which shares the chat model's free limit with suggestions: 20 users at 20 a day of each
// stay under its 1,000 a day.
export const DEFAULT_PRONUNCIATIONS_PER_DAY = 20;

/** MyMemory's free daily characters without a contact email (https://mymemory.translated.net/doc/usagelimits.php). */
export const MYMEMORY_FREE_CHARS_PER_DAY = 5_000;
/** With a contact email. */
export const MYMEMORY_EMAIL_CHARS_PER_DAY = 50_000;

/** Days of AI requests the admin sees. */
const AI_HISTORY_DAYS = 30;

/** The last `days` UTC days, today included, oldest first, as YYYY-MM-DD. */
function lastUtcDays(days: number, now: Date): string[] {
  return Array.from({ length: days }, (_, index) =>
    new Date(now.getTime() - (days - 1 - index) * 86_400_000).toISOString().slice(0, 10),
  );
}

/** Big enough to never stop anyone, for the admin, whose translations are still counted. */
const NO_LIMIT = 2_147_483_647;

type AppEnv = { Variables: { user: User } };

// What the app reports about a user's day: things done with a phrase, and things done once a day.
const PHRASE_ACTIVITY = new Set<ActivityKind>(['phrase_heard', 'phrase_translated']);
const DAY_ACTIVITY = new Set<ActivityKind>(['reminder_opened', 'today_viewed']);
/** What a swipe off Today says about a phrase. */
const REVIEW_KINDS = { read: 'phrase_read', remembered: 'phrase_remembered' } as const satisfies Record<string, ActivityKind>;

/** The refresh token from a JSON body, or an empty string. */
function refreshTokenOf(body: any): string {
  return typeof body?.refreshToken === 'string' ? body.refreshToken : '';
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

/** Longer than any phrase worth searching for. */
const MAX_SEARCH_LENGTH = 100;

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
  if (body.language !== undefined) {
    if (!isLanguage(body.language)) return { error: 'language must be en or es' };
    changes.language = body.language;
  }
  if (Object.keys(changes).length === 0) return { error: 'Nothing to change' };
  return { changes };
}

/** Messages for people, in the language the app asked for with Accept-Language. */
function say(c: Context): Messages {
  return messagesFor(languageFrom(c.req.header('accept-language')));
}

export function createApp({
  db,
  tokenSecret,
  vapidPublicKey,
  appOrigins = [],
  translate,
  translationsPerDay = DEFAULT_TRANSLATIONS_PER_DAY,
  suggest,
  suggestionsPerDay = DEFAULT_SUGGESTIONS_PER_DAY,
  pronounce,
  pronunciationsPerDay = DEFAULT_PRONUNCIATIONS_PER_DAY,
  mymemoryCharsPerDay = MYMEMORY_FREE_CHARS_PER_DAY,
  version = null,
}: AppConfig): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const perDay: Record<DailyCounter, number> = {
    translations: translationsPerDay,
    suggestions: suggestionsPerDay,
    pronunciations: pronunciationsPerDay,
  };

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

  /** The body with a session's tokens: a new access token, and the refresh token to renew it with. */
  async function tokensFor(user: User, sessionId: number, refreshToken: string) {
    const { token, expiresAt } = await createAccessToken(tokenSecret, user.id, sessionId);
    return {
      token,
      expiresAt: expiresAt.toISOString(),
      // Seconds from now, for clients whose clock may be off.
      expiresIn: ACCESS_TOKEN_LIFETIME_SECONDS,
      refreshToken,
      user: { id: user.id, email: user.email, isAdmin: user.isAdmin },
    };
  }

  /** Opens a session after logging in or signing up. */
  async function sessionFor(user: User) {
    const refreshToken = newRefreshToken();
    return tokensFor(user, await createSession(db, user.id, hashRefreshToken(refreshToken)), refreshToken);
  }

  // The session must still be open, and its user must still exist: logging out, or
  // deleting the user, locks out their tokens at once.
  const requireUser = createMiddleware<AppEnv>(async (c, next) => {
    const authorization = c.req.header('authorization') ?? '';
    const claims = authorization.startsWith('Bearer ')
      ? await readAccessToken(tokenSecret, authorization.slice(7))
      : null;
    const user = !claims
      ? null
      : claims.sessionId === null
        ? await findUser(db, claims.userId)
        : await findUserInSession(db, claims.userId, claims.sessionId);
    if (!user) return c.json({ error: say(c).notLoggedIn }, 401);
    c.set('user', user);
    await next();
  });

  /** After requireUser: only the admin goes on. */
  const requireAdmin = createMiddleware<AppEnv>(async (c, next) => {
    if (!c.get('user').isAdmin) return c.json({ error: say(c).onlyAdmin }, 403);
    await next();
  });

  if (appOrigins.length > 0) {
    app.use(
      '/api/*',
      cors({
        origin: appOrigins,
        allowMethods: ['GET', 'POST', 'PATCH', 'DELETE'],
        allowHeaders: ['Authorization', 'Content-Type', 'Accept-Language'],
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
    if (!email || !password) return c.json({ error: say(c).loginRequired }, 400);
    if (password.length > MAX_PASSWORD_LENGTH) return c.json({ error: say(c).wrongLogin }, 401);

    const user = await findUserByEmail(db, email);
    const matches = await verifyPassword(password, user?.passwordHash ?? (await dummyHash()));
    if (!user || !matches) return c.json({ error: say(c).wrongLogin }, 401);

    return c.json(await sessionFor(user));
  });

  // Sign-up needs an invite from an admin. Each invite creates one account.
  app.post('/api/signup', async (c) => {
    const body = await c.req.json().catch(() => null);
    const email = typeof body?.email === 'string' ? normalizeEmail(body.email) : '';
    const password = typeof body?.password === 'string' ? body.password : '';
    const code = typeof body?.code === 'string' ? body.code.trim() : '';
    const m = say(c);
    if (!email || !password || !code) return c.json({ error: m.signupRequired }, 400);

    // The invite comes first, so without one nobody learns which emails have an account.
    const codeHash = hashInviteCode(code);
    if (!(await isInviteUsable(db, codeHash))) return c.json({ error: m.unusableInvite }, 403);
    if (!isValidEmail(email)) return c.json({ error: m.invalidEmail }, 400);
    if (checkNewPassword(password)) {
      return c.json({ error: password.length < MIN_PASSWORD_LENGTH ? m.passwordTooShort : m.passwordTooLong }, 400);
    }
    if (await findUserByEmail(db, email)) return c.json({ error: m.emailTaken }, 409);

    // Claimed before the account exists, so two sign-ups can't share it.
    const inviteId = await claimInvite(db, codeHash);
    if (inviteId === null) return c.json({ error: m.unusableInvite }, 403);
    let user: User;
    try {
      user = await createUser(db, email, await hashPassword(password));
    } catch (error) {
      await finishInvite(db, inviteId, null);
      if (isUniqueViolation(error)) return c.json({ error: m.emailTaken }, 409);
      throw error;
    }
    await finishInvite(db, inviteId, user.id);

    return c.json(await sessionFor(user), 201);
  });

  // Swaps the refresh token for a new pair. A 401 means the session is over: it ran out,
  // the user logged out, or the token was already used.
  app.post('/api/session/refresh', async (c) => {
    const refreshToken = refreshTokenOf(await c.req.json().catch(() => null));
    const tokenHash = refreshToken ? hashRefreshToken(refreshToken) : '';
    const next = newRefreshToken();
    const session = tokenHash ? await rotateSession(db, tokenHash, hashRefreshToken(next)) : null;
    const user = session ? await findUser(db, session.userId) : null;
    if (!session || !user) {
      if (tokenHash) await endSessionIfReused(db, tokenHash);
      return c.json({ error: say(c).notLoggedIn }, 401);
    }
    return c.json(await tokensFor(user, session.id, next));
  });

  // Ends the session the refresh token belongs to. It needs no access token, so logging
  // out works even after that one ran out. Unknown tokens are fine: the session is over either way.
  app.post('/api/logout', async (c) => {
    const refreshToken = refreshTokenOf(await c.req.json().catch(() => null));
    if (refreshToken) await endSessionByToken(db, hashRefreshToken(refreshToken));
    return c.body(null, 204);
  });

  // Logs the user out of every device, this one included.
  app.delete('/api/sessions', requireUser, async (c) => {
    await endUserSessions(db, c.get('user').id);
    return c.body(null, 204);
  });

  // Returns the code once. Only its hash is stored, so it can't be shown again.
  app.post('/api/invites', requireUser, async (c) => {
    const user = c.get('user');
    if (!user.isAdmin) return c.json({ error: say(c).onlyAdminInvites }, 403);

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
    return c.json({
      translations: await usage('translations'),
      suggestions: await usage('suggestions'),
      pronunciations: await usage('pronunciations'),
    });
  });

  // The admin's view of the AI services: each day's requests for the last 30 UTC days, what's
  // left of Groq's daily quotas, and what's needed to estimate the worst case with every user's limits.
  app.get('/api/admin/ai', requireUser, requireAdmin, async (c) => {
    const now = new Date();
    const history = lastUtcDays(AI_HISTORY_DAYS, now).map((day) => ({
      day,
      ...Object.fromEntries(AI_SERVICES.map((service) => [service, { calls: 0, failures: 0, rateLimited: 0, units: 0 }])),
    })) as ({ day: string } & Record<string, { calls: number; failures: number; rateLimited: number; units: number }>)[];
    for (const { day, service, ...counts } of await aiUsageSince(db, AI_HISTORY_DAYS, now)) {
      const entry = history.find((each) => each.day === day);
      if (entry) entry[service] = counts;
    }
    const quotas = Object.fromEntries((await aiQuotas(db)).map(({ service, ...quota }) => [service, quota]));
    const { limitedUsers, averagePhraseLength } = await capacityFacts(db);
    return c.json({
      history,
      quotas: { groq_chat: quotas.groq_chat ?? null, groq_speech: quotas.groq_speech ?? null },
      mymemoryCharsPerDay,
      available: { groq: Boolean(suggest || pronounce), mymemory: Boolean(translate) },
      perUserPerDay: { suggestions: suggestionsPerDay, translations: translationsPerDay, pronunciations: pronunciationsPerDay },
      limitedUsers,
      averagePhraseLength,
    });
  });

  // Every user, with what the admin needs to look after them: activity, devices, sessions, and today's usage.
  app.get('/api/admin/users', requireUser, requireAdmin, async (c) => {
    const now = new Date();
    const users = await listUsersForAdmin(db);
    return c.json(
      users.map(({ counters, timeZone, ...user }) => {
        let today: string;
        try {
          today = localClock(now, timeZone).day;
        } catch {
          today = localClock(now, 'UTC').day;
        }
        const usedToday = (counter: DailyCounter) => (counters[counter].day === today ? counters[counter].used : 0);
        return {
          ...user,
          today: {
            suggestions: usedToday('suggestions'),
            translations: usedToday('translations'),
            pronunciations: usedToday('pronunciations'),
          },
        };
      }),
    );
  });

  // Logs a user out of every device, as when they're locked out or lose a phone. Their data stays.
  app.delete('/api/admin/users/:id/sessions', requireUser, requireAdmin, async (c) => {
    const m = say(c);
    const id = parsePhraseId(c.req.param('id')); // Same shape as a phrase's id.
    if (id === null || !(await findUser(db, id))) return c.json({ error: m.userNotFound }, 404);
    if (id === c.get('user').id) return c.json({ error: m.endOwnSessionsInSettings }, 400);
    return c.json({ ended: await endUserSessions(db, id) });
  });

  // The system's health: the reminder cron's runs and deliveries, the database's size, and the deployed versions.
  app.get('/api/admin/system', requireUser, requireAdmin, async (c) => {
    const now = new Date();
    const dayAgo = new Date(now.getTime() - 86_400_000);
    const runs = await cronRunsSince(db, new Date(now.getTime() - 7 * 86_400_000));
    const lastDay = runs.filter((run) => run.startedAt >= dayAgo);
    const failed = runs.find((run) => run.errors > 0);
    const { remindersOn, devices } = await capacityFacts(db);
    return c.json({
      cron: {
        lastRunAt: runs[0]?.startedAt ?? null,
        runsLastDay: lastDay.length,
        failedRunsLastDay: lastDay.filter((run) => run.errors > 0).length,
        lastError: failed ? { at: failed.startedAt, message: failed.firstError } : null,
        removedLastWeek: runs.reduce((sum, run) => sum + run.removed, 0),
        deliveries: await deliveriesByDay(db, 7, now),
      },
      reminders: { usersOn: remindersOn, devices },
      database: await databaseStats(db),
      versions: { api: version, cron: runs[0]?.version ?? null },
    });
  });

  app.get('/api/settings', requireUser, async (c) => c.json(await getSettings(db, c.get('user').id)));

  // Changes only the settings sent; the others stay as they are.
  app.patch('/api/settings', requireUser, async (c) => {
    const parsed = parseSettingsChanges(await c.req.json().catch(() => null));
    if ('error' in parsed) return c.json({ error: parsed.error }, 400);
    return c.json(await updateSettings(db, c.get('user').id, parsed.changes));
  });

  // Newest first, 50 at a time: ?before=<id> gives the 50 after that phrase, and ?q= only those
  // whose text or Spanish has it.
  app.get('/api/phrases', requireUser, async (c) => {
    const search = (c.req.query('q') ?? '').trim();
    if (search.length > MAX_SEARCH_LENGTH) return c.json({ error: `q must be at most ${MAX_SEARCH_LENGTH} characters` }, 400);
    const beforeParam = c.req.query('before');
    const before = beforeParam === undefined ? null : parsePhraseId(beforeParam);
    if (beforeParam !== undefined && before === null) return c.json({ error: 'before must be a phrase id' }, 400);
    return c.json(await listRecent(db, c.get('user').id, { search: search || undefined, before: before ?? undefined }));
  });

  app.get('/api/today', requireUser, async (c) => c.json(await listToday(db, c.get('user').id)));

  // Swiping a phrase away from Today: it was read, or remembered. Today leaves it out until a
  // later reminder sends it again, and the activity keeps which, to tell whether reading is enough.
  app.post('/api/phrases/:id/review', requireUser, async (c) => {
    const user = c.get('user');
    const body = await c.req.json().catch(() => null);
    // Only these two: indexing with anything else could find an object's own keys, such as constructor.
    const kind = body?.as === 'read' || body?.as === 'remembered' ? REVIEW_KINDS[body.as as 'read' | 'remembered'] : null;
    if (!kind) return c.json({ error: 'as must be read or remembered' }, 400);
    const id = parsePhraseId(c.req.param('id'));
    if (id === null || !(await markReviewed(db, user.id, id, true))) return c.json({ error: say(c).phraseNotFound }, 404);
    const day = await userDay(user.id);
    await forgetActivity(db, user.id, day, [...Object.values(REVIEW_KINDS)], id); // One answer a day: the latest.
    await recordActivity(db, user.id, day, kind, id);
    return c.body(null, 204);
  });

  // Undoing the swipe: back on Today, and today's answer forgotten.
  app.delete('/api/phrases/:id/review', requireUser, async (c) => {
    const user = c.get('user');
    const id = parsePhraseId(c.req.param('id'));
    if (id === null || !(await markReviewed(db, user.id, id, false))) return c.json({ error: say(c).phraseNotFound }, 404);
    await forgetActivity(db, user.id, await userDay(user.id), [...Object.values(REVIEW_KINDS)], id);
    return c.body(null, 204);
  });

  app.post('/api/phrases', requireUser, async (c) => {
    const body = await c.req.json().catch(() => null);
    const text = phraseTextOf(body);
    if (!text) return c.json({ error: say(c).invalidText }, 400);
    // Optional. A suggested phrase comes with its Spanish, so translating it later is free.
    const translation = body.translation ?? null;
    if (translation !== null && (typeof translation !== 'string' || translation.length > MAX_TRANSLATION_LENGTH)) {
      return c.json({ error: say(c).invalidTranslation }, 400);
    }

    return c.json(await addPhrase(db, c.get('user').id, text, translation?.trim() || null), 201);
  });

  // Another user's phrase gets the same 404 as a missing one, so ids reveal nothing.
  app.patch('/api/phrases/:id', requireUser, async (c) => {
    const id = parsePhraseId(c.req.param('id'));
    if (id === null) return c.json({ error: say(c).phraseNotFound }, 404);

    const text = await readPhraseText(c);
    if (!text) return c.json({ error: say(c).invalidText }, 400);

    const phrase = await updatePhrase(db, c.get('user').id, id, text);
    return phrase ? c.json(phrase) : c.json({ error: say(c).phraseNotFound }, 404);
  });

  app.delete('/api/phrases/:id', requireUser, async (c) => {
    const id = parsePhraseId(c.req.param('id'));
    if (id === null || !(await deletePhrase(db, c.get('user').id, id))) return c.json({ error: say(c).phraseNotFound }, 404);

    return c.body(null, 204);
  });

  // Translated on the first request, then served from the database.
  app.get('/api/phrases/:id/translation', requireUser, async (c) => {
    const userId = c.get('user').id;
    const id = parsePhraseId(c.req.param('id'));
    const phrase = id === null ? null : await findPhraseTranslation(db, userId, id);
    if (id === null || !phrase) return c.json({ error: say(c).phraseNotFound }, 404);
    if (phrase.translation) return c.json({ translation: phrase.translation });
    if (!translate) return c.json({ error: say(c).translationUnavailable }, 503);

    // Only new translations count toward the daily limit; saved ones above are free.
    const day = await reserve(c.get('user'), 'translations');
    if (!day) return c.json({ error: say(c).translationLimit(translationsPerDay) }, 429);

    let translation: string;
    try {
      translation = await translate(phrase.text);
    } catch (error) {
      await releaseDailyUse(db, userId, 'translations', day);
      console.error('Translation failed:', error);
      return c.json({ error: say(c).translationFailed }, 502);
    }
    await saveTranslation(db, userId, id, phrase.text, translation);
    return c.json({ translation });
  });

  // A formal and an informal way to say a new phrase in English. Nothing is saved
  // until the user picks one, which the app then saves as a phrase.
  app.post('/api/suggestions', requireUser, async (c) => {
    const body = await c.req.json().catch(() => null);
    const text = phraseTextOf(body);
    const m = say(c);
    if (!text) return c.json({ error: m.invalidText }, 400);
    // Optional: who it's for, where, or what it's about, so the options fit the situation.
    const context = body.context ?? '';
    if (typeof context !== 'string' || context.length > MAX_CONTEXT_LENGTH) return c.json({ error: m.invalidContext }, 400);
    if (!suggest) return c.json({ error: m.suggestionsUnavailable }, 503);

    const user = c.get('user');
    const day = await reserve(user, 'suggestions');
    if (!day) return c.json({ error: m.suggestionLimit(suggestionsPerDay) }, 429);

    try {
      return c.json(await suggest(text, context.trim() || undefined));
    } catch (error) {
      await releaseDailyUse(db, user.id, 'suggestions', day);
      console.error('Suggestions failed:', error);
      return c.json({ error: m.suggestionsFailed }, 502);
    }
  });

  // The user says the phrase aloud and gets a score from 1 to 10, the phrase's words
  // marked as heard or not, and a tip. The score is saved with the phrase; the
  // recording is only passed on to be heard, and never kept.
  app.post(
    '/api/phrases/:id/pronunciation',
    requireUser,
    bodyLimit({ maxSize: MAX_RECORDING_BYTES, onError: (c) => c.json({ error: say(c).recordingTooLong }, 413) }),
    async (c) => {
      const user = c.get('user');
      const m = say(c);
      const id = parsePhraseId(c.req.param('id'));
      const phrase = id === null ? null : await findPhraseTranslation(db, user.id, id);
      if (id === null || !phrase) return c.json({ error: m.phraseNotFound }, 404);

      const type = recordingType(c.req.header('content-type'));
      const bytes = type ? await c.req.arrayBuffer() : null;
      if (!type || !bytes || bytes.byteLength === 0) return c.json({ error: m.invalidRecording }, 400);
      if (!pronounce) return c.json({ error: m.pronunciationUnavailable }, 503);

      const day = await reserve(user, 'pronunciations');
      if (!day) return c.json({ error: m.pronunciationLimit(pronunciationsPerDay) }, 429);

      let result: Pronunciation;
      try {
        result = await pronounce(phrase.text, { bytes, type }, languageFrom(c.req.header('accept-language')));
      } catch (error) {
        await releaseDailyUse(db, user.id, 'pronunciations', day);
        if (error instanceof NoSpeechError) return c.json({ error: m.noSpeech }, 422);
        if (error instanceof NoAudioError) {
          // Its size and type tell a dead microphone from a format Whisper can't read.
          console.warn(`Recording without audio: ${type}, ${bytes.byteLength} bytes`);
          return c.json({ error: m.noAudio }, 422);
        }
        console.error('Pronunciation failed:', error);
        return c.json({ error: m.pronunciationFailed }, 502);
      }
      await saveScore(db, user.id, id, phrase.text, result.score);
      await recordActivity(db, user.id, day, 'phrase_scored', id);
      return c.json(result);
    },
  );

  // The app reports what the user did, to tell whether the reminders help. Each kind
  // counts once a day, or once a day per phrase, however often it's sent.
  app.post('/api/activity', requireUser, async (c) => {
    const body = await c.req.json().catch(() => null);
    const kind = body?.kind;
    const user = c.get('user');
    if (DAY_ACTIVITY.has(kind)) {
      if (body.phraseId !== undefined) return c.json({ error: 'This kind of activity has no phrase' }, 400);
      await recordActivity(db, user.id, await userDay(user.id), kind);
      return c.body(null, 204);
    }
    if (!PHRASE_ACTIVITY.has(kind)) return c.json({ error: 'Unknown kind of activity' }, 400);
    const id = typeof body.phraseId === 'number' ? parsePhraseId(String(body.phraseId)) : null;
    if (id === null || !(await findPhraseTranslation(db, user.id, id))) return c.json({ error: say(c).phraseNotFound }, 404);
    await recordActivity(db, user.id, await userDay(user.id), kind, id);
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
