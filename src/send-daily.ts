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
  const { phrases, devices, delivered, errors } = await sendDailyPhrases(db, send);

  if (phrases === 0) {
    console.log('No phrases old enough yet, so nothing was sent');
  } else if (devices === 0) {
    console.log('No device has reminders turned on, so nothing was sent');
  } else {
    console.log(`Sent ${phrases} phrases to ${delivered} of ${devices} devices`);
  }

  for (const error of errors) console.error(error);
  if (delivered === 0 && errors.length > 0) process.exitCode = 1;
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await db.end();
}
