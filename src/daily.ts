import {
  deleteSubscription,
  listSubscriptions,
  markShown,
  pickDailyPhrases,
  type Db,
} from './db.js';
import { notificationPayload, type PushSender } from './push.js';

export interface DailyResult {
  phrases: number;
  devices: number;
  delivered: number;
  errors: unknown[];
}

function subscriptionIsGone(error: unknown): boolean {
  const status = (error as { statusCode?: number } | null)?.statusCode;
  return status === 404 || status === 410;
}

/**
 * Pushes today's phrases to every subscribed device. Phrases are marked as shown
 * only if a device received them, so a failed run doesn't use them up. Devices
 * whose subscription no longer exists are removed.
 */
export async function sendDailyPhrases(db: Db, send: PushSender): Promise<DailyResult> {
  const phrases = await pickDailyPhrases(db);
  const subscriptions = phrases.length > 0 ? await listSubscriptions(db) : [];
  const result: DailyResult = {
    phrases: phrases.length,
    devices: subscriptions.length,
    delivered: 0,
    errors: [],
  };
  if (subscriptions.length === 0) return result;

  const payload = notificationPayload(phrases);
  const outcomes = await Promise.allSettled(
    subscriptions.map((subscription) => send(subscription, payload)),
  );

  for (const [i, outcome] of outcomes.entries()) {
    if (outcome.status === 'fulfilled') {
      result.delivered += 1;
    } else if (subscriptionIsGone(outcome.reason)) {
      await deleteSubscription(db, subscriptions[i].endpoint);
    } else {
      result.errors.push(outcome.reason);
    }
  }

  if (result.delivered > 0) {
    await markShown(db, phrases.map((phrase) => phrase.id));
  }
  return result;
}
