import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  addPhrase,
  claimUnowned,
  createUser,
  deletePhrase,
  deleteSubscription,
  ensureSchema,
  findUser,
  findUserByEmail,
  importPhrases,
  isValidEmail,
  listRecent,
  listSubscriptions,
  listToday,
  listUserIdsWithDevices,
  listUsers,
  markShown,
  pickDailyPhrases,
  saveSubscription,
  setPasswordHash,
  updatePhrase,
  type Db,
  type User,
} from '../src/db.js';
import { clearTables, createTestDb, insertAged, insertUser } from './helpers.js';

let db: Db;
let alice: User;
let bob: User;

const textOf = (phrases: { text: string }[]) => phrases.map((p) => p.text);

beforeAll(async () => {
  db = await createTestDb();
});

beforeEach(async () => {
  await clearTables(db);
  alice = await insertUser(db, 'alice@example.com');
  bob = await insertUser(db, 'bob@example.com');
});

describe('users', () => {
  it('store emails trimmed and lowercased, and find them either way', async () => {
    const user = await createUser(db, '  Carol@Example.COM ', 'hash');

    expect(user.email).toBe('carol@example.com');
    expect(await findUserByEmail(db, 'CAROL@example.com')).toEqual({ ...user, passwordHash: 'hash' });
    expect(await findUser(db, user.id)).toEqual(user);
  });

  it('refuse a second user with the same email', async () => {
    // The sign-up route reads this code to answer 409 when two sign-ups race.
    await expect(createUser(db, 'ALICE@example.com', 'hash')).rejects.toMatchObject({ code: '23505' });
  });

  it('return null for unknown users', async () => {
    expect(await findUser(db, 999)).toBeNull();
    expect(await findUserByEmail(db, 'nobody@example.com')).toBeNull();
  });

  it('change a password hash', async () => {
    expect(await setPasswordHash(db, alice.id, 'new-hash')).toBe(true);
    expect((await findUserByEmail(db, alice.email))?.passwordHash).toBe('new-hash');
    expect(await setPasswordHash(db, 999, 'new-hash')).toBe(false);
  });

  it('list each user with their phrase and device counts', async () => {
    await addPhrase(db, alice.id, 'one');
    await addPhrase(db, alice.id, 'two');
    await saveSubscription(db, bob.id, { endpoint: 'https://push.example/1', p256dh: 'k', auth: 'a' });

    expect(await listUsers(db)).toEqual([
      { id: alice.id, email: alice.email, phrases: 2, devices: 0 },
      { id: bob.id, email: bob.email, phrases: 0, devices: 1 },
    ]);
  });

  it('give a user the phrases and devices saved before accounts existed', async () => {
    await insertAged(db, null, 'from before accounts', 30);
    await db.query(
      "INSERT INTO push_subscriptions (endpoint, p256dh, auth) VALUES ('https://push.example/old', 'k', 'a')",
    );

    expect(await claimUnowned(db, alice.id)).toEqual({ phrases: 1, devices: 1 });
    expect((await listRecent(db, alice.id)).map((p) => p.text)).toEqual(['from before accounts']);
    expect(await listSubscriptions(db, alice.id)).toHaveLength(1);
    expect(await claimUnowned(db, bob.id)).toEqual({ phrases: 0, devices: 0 });
  });

  it('delete their phrases and devices along with them', async () => {
    await addPhrase(db, alice.id, 'gone with alice');
    await saveSubscription(db, alice.id, { endpoint: 'https://push.example/1', p256dh: 'k', auth: 'a' });

    await db.query('DELETE FROM users WHERE id = $1', [alice.id]);

    expect((await db.query('SELECT count(*)::int AS n FROM phrases')).rows[0].n).toBe(0);
    expect(await listUserIdsWithDevices(db)).toEqual([]);
  });

  it.each([
    ['me@example.com', true],
    [' Me@Example.com ', true],
    ['me@localhost', false],
    ['me example@example.com', false],
    ['@example.com', false],
    [`${'x'.repeat(250)}@example.com`, false],
  ])('accept %j as an email: %s', (email, valid) => {
    expect(isValidEmail(email)).toBe(valid);
  });
});

describe('pickDailyPhrases', () => {
  it('only picks phrases at least 14 days old', async () => {
    await insertAged(db, alice.id, 'too new', 13);
    await insertAged(db, alice.id, 'just old enough', 14);
    await insertAged(db, alice.id, 'old', 40);

    const texts = (await pickDailyPhrases(db, alice.id)).map((p) => p.text).sort();

    expect(texts).toEqual(['just old enough', 'old']);
  });

  it("only picks the user's own phrases", async () => {
    await insertAged(db, alice.id, "alice's", 20);
    await insertAged(db, bob.id, "bob's", 20);

    expect((await pickDailyPhrases(db, alice.id)).map((p) => p.text)).toEqual(["alice's"]);
  });

  it('returns at most 3 phrases', async () => {
    for (let i = 0; i < 5; i++) await insertAged(db, alice.id, `phrase ${i}`, 20);

    expect(await pickDailyPhrases(db, alice.id)).toHaveLength(3);
  });

  it('puts never-shown phrases first, then those shown longest ago', async () => {
    await insertAged(db, alice.id, 'shown yesterday', 30, 1);
    await insertAged(db, alice.id, 'shown long ago', 30, 10);
    await insertAged(db, alice.id, 'never shown', 30);

    const texts = (await pickDailyPhrases(db, alice.id)).map((p) => p.text);

    expect(texts).toEqual(['never shown', 'shown long ago', 'shown yesterday']);
  });

  it('gives every phrase a turn before repeating one', async () => {
    for (let i = 0; i < 4; i++) await insertAged(db, alice.id, `phrase ${i}`, 20);

    const first = await pickDailyPhrases(db, alice.id);
    await markShown(db, first.map((p) => p.id));
    const second = await pickDailyPhrases(db, alice.id, 1);

    expect(first.map((p) => p.id)).not.toContain(second[0].id);
  });
});

describe('listToday', () => {
  it('returns only the latest reminder batch', async () => {
    await insertAged(db, alice.id, 'earlier batch', 30, 2);
    await insertAged(db, alice.id, 'first', 20);
    await insertAged(db, alice.id, 'second', 20);
    await insertAged(db, alice.id, 'not sent', 20);
    const all = await listRecent(db, alice.id);
    const sent = all.filter((p) => p.text === 'first' || p.text === 'second');

    await markShown(db, sent.map((p) => p.id));

    expect((await listToday(db, alice.id)).map((p) => p.text)).toEqual(['first', 'second']);
  });

  it("keeps each user's batch apart", async () => {
    await insertAged(db, alice.id, "alice's", 20);
    await insertAged(db, bob.id, "bob's", 20);
    const [alicePhrase] = await listRecent(db, alice.id);
    const [bobPhrase] = await listRecent(db, bob.id);
    await markShown(db, [alicePhrase.id]);
    await markShown(db, [bobPhrase.id]);

    expect((await listToday(db, alice.id)).map((p) => p.text)).toEqual(["alice's"]);
    expect((await listToday(db, bob.id)).map((p) => p.text)).toEqual(["bob's"]);
  });

  it('returns nothing when the latest batch is over 24 hours old', async () => {
    await insertAged(db, alice.id, 'old batch', 30, 2);

    expect(await listToday(db, alice.id)).toEqual([]);
  });

  it('returns nothing when no reminder has gone out', async () => {
    await insertAged(db, alice.id, 'never sent', 30);

    expect(await listToday(db, alice.id)).toEqual([]);
  });
});

describe('listRecent', () => {
  it("returns the user's newest phrases first, up to the limit", async () => {
    await insertAged(db, alice.id, 'oldest', 3);
    await insertAged(db, alice.id, 'middle', 2);
    await insertAged(db, alice.id, 'newest', 1);
    await insertAged(db, bob.id, "bob's", 0);

    const texts = (await listRecent(db, alice.id, 2)).map((p) => p.text);

    expect(texts).toEqual(['newest', 'middle']);
  });
});

describe('addPhrase', () => {
  it('stores the phrase with its creation date', async () => {
    const phrase = await addPhrase(db, alice.id, 'It slipped my mind.');

    expect(phrase.text).toBe('It slipped my mind.');
    expect(phrase.createdAt).toBeInstanceOf(Date);
    expect(await pickDailyPhrases(db, alice.id)).toEqual([]);
  });
});

describe('updatePhrase', () => {
  it('changes the text and keeps the creation date', async () => {
    await insertAged(db, alice.id, 'It slipt my mind.', 20);
    const [before] = await listRecent(db, alice.id);

    const updated = await updatePhrase(db, alice.id, before.id, 'It slipped my mind.');

    expect(updated).toEqual({ ...before, text: 'It slipped my mind.' });
    expect((await pickDailyPhrases(db, alice.id)).map((p) => p.text)).toEqual(['It slipped my mind.']);
  });

  it('keeps a fixed phrase in Today', async () => {
    await insertAged(db, alice.id, 'It slipt my mind.', 20);
    const [phrase] = await listRecent(db, alice.id);
    await markShown(db, [phrase.id]);

    await updatePhrase(db, alice.id, phrase.id, 'It slipped my mind.');

    expect((await listToday(db, alice.id)).map((p) => p.text)).toEqual(['It slipped my mind.']);
  });

  it("leaves another user's phrase alone", async () => {
    const phrase = await addPhrase(db, alice.id, 'mine');

    expect(await updatePhrase(db, bob.id, phrase.id, 'hijacked')).toBeNull();
    expect((await listRecent(db, alice.id)).map((p) => p.text)).toEqual(['mine']);
  });

  it('returns null when the phrase does not exist', async () => {
    expect(await updatePhrase(db, alice.id, 999, 'anything')).toBeNull();
  });
});

describe('deletePhrase', () => {
  it('removes only that phrase', async () => {
    const keep = await addPhrase(db, alice.id, 'keep me');
    const remove = await addPhrase(db, alice.id, 'remove me');

    expect(await deletePhrase(db, alice.id, remove.id)).toBe(true);
    expect((await listRecent(db, alice.id)).map((p) => p.id)).toEqual([keep.id]);
  });

  it("leaves another user's phrase alone", async () => {
    const phrase = await addPhrase(db, alice.id, 'mine');

    expect(await deletePhrase(db, bob.id, phrase.id)).toBe(false);
    expect(await listRecent(db, alice.id)).toHaveLength(1);
  });

  it('returns false when the phrase does not exist', async () => {
    expect(await deletePhrase(db, alice.id, 999)).toBe(false);
  });
});

describe('push subscriptions', () => {
  const device = { endpoint: 'https://push.example/1', p256dh: 'key-a', auth: 'auth-a' };

  it('updates the keys when the same device subscribes again', async () => {
    await saveSubscription(db, alice.id, device);
    await saveSubscription(db, alice.id, { ...device, p256dh: 'key-b' });

    expect(await listSubscriptions(db, alice.id)).toEqual([{ ...device, p256dh: 'key-b' }]);
  });

  it('moves a device to the user who subscribed it last', async () => {
    await saveSubscription(db, alice.id, device);
    await saveSubscription(db, bob.id, device);

    expect(await listSubscriptions(db, alice.id)).toEqual([]);
    expect(await listSubscriptions(db, bob.id)).toEqual([device]);
    expect(await listUserIdsWithDevices(db)).toEqual([bob.id]);
  });

  it('deletes a subscription by endpoint', async () => {
    await saveSubscription(db, alice.id, device);

    await deleteSubscription(db, device.endpoint);

    expect(await listSubscriptions(db, alice.id)).toEqual([]);
  });
});

describe('importPhrases', () => {
  it('makes imported phrases eligible at once', async () => {
    await importPhrases(db, alice.id, ['from my file']);

    const picked = await pickDailyPhrases(db, alice.id);

    expect(picked.map((p) => p.text)).toEqual(['from my file']);
  });

  it("skips the user's existing phrases but not other users'", async () => {
    await addPhrase(db, alice.id, 'already here');
    await addPhrase(db, bob.id, 'new one');

    const added = await importPhrases(db, alice.id, ['already here', 'new one', 'new one']);

    expect(added).toBe(1);
    expect(await listRecent(db, alice.id)).toHaveLength(2);
  });
});

describe('ensureSchema', () => {
  it('upgrades a database from before accounts and keeps its rows', async () => {
    const pglite = new PGlite();
    const old: Db = { query: (sql, params) => pglite.query(sql, params as any[]) };
    await old.query(`CREATE TABLE phrases (
      id SERIAL PRIMARY KEY, text TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(), last_shown_at TIMESTAMPTZ)`);
    await old.query(`CREATE TABLE push_subscriptions (
      endpoint TEXT PRIMARY KEY, p256dh TEXT NOT NULL, auth TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await old.query("INSERT INTO phrases (text) VALUES ('saved before accounts')");
    await old.query("INSERT INTO push_subscriptions (endpoint, p256dh, auth) VALUES ('https://push.example/old', 'k', 'a')");

    await ensureSchema(old);
    await ensureSchema(old); // Every start runs it again.
    const owner = await createUser(old, 'first@example.com', 'hash');

    expect(await listRecent(old, owner.id)).toEqual([]);
    expect(await claimUnowned(old, owner.id)).toEqual({ phrases: 1, devices: 1 });
    expect(textOf(await listRecent(old, owner.id))).toEqual(['saved before accounts']);
    expect(await listUserIdsWithDevices(old)).toEqual([owner.id]);
  });
});
