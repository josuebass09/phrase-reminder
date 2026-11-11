import {
  deleteSubscription,
  listReminderCandidates,
  listSubscriptions,
  markShown,
  pickDailyPhrases,
  recordActivity,
  setLastReminderDay,
  type Db,
  type DeviceSubscription,
} from './db.js';
import { notificationPayload, type PushSender } from './push.js';
import { dueReminderDay, localClock } from './schedule.js';

export interface DailyResult {
  /** Users whose reminder was due and who had phrases old enough. */
  users: number;
  phrases: number;
  devices: number;
  delivered: number;
  /** Devices whose subscription no longer exists, now removed. */
  removed: number;
  errors: unknown[];
}

function subscriptionIsGone(error: unknown): boolean {
  const status = (error as { statusCode?: number } | null)?.statusCode;
  return status === 404 || status === 410;
}

/** Sends one payload to each device and returns how many received it, counting gone devices and errors in `result`. */
async function pushToDevices(
  db: Db,
  send: PushSender,
  subscriptions: DeviceSubscription[],
  payload: string,
  result: DailyResult,
): Promise<number> {
  const outcomes = await Promise.allSettled(subscriptions.map((subscription) => send(subscription, payload)));
  let delivered = 0;
  for (const [i, outcome] of outcomes.entries()) {
    if (outcome.status === 'fulfilled') {
      delivered += 1;
    } else if (subscriptionIsGone(outcome.reason)) {
      await deleteSubscription(db, subscriptions[i].endpoint);
      result.removed += 1;
    } else {
      result.errors.push(outcome.reason);
    }
  }
  return delivered;
}

/**
 * Pushes each user's phrases to that user's devices once their reminder is due:
 * at their chosen time in their time zone, once per local day, with as many
 * phrases as they chose. Phrases are marked as shown, and the day as done, only
 * if one of the user's devices received them, so a failed run is retried by the
 * next one. Devices whose subscription no longer exists are removed.
 */
export async function sendDueReminders(db: Db, send: PushSender, now = new Date()): Promise<DailyResult> {
  const result: DailyResult = { users: 0, phrases: 0, devices: 0, delivered: 0, removed: 0, errors: [] };

  for (const candidate of await listReminderCandidates(db)) {
    const { userId } = candidate;
    let day: string | null;
    try {
      day = dueReminderDay(now, candidate.reminderTime, candidate.timeZone);
    } catch (error) {
      result.errors.push(error); // A setting the API should never have saved.
      continue;
    }
    if (!day || (candidate.lastReminderDay !== null && candidate.lastReminderDay >= day)) continue;

    const phrases = await pickDailyPhrases(db, userId, candidate.phrasesPerDay);
    if (phrases.length === 0) continue;

    const subscriptions = await listSubscriptions(db, userId);
    result.users += 1;
    result.phrases += phrases.length;
    result.devices += subscriptions.length;

    const payload = notificationPayload(phrases, localClock(now, candidate.timeZone).minutes, candidate.language ?? 'en');
    const delivered = await pushToDevices(db, send, subscriptions, payload, result);
    result.delivered += delivered;
    if (delivered > 0) {
      await markShown(db, phrases.map((phrase) => phrase.id));
      await setLastReminderDay(db, userId, day);
      await recordActivity(db, userId, day, 'reminder_sent');
    }
  }
  return result;
}
