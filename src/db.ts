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
  /** The score of the last time the user said it aloud, from 1 to 10, or null if never. */
  lastScore: number | null;
}

export interface DeviceSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
}

const PHRASE_COLUMNS = 'id, text, created_at AS "createdAt", last_score AS "lastScore"';
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
         last_score = CASE WHEN text = $3 THEN last_score END
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

export async function listRecent(db: Db, userId: number, limit = 50): Promise<Phrase[]> {
  const { rows } = await db.query(
    `SELECT ${PHRASE_COLUMNS} FROM phrases
     WHERE user_id = $1
     ORDER BY created_at DESC, id DESC
     LIMIT $2`,
    [userId, limit],
  );
  return rows;
}

/** Phrases at least 14 days old: never-shown first, then longest since shown. */
export async function pickDailyPhrases(db: Db, userId: number, limit = 3): Promise<Phrase[]> {
  const { rows } = await db.query(
    `SELECT ${PHRASE_COLUMNS}
     FROM phrases
     WHERE user_id = $1 AND created_at <= now() - interval '14 days'
     ORDER BY last_shown_at ASC NULLS FIRST, random()
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
     ORDER BY id`,
    [userId],
  );
  return rows;
}

export async function markShown(db: Db, ids: number[]): Promise<void> {
  await db.query('UPDATE phrases SET last_shown_at = now() WHERE id = ANY($1::int[])', [ids]);
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
