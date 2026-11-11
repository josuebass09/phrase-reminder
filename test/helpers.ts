import { PGlite } from '@electric-sql/pglite';
import { hashRefreshToken, newRefreshToken } from '../src/auth.js';
import { createSession, createUser, ensureSchema, type Db, type User } from '../src/db.js';

/** A real Postgres engine running in-process, so the tests exercise the actual SQL. */
export async function createTestDb(): Promise<Db> {
  const pglite = new PGlite();
  const db: Db = { query: (sql, params) => pglite.query(sql, params as any[]) };
  await ensureSchema(db);
  return db;
}

export async function clearTables(db: Db): Promise<void> {
  await db.query('TRUNCATE users, invites, phrases, push_subscriptions, sessions, activity, ai_usage, ai_quota RESTART IDENTITY CASCADE');
}

/** Hashing is slow on purpose, so tests that don't log in skip it. */
export function insertUser(db: Db, email: string, passwordHash = 'not-a-real-hash'): Promise<User> {
  return createUser(db, email, passwordHash);
}

export async function insertAged(
  db: Db,
  userId: number | null,
  text: string,
  daysOld: number,
  shownDaysAgo?: number,
): Promise<void> {
  const shown = shownDaysAgo === undefined ? 'NULL' : `now() - interval '${shownDaysAgo} days'`;
  await db.query(
    `INSERT INTO phrases (user_id, text, created_at, last_shown_at)
     VALUES ($1, $2, now() - interval '${daysOld} days', ${shown})`,
    [userId, text],
  );
}

/** Opens a session as logging in does, and returns it with its refresh token. */
export async function openSession(db: Db, userId: number): Promise<{ sessionId: number; refreshToken: string }> {
  const refreshToken = newRefreshToken();
  return { sessionId: await createSession(db, userId, hashRefreshToken(refreshToken)), refreshToken };
}
