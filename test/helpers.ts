import { PGlite } from '@electric-sql/pglite';
import { ensureSchema, type Db } from '../src/db.js';

/** A real Postgres engine running in-process, so the tests exercise the actual SQL. */
export async function createTestDb(): Promise<Db> {
  const pglite = new PGlite();
  const db: Db = { query: (sql, params) => pglite.query(sql, params as any[]) };
  await ensureSchema(db);
  return db;
}

export async function clearTables(db: Db): Promise<void> {
  await db.query('TRUNCATE phrases, push_subscriptions RESTART IDENTITY');
}

export async function insertAged(
  db: Db,
  text: string,
  daysOld: number,
  shownDaysAgo?: number,
): Promise<void> {
  const shown = shownDaysAgo === undefined ? 'NULL' : `now() - interval '${shownDaysAgo} days'`;
  await db.query(
    `INSERT INTO phrases (text, created_at, last_shown_at)
     VALUES ($1, now() - interval '${daysOld} days', ${shown})`,
    [text],
  );
}
