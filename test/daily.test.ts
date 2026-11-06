import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sendDailyPhrases } from '../src/daily.js';
import { listSubscriptions, saveSubscription, type Db } from '../src/db.js';
import { notificationPayload } from '../src/push.js';
import { clearTables, createTestDb, insertAged } from './helpers.js';

const phone = { endpoint: 'https://push.example/phone', p256dh: 'key-1', auth: 'auth-1' };
const laptop = { endpoint: 'https://push.example/laptop', p256dh: 'key-2', auth: 'auth-2' };

let db: Db;

async function shownCount(): Promise<number> {
  const { rows } = await db.query(
    'SELECT count(*)::int AS count FROM phrases WHERE last_shown_at IS NOT NULL',
  );
  return rows[0].count;
}

function pushError(statusCode: number) {
  return Object.assign(new Error(`push failed with ${statusCode}`), { statusCode });
}

beforeAll(async () => {
  db = await createTestDb();
});

beforeEach(() => clearTables(db));

describe('sendDailyPhrases', () => {
  it('pushes eligible phrases to every device and marks them as shown', async () => {
    await insertAged(db, 'old one', 20);
    await insertAged(db, 'too new', 1);
    await saveSubscription(db, phone);
    await saveSubscription(db, laptop);
    const send = vi.fn().mockResolvedValue(undefined);

    const result = await sendDailyPhrases(db, send);

    expect(result).toEqual({ phrases: 1, devices: 2, delivered: 2, errors: [] });
    expect(send).toHaveBeenCalledTimes(2);
    expect(JSON.parse(send.mock.calls[0][1]).body).toBe('old one');
    expect(await shownCount()).toBe(1);
  });

  it('sends nothing when no phrase is old enough', async () => {
    await insertAged(db, 'too new', 1);
    await saveSubscription(db, phone);
    const send = vi.fn();

    const result = await sendDailyPhrases(db, send);

    expect(result.phrases).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it('keeps phrases unshown when no device has reminders on', async () => {
    await insertAged(db, 'old one', 20);
    const send = vi.fn();

    const result = await sendDailyPhrases(db, send);

    expect(result.devices).toBe(0);
    expect(send).not.toHaveBeenCalled();
    expect(await shownCount()).toBe(0);
  });

  it('keeps phrases unshown and reports the error when every device fails', async () => {
    await insertAged(db, 'old one', 20);
    await saveSubscription(db, phone);
    const send = vi.fn().mockRejectedValue(pushError(500));

    const result = await sendDailyPhrases(db, send);

    expect(result.delivered).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(await shownCount()).toBe(0);
    expect(await listSubscriptions(db)).toEqual([phone]);
  });

  it('marks phrases as shown when at least one device receives them', async () => {
    await insertAged(db, 'old one', 20);
    await saveSubscription(db, phone);
    await saveSubscription(db, laptop);
    const send = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(pushError(500));

    const result = await sendDailyPhrases(db, send);

    expect(result.delivered).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(await shownCount()).toBe(1);
  });

  it.each([404, 410])('removes a device whose subscription returns %i', async (status) => {
    await insertAged(db, 'old one', 20);
    await saveSubscription(db, phone);
    const send = vi.fn().mockRejectedValue(pushError(status));

    const result = await sendDailyPhrases(db, send);

    expect(result.errors).toEqual([]);
    expect(await listSubscriptions(db)).toEqual([]);
    expect(await shownCount()).toBe(0);
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
