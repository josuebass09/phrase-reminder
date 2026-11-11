import { sendDueReminders, type DailyResult } from './daily.js';
import { connect, ensureSchema, recordCronRun } from './db.js';
import { requireEnv } from './env.js';
import { createPushSender } from './push.js';

// Railway cron entry point, run every 15 minutes: it sends each user's reminder
// once it's due (see daily.ts). It must exit when done: if a run stays alive,
// Railway skips the next one and doesn't stop the old one.
const send = createPushSender({
  subject: requireEnv('VAPID_SUBJECT'),
  publicKey: requireEnv('VAPID_PUBLIC_KEY'),
  privateKey: requireEnv('VAPID_PRIVATE_KEY'),
});
const db = connect(requireEnv('DATABASE_URL'));
const startedAt = new Date();

/** Saves the run for the admin to see. A failure to save it is only logged. */
async function saveRun(result: Pick<DailyResult, 'users' | 'devices' | 'delivered' | 'removed'>, errors: unknown[]) {
  await recordCronRun(db, {
    startedAt,
    finishedAt: new Date(),
    ...result,
    errors: errors.length,
    firstError: errors.length > 0 ? String((errors[0] as Error | null)?.message ?? errors[0]) : null,
    version: process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) || null,
  }).catch((error) => console.error('Could not save the run:', error));
}

try {
  await ensureSchema(db);
  const { users, phrases, devices, delivered, removed, errors } = await sendDueReminders(db, send);

  if (users === 0) {
    console.log('No reminders due');
  } else {
    console.log(`Sent ${phrases} phrases to ${delivered} of ${devices} devices, for ${users} users`);
  }

  for (const error of errors) console.error(error);
  await saveRun({ users, devices, delivered, removed }, errors);
  if (delivered === 0 && errors.length > 0) process.exitCode = 1;
} catch (error) {
  console.error(error);
  await saveRun({ users: 0, devices: 0, delivered: 0, removed: 0 }, [error]);
  process.exitCode = 1;
} finally {
  await db.end();
}
