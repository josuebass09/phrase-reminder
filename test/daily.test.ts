import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sendDailyPhrases } from '../src/daily.js';
import { listSubscriptions, saveSubscription, type Db, type User } from '../src/db.js';
import { notificationPayload } from '../src/push.js';
import { clearTables, createTestDb, insertAged, insertUser } from './helpers.js';

const phone = { endpoint: 'https://push.example/phone', p256dh: 'key-1', auth: 'auth-1' };
const laptop = { endpoint: 'https://push.example/laptop', p256dh: 'key-2', auth: 'auth-2' };
const tablet = { endpoint: 'https://push.example/tablet', p256dh: 'key-3', auth: 'auth-3' };

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

describe('sendDailyPhrases', () => {
  it("pushes each user's eligible phrases to that user's devices and marks them as shown", async () => {
    await insertAged(db, alice.id, 'old one', 20);
    await insertAged(db, alice.id, 'too new', 1);
    await saveSubscription(db, alice.id, phone);
    await saveSubscription(db, alice.id, laptop);
    const send = vi.fn().mockResolvedValue(undefined);

    const result = await sendDailyPhrases(db, send);

    expect(result).toEqual({ users: 1, phrases: 1, devices: 2, delivered: 2, errors: [] });
    expect(sentBodies(send)).toEqual({ [phone.endpoint]: 'old one', [laptop.endpoint]: 'old one' });
    expect(await shownTexts()).toEqual(['old one']);
  });

  it("never sends one user's phrases to another user's device", async () => {
    await insertAged(db, alice.id, "alice's phrase", 20);
    await insertAged(db, bob.id, "bob's phrase", 20);
    await saveSubscription(db, alice.id, phone);
    await saveSubscription(db, bob.id, tablet);
    const send = vi.fn().mockResolvedValue(undefined);

    const result = await sendDailyPhrases(db, send);

    expect(result).toMatchObject({ users: 2, phrases: 2, devices: 2, delivered: 2 });
    expect(sentBodies(send)).toEqual({ [phone.endpoint]: "alice's phrase", [tablet.endpoint]: "bob's phrase" });
  });

  it('skips users with no phrase old enough', async () => {
    await insertAged(db, alice.id, 'too new', 1);
    await saveSubscription(db, alice.id, phone);
    const send = vi.fn();

    const result = await sendDailyPhrases(db, send);

    expect(result).toEqual({ users: 0, phrases: 0, devices: 0, delivered: 0, errors: [] });
    expect(send).not.toHaveBeenCalled();
  });

  it('keeps phrases unshown when the user has no device with reminders on', async () => {
    await insertAged(db, alice.id, 'old one', 20);
    await saveSubscription(db, bob.id, tablet);
    const send = vi.fn();

    const result = await sendDailyPhrases(db, send);

    expect(result.users).toBe(0);
    expect(send).not.toHaveBeenCalled();
    expect(await shownTexts()).toEqual([]);
  });

  it('keeps phrases unshown and reports the error when every device fails', async () => {
    await insertAged(db, alice.id, 'old one', 20);
    await saveSubscription(db, alice.id, phone);
    const send = vi.fn().mockRejectedValue(pushError(500));

    const result = await sendDailyPhrases(db, send);

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

    const result = await sendDailyPhrases(db, send);

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

    await sendDailyPhrases(db, send);

    expect(await shownTexts()).toEqual(["alice's phrase"]);
  });

  it.each([404, 410])('removes a device whose subscription returns %i', async (status) => {
    await insertAged(db, alice.id, 'old one', 20);
    await saveSubscription(db, alice.id, phone);
    const send = vi.fn().mockRejectedValue(pushError(status));

    const result = await sendDailyPhrases(db, send);

    expect(result.errors).toEqual([]);
    expect(await listSubscriptions(db, alice.id)).toEqual([]);
    expect(await shownTexts()).toEqual([]);
  });
});

describe('notificationPayload', () => {
  it('lists each phrase on its own line', () => {
    const payload = JSON.parse(notificationPayload([{ text: 'First.' }, { text: 'Second.' }]));

    expect(payload.title).toBe('Your phrases for today');
    expect(payload.body).toBe('First.\nSecond.');
  });

  it('stays under the push size limit with the longest phrases allowed', () => {
    const longPhrases = Array.from({ length: 3 }, () => ({ text: 'é'.repeat(500) }));

    const payload = notificationPayload(longPhrases);

    expect(Buffer.byteLength(payload)).toBeLessThan(3000);
  });
});
