import pg from 'pg';

export const MAX_PHRASE_LENGTH = 500;

export interface Db {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
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
}

export async function saveSubscription(db: Db, subscription: DeviceSubscription): Promise<void> {
  await db.query(
    `INSERT INTO push_subscriptions (endpoint, p256dh, auth)
     VALUES ($1, $2, $3)
     ON CONFLICT (endpoint) DO UPDATE SET p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth`,
    [subscription.endpoint, subscription.p256dh, subscription.auth],
  );
}

export async function listSubscriptions(db: Db): Promise<DeviceSubscription[]> {
  const { rows } = await db.query('SELECT endpoint, p256dh, auth FROM push_subscriptions');
  return rows;
}

export async function deleteSubscription(db: Db, endpoint: string): Promise<void> {
  await db.query('DELETE FROM push_subscriptions WHERE endpoint = $1', [endpoint]);
}

export async function addPhrase(db: Db, text: string): Promise<Phrase> {
  const { rows } = await db.query(
    `INSERT INTO phrases (text) VALUES ($1) RETURNING ${PHRASE_COLUMNS}`,
    [text],
  );
  return rows[0];
}

/**
 * Changes a phrase's text. Its dates stay as they are, so fixing a typo doesn't
 * reset its 14-day wait or its place in the reminder queue.
 */
export async function updatePhrase(db: Db, id: number, text: string): Promise<Phrase | null> {
  const { rows } = await db.query(
    `UPDATE phrases SET text = $2 WHERE id = $1 RETURNING ${PHRASE_COLUMNS}`,
    [id, text],
  );
  return rows[0] ?? null;
}

/** Returns false if no phrase had that id. */
export async function deletePhrase(db: Db, id: number): Promise<boolean> {
  const { rows } = await db.query('DELETE FROM phrases WHERE id = $1 RETURNING id', [id]);
  return rows.length > 0;
}

export async function listRecent(db: Db, limit = 50): Promise<Phrase[]> {
  const { rows } = await db.query(
    `SELECT ${PHRASE_COLUMNS} FROM phrases ORDER BY created_at DESC, id DESC LIMIT $1`,
    [limit],
  );
  return rows;
}

/** Phrases at least 14 days old: never-shown first, then longest since shown. */
export async function pickDailyPhrases(db: Db, limit = 3): Promise<Phrase[]> {
  const { rows } = await db.query(
    `SELECT ${PHRASE_COLUMNS}
     FROM phrases
     WHERE created_at <= now() - interval '14 days'
     ORDER BY last_shown_at ASC NULLS FIRST, random()
     LIMIT $1`,
    [limit],
  );
  return rows;
}

/**
 * The latest reminder batch, if it went out in the last 24 hours. One markShown
 * call gives its whole batch the same last_shown_at, which identifies the batch.
 */
export async function listToday(db: Db): Promise<Phrase[]> {
  const { rows } = await db.query(
    `SELECT ${PHRASE_COLUMNS}
     FROM phrases
     WHERE last_shown_at = (SELECT max(last_shown_at) FROM phrases)
       AND last_shown_at > now() - interval '24 hours'
     ORDER BY id`,
  );
  return rows;
}

export async function markShown(db: Db, ids: number[]): Promise<void> {
  await db.query('UPDATE phrases SET last_shown_at = now() WHERE id = ANY($1::int[])', [ids]);
}

/** Adds phrases backdated 14 days so they are eligible at once. Skips exact duplicates. */
export async function importPhrases(db: Db, texts: string[]): Promise<number> {
  let added = 0;
  for (const text of texts) {
    const { rows } = await db.query(
      `INSERT INTO phrases (text, created_at)
       SELECT $1::text, now() - interval '14 days'
       WHERE NOT EXISTS (SELECT 1 FROM phrases WHERE text = $1::text)
       RETURNING id`,
      [text],
    );
    added += rows.length;
  }
  return added;
}
