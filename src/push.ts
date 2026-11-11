import webpush from 'web-push';
import type { DeviceSubscription, Phrase } from './db.js';
import type { Language } from './messages.js';

export type PushSender = (subscription: DeviceSubscription, payload: string) => Promise<unknown>;

export interface PushConfig {
  subject: string;
  publicKey: string;
  privateKey: string;
}

const TWELVE_HOURS_SECONDS = 12 * 60 * 60;

// Push services reject payloads of about 4 KB. Without a cap, one oversized
// phrase would fail every day, because it stays first in the never-shown queue.
// The cap shrinks with more phrases, so even 5 long ones of 3-byte characters fit.
const MAX_NOTIFICATION_PHRASE_LENGTH = 300;
const MAX_NOTIFICATION_TEXT_LENGTH = 900;

function shorten(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

const GREETINGS: Record<Language, { morning: string; afternoon: string; evening: string }> = {
  en: { morning: '🌅 Good morning!', afternoon: '☀️ Good afternoon!', evening: '🌙 Good evening!' },
  es: { morning: '🌅 ¡Buenos días!', afternoon: '☀️ ¡Buenas tardes!', evening: '🌙 ¡Buenas noches!' },
};

const FOR_TODAY: Record<Language, (count: number) => string> = {
  en: (count) => (count === 1 ? '1 phrase for today' : `${count} phrases for today`),
  es: (count) => (count === 1 ? '1 frase para hoy' : `${count} frases para hoy`),
};

/** A greeting for the user's local time: morning from 5:00, afternoon from 12:00, evening from 18:00. */
export function greeting(localMinutes: number, language: Language = 'en'): string {
  const hour = Math.floor(localMinutes / 60);
  const { morning, afternoon, evening } = GREETINGS[language];
  if (hour >= 5 && hour < 12) return morning;
  if (hour >= 12 && hour < 18) return afternoon;
  return evening;
}

/**
 * The notification, in the user's language: a greeting for their local time with
 * how many phrases there are, such as "☀️ Good afternoon! 3 phrases for today",
 * then one bulleted phrase per line.
 */
export function notificationPayload(
  phrases: Pick<Phrase, 'text'>[],
  localMinutes: number,
  language: Language = 'en',
): string {
  const limit = Math.min(MAX_NOTIFICATION_PHRASE_LENGTH, Math.floor(MAX_NOTIFICATION_TEXT_LENGTH / Math.max(phrases.length, 1)));
  return JSON.stringify({
    title: `${greeting(localMinutes, language)} ${FOR_TODAY[language](phrases.length)}`,
    body: phrases.map((phrase) => `• ${shorten(phrase.text, limit)}`).join('\n'),
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
