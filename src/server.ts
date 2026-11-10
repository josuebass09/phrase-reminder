import { serve } from '@hono/node-server';
import { createApp, MIN_SIGNUP_CODE_LENGTH } from './app.js';
import { connect, ensureSchema } from './db.js';
import { requireEnv } from './env.js';

const tokenSecret = requireEnv('SESSION_SECRET');
// HS256 is only as strong as its key. `openssl rand -base64 32` gives 44 characters.
if (tokenSecret.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters');

// Optional. Lets people with this invite code create an account from the app.
const signupCode = (process.env.SIGNUP_CODE ?? '').trim();
if (signupCode && signupCode.length < MIN_SIGNUP_CODE_LENGTH) {
  console.warn(`SIGNUP_CODE is shorter than ${MIN_SIGNUP_CODE_LENGTH} characters, so sign-up stays closed`);
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
  signupCode,
});

serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 3000) }, ({ port }) => {
  console.log(`Listening on port ${port}`);
});
