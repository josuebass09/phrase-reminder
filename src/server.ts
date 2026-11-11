import { serve } from '@hono/node-server';
import {
  createApp,
  DEFAULT_PRONUNCIATIONS_PER_DAY,
  DEFAULT_SUGGESTIONS_PER_DAY,
  DEFAULT_TRANSLATIONS_PER_DAY,
} from './app.js';
import { connect, ensureSchema } from './db.js';
import { requireEnv } from './env.js';
import { createGroqPronouncer } from './pronounce.js';
import { createGroqSuggester } from './suggest.js';
import { createMyMemoryTranslator } from './translate.js';

const tokenSecret = requireEnv('SESSION_SECRET');
// HS256 is only as strong as its key. `openssl rand -base64 32` gives 44 characters.
if (tokenSecret.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters');

/** An optional daily limit per user from the environment (the admin has none). */
function dailyLimit(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const count = Number(value);
  if (Number.isInteger(count) && count >= 1) return count;
  console.warn(`${name} must be a whole number of 1 or more, so ${fallback} is used`);
  return fallback;
}

// Optional. Without a key, asking for suggestions or pronunciation scores answers that they aren't available.
const groqKey = process.env.GROQ_API_KEY;
if (!groqKey) console.warn('GROQ_API_KEY is not set, so suggestions and pronunciation scores are off');
const groqModel = process.env.GROQ_MODEL || undefined;

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
  translationsPerDay: dailyLimit('TRANSLATIONS_PER_DAY', DEFAULT_TRANSLATIONS_PER_DAY),
  suggest: groqKey ? createGroqSuggester({ apiKey: groqKey, model: groqModel }) : undefined,
  suggestionsPerDay: dailyLimit('SUGGESTIONS_PER_DAY', DEFAULT_SUGGESTIONS_PER_DAY),
  pronounce: groqKey
    ? createGroqPronouncer({
        apiKey: groqKey,
        model: groqModel,
        transcriptionModel: process.env.GROQ_TRANSCRIPTION_MODEL || undefined,
      })
    : undefined,
  pronunciationsPerDay: dailyLimit('PRONUNCIATIONS_PER_DAY', DEFAULT_PRONUNCIATIONS_PER_DAY),
});

serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 3000) }, ({ port }) => {
  console.log(`Listening on port ${port}`);
});
