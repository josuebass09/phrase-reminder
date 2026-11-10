import { sendDailyPhrases } from './daily.js';
import { connect, ensureSchema } from './db.js';
import { requireEnv } from './env.js';
import { createPushSender } from './push.js';

// Railway cron entry point. It must exit when done: if a run stays alive,
// Railway skips the next one and doesn't stop the old one.
const send = createPushSender({
  subject: requireEnv('VAPID_SUBJECT'),
  publicKey: requireEnv('VAPID_PUBLIC_KEY'),
  privateKey: requireEnv('VAPID_PRIVATE_KEY'),
});
const db = connect(requireEnv('DATABASE_URL'));

try {
  await ensureSchema(db);
  const { users, phrases, devices, delivered, errors } = await sendDailyPhrases(db, send);

  if (users === 0) {
    console.log('Nothing was sent: no user has both reminders turned on and phrases at least 14 days old');
  } else {
    console.log(`Sent ${phrases} phrases to ${delivered} of ${devices} devices, for ${users} users`);
  }

  for (const error of errors) console.error(error);
  if (delivered === 0 && errors.length > 0) process.exitCode = 1;
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await db.end();
}
