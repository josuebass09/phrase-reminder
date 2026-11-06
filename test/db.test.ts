import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  addPhrase,
  deleteSubscription,
  importPhrases,
  listRecent,
  listSubscriptions,
  listToday,
  markShown,
  pickDailyPhrases,
  saveSubscription,
  type Db,
} from '../src/db.js';
import { clearTables, createTestDb, insertAged } from './helpers.js';

let db: Db;

beforeAll(async () => {
  db = await createTestDb();
});

beforeEach(() => clearTables(db));

describe('pickDailyPhrases', () => {
  it('only picks phrases at least 14 days old', async () => {
    await insertAged(db, 'too new', 13);
    await insertAged(db, 'just old enough', 14);
    await insertAged(db, 'old', 40);

    const texts = (await pickDailyPhrases(db)).map((p) => p.text).sort();

    expect(texts).toEqual(['just old enough', 'old']);
  });

  it('returns at most 3 phrases', async () => {
    for (let i = 0; i < 5; i++) await insertAged(db, `phrase ${i}`, 20);

    expect(await pickDailyPhrases(db)).toHaveLength(3);
  });

  it('puts never-shown phrases first, then those shown longest ago', async () => {
    await insertAged(db, 'shown yesterday', 30, 1);
    await insertAged(db, 'shown long ago', 30, 10);
    await insertAged(db, 'never shown', 30);

    const texts = (await pickDailyPhrases(db)).map((p) => p.text);

    expect(texts).toEqual(['never shown', 'shown long ago', 'shown yesterday']);
  });

  it('gives every phrase a turn before repeating one', async () => {
    for (let i = 0; i < 4; i++) await insertAged(db, `phrase ${i}`, 20);

    const first = await pickDailyPhrases(db);
    await markShown(db, first.map((p) => p.id));
    const second = await pickDailyPhrases(db, 1);

    expect(first.map((p) => p.id)).not.toContain(second[0].id);
  });
});

describe('listToday', () => {
  it('returns only the latest reminder batch', async () => {
    await insertAged(db, 'earlier batch', 30, 2);
    await insertAged(db, 'first', 20);
    await insertAged(db, 'second', 20);
    await insertAged(db, 'not sent', 20);
    const all = await listRecent(db);
    const sent = all.filter((p) => p.text === 'first' || p.text === 'second');

    await markShown(db, sent.map((p) => p.id));

    expect((await listToday(db)).map((p) => p.text)).toEqual(['first', 'second']);
  });

  it('returns nothing when the latest batch is over 24 hours old', async () => {
    await insertAged(db, 'old batch', 30, 2);

    expect(await listToday(db)).toEqual([]);
  });

  it('returns nothing when no reminder has gone out', async () => {
    await insertAged(db, 'never sent', 30);

    expect(await listToday(db)).toEqual([]);
  });
});

describe('listRecent', () => {
  it('returns the newest phrases first, up to the limit', async () => {
    await insertAged(db, 'oldest', 3);
    await insertAged(db, 'middle', 2);
    await insertAged(db, 'newest', 1);

    const texts = (await listRecent(db, 2)).map((p) => p.text);

    expect(texts).toEqual(['newest', 'middle']);
  });
});

describe('addPhrase', () => {
  it('stores the phrase with its creation date', async () => {
    const phrase = await addPhrase(db, 'It slipped my mind.');

    expect(phrase.text).toBe('It slipped my mind.');
    expect(phrase.createdAt).toBeInstanceOf(Date);
    expect(await pickDailyPhrases(db)).toEqual([]);
  });
});

describe('push subscriptions', () => {
  const device = { endpoint: 'https://push.example/1', p256dh: 'key-a', auth: 'auth-a' };

  it('updates the keys when the same device subscribes again', async () => {
    await saveSubscription(db, device);
    await saveSubscription(db, { ...device, p256dh: 'key-b' });

    expect(await listSubscriptions(db)).toEqual([{ ...device, p256dh: 'key-b' }]);
  });

  it('deletes a subscription by endpoint', async () => {
    await saveSubscription(db, device);

    await deleteSubscription(db, device.endpoint);

    expect(await listSubscriptions(db)).toEqual([]);
  });
});

describe('importPhrases', () => {
  it('makes imported phrases eligible at once', async () => {
    await importPhrases(db, ['from my file']);

    const picked = await pickDailyPhrases(db);

    expect(picked.map((p) => p.text)).toEqual(['from my file']);
  });

  it('skips phrases that already exist', async () => {
    await addPhrase(db, 'already here');

    const added = await importPhrases(db, ['already here', 'new one', 'new one']);

    expect(added).toBe(1);
    expect(await listRecent(db)).toHaveLength(2);
  });
});
