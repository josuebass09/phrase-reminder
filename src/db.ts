import pg from 'pg';
import type { Language } from './messages.js';

export const MAX_PHRASE_LENGTH = 500;
/** A Spanish translation can run longer than its English phrase. */
export const MAX_TRANSLATION_LENGTH = 1000;

export interface Db {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

export interface User {
  id: number;
  email: string;
  /** Admins can invite people. The first user is the admin. */
  isAdmin: boolean;
}

export interface UserWithPassword extends User {
  passwordHash: string;
}

/** A user's reminder settings, chosen in the app. */
export interface ReminderSettings {
  remindersOn: boolean;
  /** Local time of day, as HH:MM in 24-hour time. */
  reminderTime: string;
  /** IANA time zone, such as America/Costa_Rica, taken from the user's device. */
  timeZone: string;
  phrasesPerDay: number;
  /** The app's language, which the reminders use too. Null until the app saves the device's. */
  language: Language | null;
}

export const DEFAULT_SETTINGS: ReminderSettings = {
  remindersOn: true,
  reminderTime: '12:00',
  timeZone: 'America/Costa_Rica',
  phrasesPerDay: 3,
  language: null,
};

/** A user who may be due a reminder: reminders on, and at least one device. */
export interface ReminderCandidate extends ReminderSettings {
  userId: number;
  /** The local day of the last reminder sent, as YYYY-MM-DD, or null. */
  lastReminderDay: string | null;
}

export interface UserSummary extends User {
  phrases: number;
  devices: number;
}

export interface Phrase {
  id: number;
  text: string;
  createdAt: Date;
  /** The Spanish translation, once someone has asked for it, or null. */
  translation: string | null;
  /** The score of the last time the user said it aloud, from 1 to 10, or null if never. */
  lastScore: number | null;
  /** When spaced repetition has it come back, or null until the user first answers it on Today. */
  dueAt: Date | null;
}

export interface DeviceSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
}

const PHRASE_COLUMNS =
  'id, text, created_at AS "createdAt", translation_es AS "translation", last_score AS "lastScore", due_at AS "dueAt"';
const USER_COLUMNS = 'id, email, is_admin AS "isAdmin"';
const SETTINGS_COLUMNS =
  'reminders_on AS "remindersOn", reminder_time AS "reminderTime", time_zone AS "timeZone", phrases_per_day AS "phrasesPerDay", language';

export function connect(connectionString: string): Db & { end(): Promise<void> } {
  // Timeouts matter for the cron job: a hung run makes Railway skip the next one.
  const pool = new pg.Pool({
    connectionString,
    connectionTimeoutMillis: 10_000,
    query_timeout: 30_000,
  });
  return {
    query: (sql, params) => pool.query(sql, params as any[]),
    end: () => pool.end(),
  };
}

export async function ensureSchema(db: Db): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id            SERIAL PRIMARY KEY,
      email         TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await db.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT false');
  // Admins came after accounts. If there is none, the oldest user becomes one.
  await db.query(`
    UPDATE users SET is_admin = true
    WHERE id = (SELECT min(id) FROM users) AND NOT EXISTS (SELECT 1 FROM users WHERE is_admin)
  `);
  // Reminder settings, chosen in the app. The defaults match the single daily reminder from before.
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS reminders_on BOOLEAN NOT NULL DEFAULT ${DEFAULT_SETTINGS.remindersOn}`);
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS reminder_time TEXT NOT NULL DEFAULT '${DEFAULT_SETTINGS.reminderTime}'`);
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS time_zone TEXT NOT NULL DEFAULT '${DEFAULT_SETTINGS.timeZone}'`);
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS phrases_per_day INTEGER NOT NULL DEFAULT ${DEFAULT_SETTINGS.phrasesPerDay}`);
  // The app's language, chosen in the app; the reminders use it too.
  await db.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS language TEXT');
  // The user's local day of the last reminder sent, so each day gets one.
  await db.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS last_reminder_day TEXT');
  // New translations used on the user's local day, for the daily limit.
  await db.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS translations_day TEXT');
  await db.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS translations_used INTEGER NOT NULL DEFAULT 0');
  // The same for suggestions of how to say a phrase, which have their own limit.
  await db.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS suggestions_day TEXT');
  await db.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS suggestions_used INTEGER NOT NULL DEFAULT 0');
  // And for scoring how the user says a phrase aloud.
  await db.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS pronunciations_day TEXT');
  await db.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS pronunciations_used INTEGER NOT NULL DEFAULT 0');
  // Only a hash of each code is kept, so reading the table doesn't give working invites.
  await db.query(`
    CREATE TABLE IF NOT EXISTS invites (
      id         SERIAL PRIMARY KEY,
      code_hash  TEXT NOT NULL UNIQUE,
      created_by INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ NOT NULL,
      used_by    INTEGER REFERENCES users (id) ON DELETE SET NULL,
      used_at    TIMESTAMPTZ
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS phrases (
      id            SERIAL PRIMARY KEY,
      text          TEXT NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_shown_at TIMESTAMPTZ
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      endpoint   TEXT PRIMARY KEY,
      p256dh     TEXT NOT NULL,
      auth       TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  // Owners came after the first deploy. Rows saved before then have none, and stay
  // hidden until a user claims them (see claimUnowned).
  await db.query(
    'ALTER TABLE phrases ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users (id) ON DELETE CASCADE',
  );
  await db.query(
    'ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users (id) ON DELETE CASCADE',
  );
  await db.query('CREATE INDEX IF NOT EXISTS phrases_user_id_created_at ON phrases (user_id, created_at)');
  // The Spanish translation, saved the first time someone asks, so each phrase is translated once.
  await db.query('ALTER TABLE phrases ADD COLUMN IF NOT EXISTS translation_es TEXT');
  await db.query('CREATE INDEX IF NOT EXISTS push_subscriptions_user_id ON push_subscriptions (user_id)');
  // The score, from 1 to 10, of the last time the user said the phrase aloud. The recording isn't kept.
  await db.query('ALTER TABLE phrases ADD COLUMN IF NOT EXISTS last_score SMALLINT');
  // When the user last swiped the phrase away from Today as read or remembered. It comes back
  // when a later reminder sends it again, since that sets a newer last_shown_at.
  await db.query('ALTER TABLE phrases ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ');
  // Spaced repetition: the phrase's box (null until first answered, 0 after "read", 1 to 4 for
  // remembered that many times running) and when it's due again. Undo puts back the previous pair.
  await db.query('ALTER TABLE phrases ADD COLUMN IF NOT EXISTS box SMALLINT');
  await db.query('ALTER TABLE phrases ADD COLUMN IF NOT EXISTS due_at TIMESTAMPTZ');
  await db.query('ALTER TABLE phrases ADD COLUMN IF NOT EXISTS undo_box SMALLINT');
  await db.query('ALTER TABLE phrases ADD COLUMN IF NOT EXISTS undo_due_at TIMESTAMPTZ');
  // One row per login, kept while the app uses it (see auth.ts). Only hashes of refresh
  // tokens are kept; the one each refresh replaced stays a while to notice it coming back.
  await db.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      id            SERIAL PRIMARY KEY,
      user_id       INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
      token_hash    TEXT NOT NULL UNIQUE,
      previous_hash TEXT,
      rotated_at    TIMESTAMPTZ,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at    TIMESTAMPTZ NOT NULL
    )
  `);
  await db.query('CREATE INDEX IF NOT EXISTS sessions_user_id ON sessions (user_id)');
  await db.query('CREATE INDEX IF NOT EXISTS sessions_previous_hash ON sessions (previous_hash)');
  // What each user did on each of their local days, to tell whether the reminders help:
  // one row per kind a day, and per phrase for the phrase ones. No text or audio is kept.
  // phrase_id has no foreign key, so a deleted phrase still counts in the days it was practiced.
  await db.query(`
    CREATE TABLE IF NOT EXISTS activity (
      user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
      day        TEXT NOT NULL,
      kind       TEXT NOT NULL,
      phrase_id  INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  // Two partial indexes, since a unique index counts NULLs as different from each other.
  await db.query('CREATE UNIQUE INDEX IF NOT EXISTS activity_daily ON activity (user_id, day, kind) WHERE phrase_id IS NULL');
  await db.query(
    'CREATE UNIQUE INDEX IF NOT EXISTS activity_daily_phrase ON activity (user_id, day, kind, phrase_id) WHERE phrase_id IS NOT NULL',
  );

  // Each UTC day's requests to each AI service, for the whole account: the free plans' daily
  // limits are shared by every user, so these show how close the app runs to them.
  // units: tokens for Groq's chat, seconds of audio for its speech model, characters for MyMemory.
  await db.query(`
    CREATE TABLE IF NOT EXISTS ai_usage (
      day          DATE NOT NULL,
      service      TEXT NOT NULL,
      calls        INTEGER NOT NULL DEFAULT 0,
      failures     INTEGER NOT NULL DEFAULT 0,
      rate_limited INTEGER NOT NULL DEFAULT 0,
      units        INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, service)
    )
  `);
  // Each run of the reminder cron, for the admin to see it's running and delivering. Kept 30 days.
  await db.query(`
    CREATE TABLE IF NOT EXISTS cron_runs (
      id          SERIAL PRIMARY KEY,
      started_at  TIMESTAMPTZ NOT NULL,
      finished_at TIMESTAMPTZ NOT NULL,
      users       INTEGER NOT NULL DEFAULT 0,
      devices     INTEGER NOT NULL DEFAULT 0,
      delivered   INTEGER NOT NULL DEFAULT 0,
      removed     INTEGER NOT NULL DEFAULT 0,
      errors      INTEGER NOT NULL DEFAULT 0,
      first_error TEXT,
      version     TEXT
    )
  `);
  await db.query('CREATE INDEX IF NOT EXISTS cron_runs_started_at ON cron_runs (started_at)');

  // What Groq last said about each model's daily requests, from its rate-limit headers.
  await db.query(`
    CREATE TABLE IF NOT EXISTS ai_quota (
      service        TEXT PRIMARY KEY,
      requests_limit INTEGER NOT NULL,
      requests_left  INTEGER NOT NULL,
      checked_at     TIMESTAMPTZ NOT NULL
    )
  `);
}

/** Emails are compared trimmed and lowercased, so "Me@Example.com " finds me@example.com. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** A loose check: something@something.tld with no spaces, at most 254 characters. */
export function isValidEmail(email: string): boolean {
  const normalized = normalizeEmail(email);
  return normalized.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized);
}

/** The first user becomes the admin. */
export async function createUser(db: Db, email: string, passwordHash: string): Promise<User> {
  const { rows } = await db.query(
    `INSERT INTO users (email, password_hash, is_admin)
     VALUES ($1, $2, NOT EXISTS (SELECT 1 FROM users))
     RETURNING ${USER_COLUMNS}`,
    [normalizeEmail(email), passwordHash],
  );
  return rows[0];
}

export async function findUser(db: Db, id: number): Promise<User | null> {
  const { rows } = await db.query(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

export async function findUserByEmail(db: Db, email: string): Promise<UserWithPassword | null> {
  const { rows } = await db.query(
    `SELECT ${USER_COLUMNS}, password_hash AS "passwordHash" FROM users WHERE email = $1`,
    [normalizeEmail(email)],
  );
  return rows[0] ?? null;
}

/** Returns false if no user had that id. */
export async function setPasswordHash(db: Db, id: number, passwordHash: string): Promise<boolean> {
  const { rows } = await db.query('UPDATE users SET password_hash = $2 WHERE id = $1 RETURNING id', [
    id,
    passwordHash,
  ]);
  return rows.length > 0;
}

export async function listUsers(db: Db): Promise<UserSummary[]> {
  const { rows } = await db.query(`
    SELECT u.id, u.email, u.is_admin AS "isAdmin",
      (SELECT count(*)::int FROM phrases p WHERE p.user_id = u.id) AS phrases,
      (SELECT count(*)::int FROM push_subscriptions s WHERE s.user_id = u.id) AS devices
    FROM users u
    ORDER BY u.id
  `);
  return rows;
}

/** Saves an invite by the hash of its code. It works once, until it expires. */
export async function createInvite(
  db: Db,
  createdBy: number,
  codeHash: string,
  lifetimeDays: number,
): Promise<{ expiresAt: Date }> {
  const { rows } = await db.query(
    `INSERT INTO invites (code_hash, created_by, expires_at)
     VALUES ($1, $2, now() + make_interval(days => $3))
     RETURNING expires_at AS "expiresAt"`,
    [codeHash, createdBy, lifetimeDays],
  );
  return rows[0];
}

/** Whether an invite with this code hash exists, is unused, and hasn't expired. */
export async function isInviteUsable(db: Db, codeHash: string): Promise<boolean> {
  const { rows } = await db.query(
    'SELECT 1 FROM invites WHERE code_hash = $1 AND used_at IS NULL AND expires_at > now()',
    [codeHash],
  );
  return rows.length > 0;
}

/**
 * Marks a usable invite as used and returns its id, or null if it isn't usable.
 * Doing both in one statement means two sign-ups can't share one invite.
 */
export async function claimInvite(db: Db, codeHash: string): Promise<number | null> {
  const { rows } = await db.query(
    `UPDATE invites SET used_at = now()
     WHERE code_hash = $1 AND used_at IS NULL AND expires_at > now()
     RETURNING id`,
    [codeHash],
  );
  return rows[0]?.id ?? null;
}

/** Records who used a claimed invite, or frees it again for null, if the sign-up failed. */
export async function finishInvite(db: Db, id: number, userId: number | null): Promise<void> {
  await db.query(
    userId === null
      ? 'UPDATE invites SET used_at = NULL, used_by = NULL WHERE id = $1'
      : 'UPDATE invites SET used_by = $2 WHERE id = $1',
    userId === null ? [id] : [id, userId],
  );
}

/** A session lasts this long after the app last renewed it, so only one unused this long logs out. */
export const SESSION_LIFETIME_DAYS = 60;

/** Opens a session for a login, and clears the user's ones that ran out. */
export async function createSession(db: Db, userId: number, tokenHash: string): Promise<number> {
  await db.query('DELETE FROM sessions WHERE user_id = $1 AND expires_at <= now()', [userId]);
  const { rows } = await db.query(
    `INSERT INTO sessions (user_id, token_hash, expires_at)
     VALUES ($1, $2, now() + make_interval(days => $3))
     RETURNING id`,
    [userId, tokenHash, SESSION_LIFETIME_DAYS],
  );
  return rows[0].id;
}

/**
 * Swaps a session's refresh token for a new one and pushes back its end, in one
 * statement, so the same token can't renew it twice. Returns the session, or null
 * if no live session has that token.
 */
export async function rotateSession(
  db: Db,
  tokenHash: string,
  newTokenHash: string,
): Promise<{ id: number; userId: number } | null> {
  const { rows } = await db.query(
    `UPDATE sessions
     SET previous_hash = token_hash, token_hash = $2, rotated_at = now(),
         expires_at = now() + make_interval(days => $3)
     WHERE token_hash = $1 AND expires_at > now()
     RETURNING id, user_id AS "userId"`,
    [tokenHash, newTokenHash, SESSION_LIFETIME_DAYS],
  );
  return rows[0] ?? null;
}

/**
 * Ends the session whose refresh token was already replaced, if it comes back more
 * than a minute later: someone else may have a copy. Within the minute, it's more
 * likely two of the app's windows renewing at once, and the session stays.
 */
export async function endSessionIfReused(db: Db, tokenHash: string): Promise<void> {
  await db.query(
    "DELETE FROM sessions WHERE previous_hash = $1 AND rotated_at < now() - interval '1 minute'",
    [tokenHash],
  );
}

export async function endSessionByToken(db: Db, tokenHash: string): Promise<void> {
  await db.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash]);
}

/** Logs the user out of every device. Returns how many sessions ended. */
export async function endUserSessions(db: Db, userId: number): Promise<number> {
  const { rows } = await db.query('DELETE FROM sessions WHERE user_id = $1 RETURNING id', [userId]);
  return rows.length;
}

/** Logs everyone out. Returns how many sessions ended. */
export async function endAllSessions(db: Db): Promise<number> {
  const { rows } = await db.query('DELETE FROM sessions RETURNING id');
  return rows.length;
}

/** The user, if that session is theirs and still open. */
export async function findUserInSession(db: Db, userId: number, sessionId: number): Promise<User | null> {
  const { rows } = await db.query(
    `SELECT u.id, u.email, u.is_admin AS "isAdmin"
     FROM users u JOIN sessions s ON s.user_id = u.id
     WHERE u.id = $1 AND s.id = $2 AND s.expires_at > now()`,
    [userId, sessionId],
  );
  return rows[0] ?? null;
}

export async function getSettings(db: Db, userId: number): Promise<ReminderSettings | null> {
  const { rows } = await db.query(`SELECT ${SETTINGS_COLUMNS} FROM users WHERE id = $1`, [userId]);
  return rows[0] ?? null;
}

/** Saves the given settings, leaving the others as they are, and returns them all. */
export async function updateSettings(
  db: Db,
  userId: number,
  changes: Partial<ReminderSettings>,
): Promise<ReminderSettings | null> {
  const columns: Record<keyof ReminderSettings, string> = {
    remindersOn: 'reminders_on',
    reminderTime: 'reminder_time',
    timeZone: 'time_zone',
    phrasesPerDay: 'phrases_per_day',
    language: 'language',
  };
  const entries = (Object.keys(columns) as (keyof ReminderSettings)[]).filter((key) => changes[key] !== undefined);
  if (entries.length === 0) return getSettings(db, userId);
  const assignments = entries.map((key, i) => `${columns[key]} = $${i + 2}`).join(', ');
  const { rows } = await db.query(
    `UPDATE users SET ${assignments} WHERE id = $1 RETURNING ${SETTINGS_COLUMNS}`,
    [userId, ...entries.map((key) => changes[key])],
  );
  return rows[0] ?? null;
}

/** Users with reminders on and at least one device, with what's needed to tell if one is due. */
export async function listReminderCandidates(db: Db): Promise<ReminderCandidate[]> {
  const { rows } = await db.query(`
    SELECT id AS "userId", ${SETTINGS_COLUMNS}, last_reminder_day AS "lastReminderDay"
    FROM users u
    WHERE reminders_on AND EXISTS (SELECT 1 FROM push_subscriptions s WHERE s.user_id = u.id)
    ORDER BY id
  `);
  return rows;
}

/**
 * What gets recorded about a user's day. The backend records reminder_sent and phrase_scored
 * itself; the app reports the rest (see PHRASE_ACTIVITY and DAY_ACTIVITY in app.ts).
 */
export type ActivityKind =
  | 'reminder_sent'
  | 'reminder_opened'
  | 'today_viewed'
  | 'phrase_heard'
  | 'phrase_translated'
  | 'phrase_scored'
  /** Swiped away from Today: just read, or remembered. */
  | 'phrase_read'
  | 'phrase_remembered';

/** Records that the user did this on their local day. Doing it again the same day changes nothing. */
export async function recordActivity(
  db: Db,
  userId: number,
  day: string,
  kind: ActivityKind,
  phraseId: number | null = null,
): Promise<void> {
  await db.query(
    'INSERT INTO activity (user_id, day, kind, phrase_id) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
    [userId, day, kind, phraseId],
  );
}

/** One user's week, from Monday: days with each thing, and the phrases they practiced. */
export interface WeekActivity {
  email: string;
  /** The Monday, as YYYY-MM-DD. */
  week: string;
  remindersSent: number;
  remindersOpened: number;
  todayViewed: number;
  /** Different phrases heard, translated, or said aloud. */
  phrasesPracticed: number;
  /** Phrases the user swiped away from Today as remembered, rather than just read. */
  phrasesRemembered: number;
}

/** Each user's activity for the weeks that began within the last `weeks` weeks, oldest first. */
export async function weeklyActivity(db: Db, weeks: number): Promise<WeekActivity[]> {
  const { rows } = await db.query(
    `SELECT u.email,
       to_char(date_trunc('week', a.day::date), 'YYYY-MM-DD') AS week,
       (count(DISTINCT a.day) FILTER (WHERE a.kind = 'reminder_sent'))::int AS "remindersSent",
       (count(DISTINCT a.day) FILTER (WHERE a.kind = 'reminder_opened'))::int AS "remindersOpened",
       (count(DISTINCT a.day) FILTER (WHERE a.kind = 'today_viewed'))::int AS "todayViewed",
       (count(DISTINCT a.phrase_id) FILTER (WHERE a.kind IN
         ('phrase_heard', 'phrase_translated', 'phrase_scored', 'phrase_read', 'phrase_remembered')))::int
         AS "phrasesPracticed",
       (count(DISTINCT a.phrase_id) FILTER (WHERE a.kind = 'phrase_remembered'))::int AS "phrasesRemembered"
     FROM activity a JOIN users u ON u.id = a.user_id
     WHERE date_trunc('week', a.day::date) > date_trunc('week', current_date) - make_interval(weeks => $1)
     GROUP BY u.email, week
     ORDER BY u.email, week`,
    [weeks],
  );
  return rows;
}

/** What each user may do only so many times a day: new translations, suggestions, and pronunciation scores. */
export type DailyCounter = 'translations' | 'suggestions' | 'pronunciations';

// Fixed column names, never user input, so they can go into the SQL.
const COUNTER_COLUMNS: Record<DailyCounter, { day: string; used: string }> = {
  translations: { day: 'translations_day', used: 'translations_used' },
  suggestions: { day: 'suggestions_day', used: 'suggestions_used' },
  pronunciations: { day: 'pronunciations_day', used: 'pronunciations_used' },
};

/**
 * Counts one use for the user on their local day, unless that would pass the
 * limit. Returns false if they've reached it. A new day starts the count over.
 */
export async function reserveDailyUse(
  db: Db,
  userId: number,
  counter: DailyCounter,
  day: string,
  limit: number,
): Promise<boolean> {
  const { day: dayColumn, used } = COUNTER_COLUMNS[counter];
  const { rows } = await db.query(
    `UPDATE users
     SET ${used} = CASE WHEN ${dayColumn} = $2 THEN ${used} + 1 ELSE 1 END,
         ${dayColumn} = $2
     WHERE id = $1 AND (${dayColumn} IS DISTINCT FROM $2 OR ${used} < $3)
     RETURNING id`,
    [userId, day, limit],
  );
  return rows.length > 0;
}

/** Gives back a reserved use that didn't happen, such as when the service failed. */
export async function releaseDailyUse(db: Db, userId: number, counter: DailyCounter, day: string): Promise<void> {
  const { day: dayColumn, used } = COUNTER_COLUMNS[counter];
  await db.query(`UPDATE users SET ${used} = GREATEST(${used} - 1, 0) WHERE id = $1 AND ${dayColumn} = $2`, [
    userId,
    day,
  ]);
}

/** Uses the user has had on their local day. */
export async function dailyUses(db: Db, userId: number, counter: DailyCounter, day: string): Promise<number> {
  const { day: dayColumn, used } = COUNTER_COLUMNS[counter];
  const { rows } = await db.query(
    `SELECT CASE WHEN ${dayColumn} = $2 THEN ${used} ELSE 0 END AS used FROM users WHERE id = $1`,
    [userId, day],
  );
  return rows[0]?.used ?? 0;
}

export async function setLastReminderDay(db: Db, userId: number, day: string): Promise<void> {
  await db.query('UPDATE users SET last_reminder_day = $2 WHERE id = $1', [userId, day]);
}

/** Gives a user the phrases and devices saved before accounts existed. */
export async function claimUnowned(db: Db, userId: number): Promise<{ phrases: number; devices: number }> {
  const phrases = await db.query('UPDATE phrases SET user_id = $1 WHERE user_id IS NULL RETURNING id', [userId]);
  const devices = await db.query(
    'UPDATE push_subscriptions SET user_id = $1 WHERE user_id IS NULL RETURNING endpoint',
    [userId],
  );
  return { phrases: phrases.rows.length, devices: devices.rows.length };
}

/** A device belongs to whoever subscribed it last, so a shared device follows the user logged in on it. */
export async function saveSubscription(db: Db, userId: number, subscription: DeviceSubscription): Promise<void> {
  await db.query(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (endpoint) DO UPDATE
       SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth`,
    [userId, subscription.endpoint, subscription.p256dh, subscription.auth],
  );
}

export async function listSubscriptions(db: Db, userId: number): Promise<DeviceSubscription[]> {
  const { rows } = await db.query(
    'SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1 ORDER BY created_at, endpoint',
    [userId],
  );
  return rows;
}

export async function deleteSubscription(db: Db, endpoint: string): Promise<void> {
  await db.query('DELETE FROM push_subscriptions WHERE endpoint = $1', [endpoint]);
}

/** The translation is optional: a suggested phrase comes with its Spanish already. */
export async function addPhrase(db: Db, userId: number, text: string, translation: string | null = null): Promise<Phrase> {
  const { rows } = await db.query(
    `INSERT INTO phrases (user_id, text, translation_es) VALUES ($1, $2, $3) RETURNING ${PHRASE_COLUMNS}`,
    [userId, text, translation],
  );
  return rows[0];
}

/**
 * Changes a phrase's text. Its dates stay as they are, so fixing a typo doesn't
 * reset its 14-day wait or its place in the reminder queue. A new text drops the
 * saved translation and the last score, which were for the old one. Returns null
 * if the user has no phrase with that id.
 */
export async function updatePhrase(db: Db, userId: number, id: number, text: string): Promise<Phrase | null> {
  const { rows } = await db.query(
    `UPDATE phrases
     SET text = $3,
         translation_es = CASE WHEN text = $3 THEN translation_es END,
         last_score = CASE WHEN text = $3 THEN last_score END,
         -- New words start their spacing over.
         box = CASE WHEN text = $3 THEN box END,
         due_at = CASE WHEN text = $3 THEN due_at END
     WHERE id = $2 AND user_id = $1
     RETURNING ${PHRASE_COLUMNS}`,
    [userId, id, text],
  );
  return rows[0] ?? null;
}

/** A phrase's text and saved translation, or null if the user has no phrase with that id. */
export async function findPhraseTranslation(
  db: Db,
  userId: number,
  id: number,
): Promise<{ text: string; translation: string | null } | null> {
  const { rows } = await db.query(
    'SELECT text, translation_es AS translation FROM phrases WHERE id = $2 AND user_id = $1',
    [userId, id],
  );
  return rows[0] ?? null;
}

/** Saves a translation, unless the phrase's text changed while it was being translated. */
export async function saveTranslation(
  db: Db,
  userId: number,
  id: number,
  text: string,
  translation: string,
): Promise<void> {
  await db.query('UPDATE phrases SET translation_es = $4 WHERE id = $2 AND user_id = $1 AND text = $3', [
    userId,
    id,
    text,
    translation,
  ]);
}

/** Saves the score of saying a phrase aloud, unless its text changed while it was being scored. */
export async function saveScore(db: Db, userId: number, id: number, text: string, score: number): Promise<void> {
  await db.query('UPDATE phrases SET last_score = $4 WHERE id = $2 AND user_id = $1 AND text = $3', [
    userId,
    id,
    text,
    score,
  ]);
}

/** Returns false if the user had no phrase with that id. */
export async function deletePhrase(db: Db, userId: number, id: number): Promise<boolean> {
  const { rows } = await db.query('DELETE FROM phrases WHERE id = $2 AND user_id = $1 RETURNING id', [
    userId,
    id,
  ]);
  return rows.length > 0;
}

export interface PhraseQuery {
  /** Only phrases whose text or Spanish has this, ignoring case. */
  search?: string;
  /** Only phrases saved before this one, to load the next page after it. */
  before?: number;
  limit?: number;
}

/** Turns text into a LIKE pattern that finds it anywhere, with LIKE's own characters taken literally. */
function containing(text: string): string {
  return `%${text.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

/** The user's phrases, newest first: all of them a page at a time, or those that match a search. */
export async function listRecent(db: Db, userId: number, { search, before, limit = 50 }: PhraseQuery = {}): Promise<Phrase[]> {
  const { rows } = await db.query(
    `SELECT ${PHRASE_COLUMNS} FROM phrases
     WHERE user_id = $1
       AND ($3::text IS NULL OR text ILIKE $3 OR translation_es ILIKE $3)
       AND ($4::int IS NULL OR (created_at, id) < (SELECT created_at, id FROM phrases WHERE id = $4 AND user_id = $1))
     ORDER BY created_at DESC, id DESC
     LIMIT $2`,
    [userId, limit, search ? containing(search) : null, before ?? null],
  );
  return rows;
}

/**
 * Phrases at least 14 days old that are due: first those spaced repetition has scheduled and
 * are due now, the longest overdue first; then the ones never answered, never-shown first and
 * then longest since shown. A scheduled phrase that isn't due yet waits for its day.
 */
export async function pickDailyPhrases(db: Db, userId: number, limit = 3): Promise<Phrase[]> {
  const { rows } = await db.query(
    `SELECT ${PHRASE_COLUMNS}
     FROM phrases
     WHERE user_id = $1 AND created_at <= now() - interval '14 days'
       AND (due_at IS NULL OR due_at <= now())
     ORDER BY due_at IS NULL, due_at ASC, last_shown_at ASC NULLS FIRST, random()
     LIMIT $2`,
    [userId, limit],
  );
  return rows;
}

/**
 * The user's latest reminder batch, if it went out in the last 24 hours. One
 * markShown call gives its whole batch the same last_shown_at, which identifies the batch.
 */
export async function listToday(db: Db, userId: number): Promise<Phrase[]> {
  const { rows } = await db.query(
    `SELECT ${PHRASE_COLUMNS}
     FROM phrases
     WHERE user_id = $1
       AND last_shown_at = (SELECT max(last_shown_at) FROM phrases WHERE user_id = $1)
       AND last_shown_at > now() - interval '24 hours'
       AND (reviewed_at IS NULL OR reviewed_at < last_shown_at)
     ORDER BY id`,
    [userId],
  );
  return rows;
}

/**
 * Marks phrases as sent. A scheduled one comes back with tomorrow's reminder unless it's answered,
 * behind any due longer, so one left unanswered doesn't take every day's place.
 */
export async function markShown(db: Db, ids: number[]): Promise<void> {
  await db.query(
    `UPDATE phrases SET last_shown_at = now(),
       due_at = CASE WHEN due_at IS NOT NULL THEN now() + interval '1 day' - ${DUE_EARLY} END
     WHERE id = ANY($1::int[])`,
    [ids],
  );
}

/** Adds phrases backdated 14 days so they are eligible at once. Skips the user's exact duplicates. */
export async function importPhrases(db: Db, userId: number, texts: string[]): Promise<number> {
  let added = 0;
  for (const text of texts) {
    const { rows } = await db.query(
      `INSERT INTO phrases (user_id, text, created_at)
       SELECT $1, $2::text, now() - interval '14 days'
       WHERE NOT EXISTS (SELECT 1 FROM phrases WHERE user_id = $1 AND text = $2::text)
       RETURNING id`,
      [userId, text],
    );
    added += rows.length;
  }
  return added;
}

/** The AI services the backend calls: Groq's chat and speech models, and MyMemory's translations. */
export type AiService = 'groq_chat' | 'groq_speech' | 'mymemory';

export const AI_SERVICES: AiService[] = ['groq_chat', 'groq_speech', 'mymemory'];

/** One request to an AI service, and what it used. */
export interface AiUse {
  service: AiService;
  ok: boolean;
  /** Refused for a rate limit or a used-up daily quota. */
  rateLimited: boolean;
  /** Tokens for a chat answer, seconds of audio heard, or characters translated. */
  units: number;
  /** Groq's daily requests for the model, and how many are left, when it said. */
  quota?: { limit: number; left: number };
}

/** Counts one request on its UTC day, and keeps what Groq said is left of its daily quota. */
export async function recordAiUse(db: Db, use: AiUse, now = new Date()): Promise<void> {
  await db.query(
    `INSERT INTO ai_usage (day, service, calls, failures, rate_limited, units)
     VALUES ($1::date, $2, 1, $3, $4, $5)
     ON CONFLICT (day, service) DO UPDATE SET
       calls = ai_usage.calls + 1,
       failures = ai_usage.failures + EXCLUDED.failures,
       rate_limited = ai_usage.rate_limited + EXCLUDED.rate_limited,
       units = ai_usage.units + EXCLUDED.units`,
    [now.toISOString().slice(0, 10), use.service, use.ok ? 0 : 1, use.rateLimited ? 1 : 0, Math.max(0, Math.round(use.units))],
  );
  if (use.quota) {
    await db.query(
      `INSERT INTO ai_quota (service, requests_limit, requests_left, checked_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (service) DO UPDATE SET
         requests_limit = EXCLUDED.requests_limit, requests_left = EXCLUDED.requests_left, checked_at = EXCLUDED.checked_at`,
      [use.service, use.quota.limit, use.quota.left, now],
    );
  }
}

/** One service's requests on one UTC day. */
export interface AiDay {
  day: string;
  service: AiService;
  calls: number;
  failures: number;
  rateLimited: number;
  units: number;
}

/** Every service's requests on each of the last `days` UTC days, today included, oldest first. Days with none are left out. */
export async function aiUsageSince(db: Db, days: number, now = new Date()): Promise<AiDay[]> {
  const { rows } = await db.query(
    `SELECT to_char(day, 'YYYY-MM-DD') AS day, service, calls, failures, rate_limited AS "rateLimited", units
     FROM ai_usage
     WHERE day > $1::date - $2::int
     ORDER BY day, service`,
    [now.toISOString().slice(0, 10), days],
  );
  return rows;
}

/** What Groq last said is left of each model's daily requests. */
export interface AiQuota {
  service: AiService;
  limit: number;
  left: number;
  checkedAt: Date;
}

export async function aiQuotas(db: Db): Promise<AiQuota[]> {
  const { rows } = await db.query(
    'SELECT service, requests_limit AS "limit", requests_left AS "left", checked_at AS "checkedAt" FROM ai_quota ORDER BY service',
  );
  return rows;
}

/** One run of the reminder cron. */
export interface CronRun {
  startedAt: Date;
  finishedAt: Date;
  /** Users whose reminder went out, devices it went to, and devices that received it. */
  users: number;
  devices: number;
  delivered: number;
  /** Devices whose subscription was gone, and removed. */
  removed: number;
  errors: number;
  /** The first error's message, to tell what went wrong without the logs. */
  firstError: string | null;
  /** The commit the cron ran, from Railway. */
  version: string | null;
}

/** How long cron runs are kept: enough for a month of trends, at 96 runs a day. */
const CRON_RUNS_KEPT_DAYS = 30;

/** Saves a cron run, and drops the ones older than 30 days. */
export async function recordCronRun(db: Db, run: CronRun): Promise<void> {
  await db.query(
    `INSERT INTO cron_runs (started_at, finished_at, users, devices, delivered, removed, errors, first_error, version)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      run.startedAt,
      run.finishedAt,
      run.users,
      run.devices,
      run.delivered,
      run.removed,
      run.errors,
      run.firstError?.slice(0, 500) ?? null,
      run.version,
    ],
  );
  await db.query(`DELETE FROM cron_runs WHERE started_at < $1::timestamptz - interval '${CRON_RUNS_KEPT_DAYS} days'`, [run.startedAt]);
}

/** The cron runs since `since`, newest first. */
export async function cronRunsSince(db: Db, since: Date): Promise<CronRun[]> {
  const { rows } = await db.query(
    `SELECT started_at AS "startedAt", finished_at AS "finishedAt", users, devices, delivered, removed, errors,
       first_error AS "firstError", version
     FROM cron_runs WHERE started_at >= $1 ORDER BY started_at DESC`,
    [since],
  );
  return rows;
}

/** A user as the admin sees them. */
export interface AdminUser {
  id: number;
  email: string;
  isAdmin: boolean;
  createdAt: Date;
  /** The latest thing the user did: a session renewed or opened, a phrase saved, or something practiced. Null if nothing yet. */
  lastActiveAt: Date | null;
  phrases: number;
  /** Devices with reminders turned on. */
  devices: number;
  /** Sessions that haven't expired, one per device logged in. */
  sessions: number;
  remindersOn: boolean;
  timeZone: string;
  /** Each daily counter's day and count, as saved: the count is today's only when its day is the user's today. */
  counters: Record<DailyCounter, { day: string | null; used: number }>;
}

export async function listUsersForAdmin(db: Db): Promise<AdminUser[]> {
  const { rows } = await db.query(`
    SELECT u.id, u.email, u.is_admin AS "isAdmin", u.created_at AS "createdAt",
      u.reminders_on AS "remindersOn", u.time_zone AS "timeZone",
      u.translations_day, u.translations_used, u.suggestions_day, u.suggestions_used,
      u.pronunciations_day, u.pronunciations_used,
      (SELECT count(*)::int FROM phrases p WHERE p.user_id = u.id) AS phrases,
      (SELECT count(*)::int FROM push_subscriptions s WHERE s.user_id = u.id) AS devices,
      (SELECT count(*)::int FROM sessions s WHERE s.user_id = u.id AND s.expires_at > now()) AS sessions,
      -- GREATEST skips NULLs. A reminder sent is the cron's doing, not the user's.
      GREATEST(
        (SELECT max(a.created_at) FROM activity a WHERE a.user_id = u.id AND a.kind <> 'reminder_sent'),
        (SELECT max(COALESCE(s.rotated_at, s.created_at)) FROM sessions s WHERE s.user_id = u.id),
        (SELECT max(p.created_at) FROM phrases p WHERE p.user_id = u.id)
      ) AS "lastActiveAt"
    FROM users u
    ORDER BY u.id
  `);
  return rows.map(({ translations_day, translations_used, suggestions_day, suggestions_used, pronunciations_day, pronunciations_used, ...user }) => ({
    ...user,
    counters: {
      translations: { day: translations_day, used: translations_used },
      suggestions: { day: suggestions_day, used: suggestions_used },
      pronunciations: { day: pronunciations_day, used: pronunciations_used },
    },
  }));
}

/** The tables the admin sees the size of: the ones that grow with use. */
const WATCHED_TABLES = ['phrases', 'activity', 'sessions', 'users', 'push_subscriptions', 'cron_runs', 'ai_usage', 'invites'] as const;

/** The database's size on disk, and each watched table's rows and size, indexes included. */
export async function databaseStats(db: Db): Promise<{ bytes: number; tables: { name: string; rows: number; bytes: number }[] }> {
  const { rows } = await db.query('SELECT pg_database_size(current_database()) AS bytes');
  const tables = [];
  for (const name of WATCHED_TABLES) {
    // Fixed names, never user input, so they can go into the SQL.
    const { rows: [table] } = await db.query(
      `SELECT count(*)::int AS rows, pg_total_relation_size('${name}') AS bytes FROM ${name}`,
    );
    tables.push({ name, rows: table.rows, bytes: Number(table.bytes) });
  }
  return { bytes: Number(rows[0].bytes), tables };
}

/** Reminders delivered on each of the last `days` UTC days, today included, oldest first; days without runs give 0. */
export async function deliveriesByDay(db: Db, days: number, now = new Date()): Promise<{ day: string; delivered: number }[]> {
  const { rows } = await db.query(
    `SELECT to_char(d, 'YYYY-MM-DD') AS day,
       COALESCE((SELECT sum(delivered)::int FROM cron_runs r WHERE (r.started_at AT TIME ZONE 'UTC')::date = d), 0) AS delivered
     FROM generate_series($1::date - ($2::int - 1), $1::date, interval '1 day') AS d
     ORDER BY d`,
    [now.toISOString().slice(0, 10), days],
  );
  return rows;
}

/** Users with daily limits (all but the admin), and the average phrase's length, for the admin's worst-case estimates. */
export async function capacityFacts(db: Db): Promise<{ limitedUsers: number; averagePhraseLength: number; remindersOn: number; devices: number }> {
  const { rows } = await db.query(`
    SELECT
      (SELECT count(*)::int FROM users WHERE NOT is_admin) AS "limitedUsers",
      (SELECT COALESCE(round(avg(length(text))), 0)::int FROM phrases) AS "averagePhraseLength",
      (SELECT count(*)::int FROM users u WHERE u.reminders_on
         AND EXISTS (SELECT 1 FROM push_subscriptions s WHERE s.user_id = u.id)) AS "remindersOn",
      (SELECT count(*)::int FROM push_subscriptions) AS devices
  `);
  return rows[0];
}

/** Days until a phrase comes back, by its box: 2 after "read", then 7, 14, 30, and 60 for each time remembered running. */
export const REVIEW_INTERVAL_DAYS = [2, 7, 14, 30, 60];
const TOP_BOX = REVIEW_INTERVAL_DAYS.length - 1;

/**
 * A phrase is due 12 hours early, so it makes the reminder of the day it's due whatever time
 * that reminder is: answered at 8 p.m., a phrase due in 2 days is in that day's noon reminder.
 */
const DUE_EARLY = "interval '12 hours'";

/**
 * Answers a phrase on Today: "read" puts it in box 0, back in 2 days; "remembered" moves it up a
 * box, back in 7, 14, 30, then 60 days. It's off Today from now, and what it was is kept for undo.
 * Returns its box and the days until it's back, or null if the phrase isn't the user's.
 */
export async function reviewPhrase(
  db: Db,
  userId: number,
  phraseId: number,
  as: 'read' | 'remembered',
): Promise<{ box: number; days: number } | null> {
  const box = `CASE WHEN $3 = 'remembered' THEN LEAST(COALESCE(box, 0) + 1, ${TOP_BOX}) ELSE 0 END`;
  const { rows } = await db.query(
    `UPDATE phrases SET
       undo_box = box,
       undo_due_at = due_at,
       box = ${box},
       due_at = now() + make_interval(days => (ARRAY[${REVIEW_INTERVAL_DAYS.join(', ')}])[${box} + 1]) - ${DUE_EARLY},
       reviewed_at = now()
     WHERE id = $1 AND user_id = $2
     RETURNING box`,
    [phraseId, userId, as],
  );
  if (rows.length === 0) return null;
  return { box: rows[0].box, days: REVIEW_INTERVAL_DAYS[rows[0].box] };
}

/** Undoes reviewPhrase: back on Today, with its box and due date as they were. False if the phrase isn't the user's. */
export async function undoReview(db: Db, userId: number, phraseId: number): Promise<boolean> {
  const { rows } = await db.query(
    `UPDATE phrases SET box = undo_box, due_at = undo_due_at, undo_box = NULL, undo_due_at = NULL, reviewed_at = NULL
     WHERE id = $1 AND user_id = $2 RETURNING id`,
    [phraseId, userId],
  );
  return rows.length > 0;
}

/** Takes back what was recorded of these kinds for a phrase on a day, as when a swipe is undone. */
export async function forgetActivity(db: Db, userId: number, day: string, kinds: ActivityKind[], phraseId: number): Promise<void> {
  await db.query('DELETE FROM activity WHERE user_id = $1 AND day = $2 AND kind = ANY($3::text[]) AND phrase_id = $4', [
    userId,
    day,
    kinds,
    phraseId,
  ]);
}
