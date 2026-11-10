import {
  deleteSubscription,
  listSubscriptions,
  listUserIdsWithDevices,
  markShown,
  pickDailyPhrases,
  type Db,
  type DeviceSubscription,
} from './db.js';
import { notificationPayload, type PushSender } from './push.js';

export interface DailyResult {
  /** Users who had phrases old enough and at least one device. */
  users: number;
  phrases: number;
  devices: number;
  delivered: number;
  errors: unknown[];
}

function subscriptionIsGone(error: unknown): boolean {
  const status = (error as { statusCode?: number } | null)?.statusCode;
  return status === 404 || status === 410;
}

/** Sends one payload to each device and returns how many received it. */
async function pushToDevices(
  db: Db,
  send: PushSender,
  subscriptions: DeviceSubscription[],
  payload: string,
  errors: unknown[],
): Promise<number> {
  const outcomes = await Promise.allSettled(subscriptions.map((subscription) => send(subscription, payload)));
  let delivered = 0;
  for (const [i, outcome] of outcomes.entries()) {
    if (outcome.status === 'fulfilled') {
      delivered += 1;
    } else if (subscriptionIsGone(outcome.reason)) {
      await deleteSubscription(db, subscriptions[i].endpoint);
    } else {
      errors.push(outcome.reason);
    }
  }
  return delivered;
}

/**
 * Pushes each user's phrases for today to that user's devices. Phrases are marked
 * as shown only if one of the user's devices received them, so a failed run
 * doesn't use them up. Devices whose subscription no longer exists are removed.
 */
export async function sendDailyPhrases(db: Db, send: PushSender): Promise<DailyResult> {
  const result: DailyResult = { users: 0, phrases: 0, devices: 0, delivered: 0, errors: [] };

  for (const userId of await listUserIdsWithDevices(db)) {
    const phrases = await pickDailyPhrases(db, userId);
    if (phrases.length === 0) continue;

    const subscriptions = await listSubscriptions(db, userId);
    result.users += 1;
    result.phrases += phrases.length;
    result.devices += subscriptions.length;

    const delivered = await pushToDevices(db, send, subscriptions, notificationPayload(phrases), result.errors);
    result.delivered += delivered;
    if (delivered > 0) await markShown(db, phrases.map((phrase) => phrase.id));
  }
  return result;
}
