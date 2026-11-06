import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { connect, ensureSchema } from './db.js';
import { requireEnv } from './env.js';

const db = connect(requireEnv('DATABASE_URL'));
await ensureSchema(db);

const app = createApp({
  db,
  password: requireEnv('APP_PASSWORD'),
  sessionSecret: requireEnv('SESSION_SECRET'),
  vapidPublicKey: requireEnv('VAPID_PUBLIC_KEY'),
});

serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 3000) }, ({ port }) => {
  console.log(`Listening on port ${port}`);
});
