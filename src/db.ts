import pg from 'pg';

export const MAX_PHRASE_LENGTH = 500;

export interface Db {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

export interface User {
  id: number;
  email: string;
}

export interface UserWithPassword extends User {
  passwordHash: string;
}

export interface UserSummary extends User {
  phrases: number;
  devices: number;
}

export interface Phrase {
  id: number;
  text: string;
  createdAt: Date;
}

export interface DeviceSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
}

const PHRASE_COLUMNS = 'id, text, created_at AS "createdAt"';

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
  await db.query('CREATE INDEX IF NOT EXISTS push_subscriptions_user_id ON push_subscriptions (user_id)');
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

export async function createUser(db: Db, email: string, passwordHash: string): Promise<User> {
  const { rows } = await db.query(
    'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email',
    [normalizeEmail(email), passwordHash],
  );
  return rows[0];
}

export async function findUser(db: Db, id: number): Promise<User | null> {
  const { rows } = await db.query('SELECT id, email FROM users WHERE id = $1', [id]);
  return rows[0] ?? null;
}

export async function findUserByEmail(db: Db, email: string): Promise<UserWithPassword | null> {
  const { rows } = await db.query(
    'SELECT id, email, password_hash AS "passwordHash" FROM users WHERE email = $1',
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
    SELECT u.id, u.email,
      (SELECT count(*)::int FROM phrases p WHERE p.user_id = u.id) AS phrases,
      (SELECT count(*)::int FROM push_subscriptions s WHERE s.user_id = u.id) AS devices
    FROM users u
    ORDER BY u.id
  `);
  return rows;
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

/** Users with at least one device that has reminders on. */
export async function listUserIdsWithDevices(db: Db): Promise<number[]> {
  const { rows } = await db.query(
    'SELECT DISTINCT user_id AS "userId" FROM push_subscriptions WHERE user_id IS NOT NULL ORDER BY 1',
  );
  return rows.map((row) => row.userId);
}

export async function deleteSubscription(db: Db, endpoint: string): Promise<void> {
  await db.query('DELETE FROM push_subscriptions WHERE endpoint = $1', [endpoint]);
}

export async function addPhrase(db: Db, userId: number, text: string): Promise<Phrase> {
  const { rows } = await db.query(
    `INSERT INTO phrases (user_id, text) VALUES ($1, $2) RETURNING ${PHRASE_COLUMNS}`,
    [userId, text],
  );
  return rows[0];
}

/**
 * Changes a phrase's text. Its dates stay as they are, so fixing a typo doesn't
 * reset its 14-day wait or its place in the reminder queue. Returns null if the
 * user has no phrase with that id.
 */
export async function updatePhrase(db: Db, userId: number, id: number, text: string): Promise<Phrase | null> {
  const { rows } = await db.query(
    `UPDATE phrases SET text = $3 WHERE id = $2 AND user_id = $1 RETURNING ${PHRASE_COLUMNS}`,
    [userId, id, text],
  );
  return rows[0] ?? null;
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
