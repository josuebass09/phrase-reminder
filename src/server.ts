import { serve } from '@hono/node-server';
import { createApp, DEFAULT_TRANSLATIONS_PER_DAY } from './app.js';
import { connect, ensureSchema } from './db.js';
import { requireEnv } from './env.js';
import { createMyMemoryTranslator } from './translate.js';

const tokenSecret = requireEnv('SESSION_SECRET');
// HS256 is only as strong as its key. `openssl rand -base64 32` gives 44 characters.
if (tokenSecret.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters');

// Optional: new translations each user may ask for per day (the admin has no limit).
function translationsPerDay(): number {
  const value = process.env.TRANSLATIONS_PER_DAY;
  if (!value) return DEFAULT_TRANSLATIONS_PER_DAY;
  const count = Number(value);
  if (Number.isInteger(count) && count >= 1) return count;
  console.warn(`TRANSLATIONS_PER_DAY must be a whole number of 1 or more, so ${DEFAULT_TRANSLATIONS_PER_DAY} is used`);
  return DEFAULT_TRANSLATIONS_PER_DAY;
}

const db = connect(requireEnv('DATABASE_URL'));
await ensureSchema(db);

const app = createApp({
  db,
  tokenSecret,
  vapidPublicKey: requireEnv('VAPID_PUBLIC_KEY'),
  // Optional, comma-separated. Without it, no other site can call the API.
  appOrigins: (process.env.APP_ORIGIN ?? '')
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter(Boolean),
  // Optional. Raises MyMemory's free daily limit from about 5,000 to 50,000 characters.
  translate: createMyMemoryTranslator({ email: process.env.MYMEMORY_EMAIL || undefined }),
  translationsPerDay: translationsPerDay(),
});

serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 3000) }, ({ port }) => {
  console.log(`Listening on port ${port}`);
});
