import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { connect, ensureSchema } from './db.js';
import { requireEnv } from './env.js';
import { createMyMemoryTranslator } from './translate.js';

const tokenSecret = requireEnv('SESSION_SECRET');
// HS256 is only as strong as its key. `openssl rand -base64 32` gives 44 characters.
if (tokenSecret.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters');

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
});

serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 3000) }, ({ port }) => {
  console.log(`Listening on port ${port}`);
});
