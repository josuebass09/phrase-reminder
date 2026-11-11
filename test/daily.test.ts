import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sendDueReminders } from '../src/daily.js';
import { getSettings, listSubscriptions, saveSubscription, updateSettings, type Db, type User } from '../src/db.js';
import { greeting, notificationPayload } from '../src/push.js';
import { clearTables, createTestDb, insertAged, insertUser } from './helpers.js';

const phone = { endpoint: 'https://push.example/phone', p256dh: 'key-1', auth: 'auth-1' };
const laptop = { endpoint: 'https://push.example/laptop', p256dh: 'key-2', auth: 'auth-2' };
const tablet = { endpoint: 'https://push.example/tablet', p256dh: 'key-3', auth: 'auth-3' };

/** 12:05 in Costa Rica (UTC-6), just after the default reminder time of 12:00. */
const NOON = new Date('2026-11-10T18:05:00Z');

let db: Db;
let alice: User;
let bob: User;

async function shownTexts(): Promise<string[]> {
  const { rows } = await db.query('SELECT text FROM phrases WHERE last_shown_at IS NOT NULL ORDER BY text');
  return rows.map((row) => row.text);
}

function pushError(statusCode: number) {
  return Object.assign(new Error(`push failed with ${statusCode}`), { statusCode });
}

/** Which phrases each device was sent, by endpoint. */
function sentBodies(send: ReturnType<typeof vi.fn>): Record<string, string> {
  return Object.fromEntries(
    send.mock.calls.map(([subscription, payload]) => [subscription.endpoint, JSON.parse(payload).body]),
  );
}

beforeAll(async () => {
  db = await createTestDb();
});

beforeEach(async () => {
  await clearTables(db);
  alice = await insertUser(db, 'alice@example.com');
  bob = await insertUser(db, 'bob@example.com');
});

describe('sendDueReminders', () => {
  it("pushes each user's eligible phrases to that user's devices and marks them as shown", async () => {
    await insertAged(db, alice.id, 'old one', 20);
    await insertAged(db, alice.id, 'too new', 1);
    await saveSubscription(db, alice.id, phone);
    await saveSubscription(db, alice.id, laptop);
    const send = vi.fn().mockResolvedValue(undefined);

    const result = await sendDueReminders(db, send, NOON);

    expect(result).toEqual({ users: 1, phrases: 1, devices: 2, delivered: 2, errors: [] });
    expect(sentBodies(send)).toEqual({ [phone.endpoint]: '• old one', [laptop.endpoint]: '• old one' });
    expect(await shownTexts()).toEqual(['old one']);
  });

  it("never sends one user's phrases to another user's device", async () => {
    await insertAged(db, alice.id, "alice's phrase", 20);
    await insertAged(db, bob.id, "bob's phrase", 20);
    await saveSubscription(db, alice.id, phone);
    await saveSubscription(db, bob.id, tablet);
    const send = vi.fn().mockResolvedValue(undefined);

    const result = await sendDueReminders(db, send, NOON);

    expect(result).toMatchObject({ users: 2, phrases: 2, devices: 2, delivered: 2 });
    expect(sentBodies(send)).toEqual({ [phone.endpoint]: "• alice's phrase", [tablet.endpoint]: "• bob's phrase" });
  });

  it('skips users with no phrase old enough', async () => {
    await insertAged(db, alice.id, 'too new', 1);
    await saveSubscription(db, alice.id, phone);
    const send = vi.fn();

    const result = await sendDueReminders(db, send, NOON);

    expect(result).toEqual({ users: 0, phrases: 0, devices: 0, delivered: 0, errors: [] });
    expect(send).not.toHaveBeenCalled();
  });

  it('keeps phrases unshown when the user has no device with reminders on', async () => {
    await insertAged(db, alice.id, 'old one', 20);
    await saveSubscription(db, bob.id, tablet);
    const send = vi.fn();

    const result = await sendDueReminders(db, send, NOON);

    expect(result.users).toBe(0);
    expect(send).not.toHaveBeenCalled();
    expect(await shownTexts()).toEqual([]);
  });

  it('records the day a reminder reached a device, and not one that reached none', async () => {
    await insertAged(db, alice.id, "alice's phrase", 20);
    await insertAged(db, bob.id, "bob's phrase", 20);
    await saveSubscription(db, alice.id, phone);
    await saveSubscription(db, bob.id, laptop);
    const send = vi.fn(async (subscription: { endpoint: string }) => {
      if (subscription.endpoint === laptop.endpoint) throw pushError(500);
    });

    await sendDueReminders(db, send, NOON);

    const { rows } = await db.query('SELECT user_id AS "userId", day, kind FROM activity');
    expect(rows).toEqual([{ userId: alice.id, day: '2026-11-10', kind: 'reminder_sent' }]);
  });

  it('keeps phrases unshown and reports the error when every device fails', async () => {
    await insertAged(db, alice.id, 'old one', 20);
    await saveSubscription(db, alice.id, phone);
    const send = vi.fn().mockRejectedValue(pushError(500));

    const result = await sendDueReminders(db, send, NOON);

    expect(result.delivered).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(await shownTexts()).toEqual([]);
    expect(await listSubscriptions(db, alice.id)).toEqual([phone]);
  });

  it('marks phrases as shown when at least one of the user\'s devices receives them', async () => {
    await insertAged(db, alice.id, 'old one', 20);
    await saveSubscription(db, alice.id, phone);
    await saveSubscription(db, alice.id, laptop);
    const send = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(pushError(500));

    const result = await sendDueReminders(db, send, NOON);

    expect(result.delivered).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(await shownTexts()).toEqual(['old one']);
  });

  it('only marks phrases as shown for users whose devices received them', async () => {
    await insertAged(db, alice.id, "alice's phrase", 20);
    await insertAged(db, bob.id, "bob's phrase", 20);
    await saveSubscription(db, alice.id, phone);
    await saveSubscription(db, bob.id, tablet);
    const send = vi.fn(async (subscription: { endpoint: string }) => {
      if (subscription.endpoint === tablet.endpoint) throw pushError(500);
    });

    await sendDueReminders(db, send, NOON);

    expect(await shownTexts()).toEqual(["alice's phrase"]);
  });

  it.each([404, 410])('removes a device whose subscription returns %i', async (status) => {
    await insertAged(db, alice.id, 'old one', 20);
    await saveSubscription(db, alice.id, phone);
    const send = vi.fn().mockRejectedValue(pushError(status));

    const result = await sendDueReminders(db, send, NOON);

    expect(result.errors).toEqual([]);
    expect(await listSubscriptions(db, alice.id)).toEqual([]);
    expect(await shownTexts()).toEqual([]);
  });
});

describe('reminder schedule', () => {
  const send = () => vi.fn().mockResolvedValue(undefined);

  beforeEach(async () => {
    await insertAged(db, alice.id, 'one', 20);
    await insertAged(db, alice.id, 'two', 20);
    await insertAged(db, alice.id, 'three', 20);
    await insertAged(db, alice.id, 'four', 20);
    await saveSubscription(db, alice.id, phone);
  });

  it('waits until the chosen time in the user\'s time zone', async () => {
    await updateSettings(db, alice.id, { reminderTime: '08:30', timeZone: 'Europe/Madrid' });
    const sender = send();

    await sendDueReminders(db, sender, new Date('2026-11-10T07:25:00Z')); // 08:25 in Madrid
    expect(sender).not.toHaveBeenCalled();
    await sendDueReminders(db, sender, new Date('2026-11-10T07:30:00Z')); // 08:30 in Madrid
    expect(sender).toHaveBeenCalledTimes(1);
  });

  it('sends once per local day, however often it runs', async () => {
    const sender = send();

    await sendDueReminders(db, sender, NOON);
    await sendDueReminders(db, sender, new Date('2026-11-10T18:20:00Z'));
    await sendDueReminders(db, sender, new Date('2026-11-10T19:50:00Z'));
    await sendDueReminders(db, sender, new Date('2026-11-11T18:00:00Z')); // The next day at 12:00.

    expect(sender).toHaveBeenCalledTimes(2);
  });

  it('catches up for 3 hours after the chosen time, then waits for the next day', async () => {
    const late = send();
    await sendDueReminders(db, late, new Date('2026-11-10T20:59:00Z')); // 14:59
    expect(late).toHaveBeenCalledTimes(1);

    await db.query('UPDATE users SET last_reminder_day = NULL'); // As if the 14:59 run hadn't sent it.
    const tooLate = send();
    await sendDueReminders(db, tooLate, new Date('2026-11-10T21:00:00Z')); // 15:00
    expect(tooLate).not.toHaveBeenCalled();
  });

  it("sends a late-evening reminder after midnight as that evening's", async () => {
    await updateSettings(db, alice.id, { reminderTime: '23:30' });
    const sender = send();

    await sendDueReminders(db, sender, new Date('2026-11-11T06:10:00Z')); // 00:10 the next day
    await sendDueReminders(db, sender, new Date('2026-11-11T06:40:00Z'));

    expect(sender).toHaveBeenCalledTimes(1);
  });

  it('sends as many phrases as the user chose', async () => {
    await updateSettings(db, alice.id, { phrasesPerDay: 1 });
    const sender = send();

    await sendDueReminders(db, sender, NOON);

    expect(JSON.parse(sender.mock.calls[0][1]).body.split('\n')).toHaveLength(1);
  });

  it('sends nothing while the user has reminders paused', async () => {
    await updateSettings(db, alice.id, { remindersOn: false });
    const sender = send();

    await sendDueReminders(db, sender, NOON);

    expect(sender).not.toHaveBeenCalled();
  });

  it("follows each user's own time", async () => {
    await insertAged(db, bob.id, "bob's", 20);
    await saveSubscription(db, bob.id, tablet);
    await updateSettings(db, bob.id, { reminderTime: '13:00' });
    const sender = send();

    await sendDueReminders(db, sender, NOON);

    expect(sender.mock.calls.map(([device]) => device.endpoint)).toEqual([phone.endpoint]);
  });

  it('tries again on the next run when no device received the reminder', async () => {
    const failing = vi.fn().mockRejectedValue(pushError(500));
    await sendDueReminders(db, failing, NOON);
    const working = send();

    await sendDueReminders(db, working, new Date('2026-11-10T18:20:00Z'));

    expect(working).toHaveBeenCalledTimes(1);
  });

  it('starts everyone at 12:00 Costa Rica time with 3 phrases', async () => {
    expect(await getSettings(db, alice.id)).toEqual({
      remindersOn: true,
      reminderTime: '12:00',
      timeZone: 'America/Costa_Rica',
      phrasesPerDay: 3,
      language: null,
    });
  });
});

describe('notificationPayload', () => {
  const at = (hours: number, minutes = 0) => hours * 60 + minutes;

  it('greets for the time of day, says how many phrases, and bullets each one', () => {
    const payload = JSON.parse(notificationPayload([{ text: 'First.' }, { text: 'Second.' }, { text: 'Third.' }], at(12, 5)));

    expect(payload.title).toBe('☀️ Good afternoon! 3 phrases for today');
    expect(payload.body).toBe('• First.\n• Second.\n• Third.');
  });

  it.each([
    [at(5), '🌅 Good morning!'],
    [at(11, 59), '🌅 Good morning!'],
    [at(12), '☀️ Good afternoon!'],
    [at(17, 59), '☀️ Good afternoon!'],
    [at(18), '🌙 Good evening!'],
    [at(0, 30), '🌙 Good evening!'],
    [at(4, 59), '🌙 Good evening!'],
  ])('says %s minutes after midnight is %s', (minutes, expected) => {
    expect(greeting(minutes)).toBe(expected);
  });

  it('speaks Spanish when that is the language', () => {
    expect(JSON.parse(notificationPayload([{ text: 'A.' }, { text: 'B.' }], at(19), 'es')).title).toBe('🌙 ¡Buenas noches! 2 frases para hoy');
    expect(JSON.parse(notificationPayload([{ text: 'A.' }], at(8), 'es')).title).toBe('🌅 ¡Buenos días! 1 frase para hoy');
    expect(greeting(at(13), 'es')).toBe('☀️ ¡Buenas tardes!');
  });

  it('says "1 phrase" for a single one', () => {
    expect(JSON.parse(notificationPayload([{ text: 'Only.' }], at(8))).title).toBe('🌅 Good morning! 1 phrase for today');
  });

  it.each([1, 3, 5])('stays under the push size limit with %i of the longest phrases allowed', (count) => {
    const longPhrases = Array.from({ length: count }, () => ({ text: '語'.repeat(500) })); // 3 bytes each

    const payload = notificationPayload(longPhrases, at(12));

    expect(Buffer.byteLength(payload)).toBeLessThan(3200);
    expect(JSON.parse(payload).body.split('\n').every((line: string) => line.endsWith('…'))).toBe(true);
  });
});

describe('reminder notifications', () => {
  it("greet for the user's local time when they go out", async () => {
    await insertAged(db, alice.id, 'old one', 20);
    await saveSubscription(db, alice.id, phone);
    await updateSettings(db, alice.id, { reminderTime: '19:00', timeZone: 'Europe/Madrid' });
    const send = vi.fn().mockResolvedValue(undefined);

    await sendDueReminders(db, send, new Date('2026-11-10T18:05:00Z')); // 19:05 in Madrid

    expect(JSON.parse(send.mock.calls[0][1])).toEqual({ title: '🌙 Good evening! 1 phrase for today', body: '• old one' });
  });

  it("come in the user's language", async () => {
    await insertAged(db, alice.id, 'old one', 20);
    await saveSubscription(db, alice.id, phone);
    await updateSettings(db, alice.id, { language: 'es' });
    const send = vi.fn().mockResolvedValue(undefined);

    await sendDueReminders(db, send, NOON);

    expect(JSON.parse(send.mock.calls[0][1]).title).toBe('☀️ ¡Buenas tardes! 1 frase para hoy');
  });
});
