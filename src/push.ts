import webpush from 'web-push';
import type { DeviceSubscription, Phrase } from './db.js';

export type PushSender = (subscription: DeviceSubscription, payload: string) => Promise<unknown>;

export interface PushConfig {
  subject: string;
  publicKey: string;
  privateKey: string;
}

const TWELVE_HOURS_SECONDS = 12 * 60 * 60;

// Push services reject payloads of about 4 KB. Without a cap, one oversized
// phrase would fail every day, because it stays first in the never-shown queue.
const MAX_NOTIFICATION_PHRASE_LENGTH = 300;

function shorten(text: string): string {
  return text.length > MAX_NOTIFICATION_PHRASE_LENGTH
    ? `${text.slice(0, MAX_NOTIFICATION_PHRASE_LENGTH - 1)}…`
    : text;
}

export function notificationPayload(phrases: Pick<Phrase, 'text'>[]): string {
  return JSON.stringify({
    title: 'Your phrases for today',
    body: phrases.map((phrase) => shorten(phrase.text)).join('\n'),
  });
}

export function createPushSender({ subject, publicKey, privateKey }: PushConfig): PushSender {
  return ({ endpoint, p256dh, auth }, payload) =>
    webpush.sendNotification({ endpoint, keys: { p256dh, auth } }, payload, {
      vapidDetails: { subject, publicKey, privateKey },
      TTL: TWELVE_HOURS_SECONDS,
      // A hung request would keep the cron run alive, and Railway would skip the next one.
      timeout: 30_000,
    });
}
