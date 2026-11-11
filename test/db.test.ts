import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  aiQuotas,
  reviewPhrase,
  undoReview,
  cronRunsSince,
  recordCronRun,
  aiUsageSince,
  recordAiUse,
  addPhrase,
  claimInvite,
  claimUnowned,
  createInvite,
  createUser,
  dailyUses,
  deletePhrase,
  deleteSubscription,
  ensureSchema,
  findPhraseTranslation,
  findUser,
  findUserByEmail,
  finishInvite,
  importPhrases,
  isInviteUsable,
  isValidEmail,
  listRecent,
  listSubscriptions,
  listToday,
  listReminderCandidates,
  listUsers,
  markShown,
  pickDailyPhrases,
  releaseDailyUse,
  reserveDailyUse,
  saveSubscription,
  saveTranslation,
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

  it('make only the first user the admin', async () => {
    expect([alice.isAdmin, bob.isAdmin]).toEqual([true, false]);
    expect((await createUser(db, 'carol@example.com', 'hash')).isAdmin).toBe(false);
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
      { id: alice.id, email: alice.email, isAdmin: true, phrases: 2, devices: 0 },
      { id: bob.id, email: bob.email, isAdmin: false, phrases: 0, devices: 1 },
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
    expect((await listReminderCandidates(db)).map((candidate) => candidate.userId)).toEqual([]);
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

describe('invites', () => {
  it('can be claimed once, until they expire', async () => {
    const { expiresAt } = await createInvite(db, alice.id, 'hash-1', 7);

    expect(expiresAt.getTime() - Date.now()).toBeGreaterThan(7 * 24 * 3600_000 - 60_000);
    expect(await isInviteUsable(db, 'hash-1')).toBe(true);
    const id = await claimInvite(db, 'hash-1');
    expect(id).toEqual(expect.any(Number));
    expect(await isInviteUsable(db, 'hash-1')).toBe(false);
    expect(await claimInvite(db, 'hash-1')).toBeNull();
  });

  it('can be freed again when the sign-up fails', async () => {
    await createInvite(db, alice.id, 'hash-1', 7);
    const id = (await claimInvite(db, 'hash-1'))!;

    await finishInvite(db, id, null);

    expect(await claimInvite(db, 'hash-1')).toBe(id);
  });

  it('are unusable once expired or for an unknown hash', async () => {
    await createInvite(db, alice.id, 'hash-1', 7);
    await db.query("UPDATE invites SET expires_at = now() - interval '1 second'");

    expect(await isInviteUsable(db, 'hash-1')).toBe(false);
    expect(await claimInvite(db, 'hash-1')).toBeNull();
    expect(await claimInvite(db, 'unknown')).toBeNull();
  });

  it('disappear with the admin who made them', async () => {
    await createInvite(db, alice.id, 'hash-1', 7);

    await db.query('DELETE FROM users WHERE id = $1', [alice.id]);

    expect(await isInviteUsable(db, 'hash-1')).toBe(false);
  });
});

describe('daily limits', () => {
  const reserve = (user: User, day: string, limit: number) => reserveDailyUse(db, user.id, 'translations', day, limit);
  const used = (user: User, day: string) => dailyUses(db, user.id, 'translations', day);

  it('count up to the limit, per user and day', async () => {
    expect(await reserve(bob, '2026-11-10', 2)).toBe(true);
    expect(await reserve(bob, '2026-11-10', 2)).toBe(true);
    expect(await reserve(bob, '2026-11-10', 2)).toBe(false);
    expect(await used(bob, '2026-11-10')).toBe(2);
    expect(await used(alice, '2026-11-10')).toBe(0);
  });

  it('start over on a new day', async () => {
    await reserve(bob, '2026-11-10', 1);

    expect(await reserve(bob, '2026-11-11', 1)).toBe(true);
    expect(await used(bob, '2026-11-11')).toBe(1);
    expect(await used(bob, '2026-11-12')).toBe(0);
  });

  it('give back a use that did not happen', async () => {
    await reserve(bob, '2026-11-10', 1);

    await releaseDailyUse(db, bob.id, 'translations', '2026-11-10');

    expect(await used(bob, '2026-11-10')).toBe(0);
    expect(await reserve(bob, '2026-11-10', 1)).toBe(true);
  });

  it('keep translations and suggestions apart', async () => {
    await reserve(bob, '2026-11-10', 1);

    expect(await reserveDailyUse(db, bob.id, 'suggestions', '2026-11-10', 1)).toBe(true);
    expect(await reserveDailyUse(db, bob.id, 'suggestions', '2026-11-10', 1)).toBe(false);
    await releaseDailyUse(db, bob.id, 'suggestions', '2026-11-10');
    expect(await dailyUses(db, bob.id, 'suggestions', '2026-11-10')).toBe(0);
    expect(await used(bob, '2026-11-10')).toBe(1);
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

describe('spaced repetition', () => {
  const HOUR = 3_600_000;
  async function phrase(text = 'It slipped my mind.') {
    await insertAged(db, alice.id, text, 20);
    return (await listRecent(db, alice.id)).find((each) => each.text === text)!.id;
  }
  const scheduleOf = async (id: number) =>
    (await db.query('SELECT box, due_at FROM phrases WHERE id = $1', [id])).rows[0] as { box: number | null; due_at: Date | null };
  /** Hours from now until it's due. */
  const hoursUntilDue = async (id: number) => ((await scheduleOf(id)).due_at!.getTime() - Date.now()) / HOUR;

  it('moves a remembered phrase up a box each time, back in 7, 14, 30, then 60 days', async () => {
    const id = await phrase();
    const days = [];
    for (let i = 0; i < 6; i++) days.push((await reviewPhrase(db, alice.id, id, 'remembered'))!.days);

    expect(days).toEqual([7, 14, 30, 60, 60, 60]);
    expect((await scheduleOf(id)).box).toBe(4);
  });

  it('puts a phrase that was only read in box 0, back in 2 days, from any box', async () => {
    const id = await phrase();
    await reviewPhrase(db, alice.id, id, 'remembered');
    await reviewPhrase(db, alice.id, id, 'remembered');

    expect(await reviewPhrase(db, alice.id, id, 'read')).toEqual({ box: 0, days: 2 });
    expect((await scheduleOf(id)).box).toBe(0);
  });

  it("makes it due 12 hours before the days are up, so it's in that day's reminder at any time", async () => {
    const id = await phrase();

    await reviewPhrase(db, alice.id, id, 'remembered');

    expect(await hoursUntilDue(id)).toBeCloseTo(7 * 24 - 12, 0);
  });

  it('puts back the box and due date it had when undone', async () => {
    const id = await phrase();
    await reviewPhrase(db, alice.id, id, 'remembered');
    const before = await scheduleOf(id);

    await reviewPhrase(db, alice.id, id, 'read');
    expect(await undoReview(db, alice.id, id)).toBe(true);

    expect(await scheduleOf(id)).toEqual(before);
  });

  it("answers null and false for another user's phrase", async () => {
    const id = await phrase();

    expect(await reviewPhrase(db, bob.id, id, 'read')).toBeNull();
    expect(await undoReview(db, bob.id, id)).toBe(false);
    expect((await scheduleOf(id)).box).toBeNull();
  });

  it("leaves a scheduled phrase out of the reminder until it's due, and puts the due ones first", async () => {
    const waiting = await phrase('remembered, not due');
    const due = await phrase('read, now due');
    await phrase('never answered');
    await reviewPhrase(db, alice.id, waiting, 'remembered');
    await reviewPhrase(db, alice.id, due, 'read');
    await db.query("UPDATE phrases SET due_at = now() - interval '1 hour' WHERE id = $1", [due]);

    const texts = (await pickDailyPhrases(db, alice.id)).map((p) => p.text);

    expect(texts).toEqual(['read, now due', 'never answered']);
  });

  it('brings a sent phrase that went unanswered back tomorrow, behind any due longer', async () => {
    const unanswered = await phrase('sent, not answered');
    const overdue = await phrase('overdue for days');
    for (const id of [unanswered, overdue]) await reviewPhrase(db, alice.id, id, 'read');
    await db.query("UPDATE phrases SET due_at = now() - interval '3 days' WHERE id = $1", [overdue]);
    await db.query("UPDATE phrases SET due_at = now() - interval '1 hour' WHERE id = $1", [unanswered]);

    await markShown(db, [unanswered]);

    expect(await hoursUntilDue(unanswered)).toBeCloseTo(12, 0); // Tomorrow's reminder, not today's.
    await db.query("UPDATE phrases SET due_at = due_at - interval '1 day'"); // A day later.
    expect((await pickDailyPhrases(db, alice.id, 1)).map((p) => p.text)).toEqual(['overdue for days']);
  });

  it('starts the spacing over when the text changes', async () => {
    const id = await phrase();
    await reviewPhrase(db, alice.id, id, 'remembered');

    await updatePhrase(db, alice.id, id, 'It totally slipped my mind.');

    expect(await scheduleOf(id)).toEqual({ box: null, due_at: null });
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

  it('leaves out a phrase reviewed since it was sent', async () => {
    await insertAged(db, alice.id, 'first', 20);
    await insertAged(db, alice.id, 'second', 20);
    const sent = await listRecent(db, alice.id);
    await markShown(db, sent.map((p) => p.id));

    await reviewPhrase(db, alice.id, sent.find((p) => p.text === 'first')!.id, 'remembered');

    expect((await listToday(db, alice.id)).map((p) => p.text)).toEqual(['second']);
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

    const texts = (await listRecent(db, alice.id, { limit: 2 })).map((p) => p.text);

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

  it('stores a translation that comes with the phrase, and none without one', async () => {
    const picked = await addPhrase(db, alice.id, 'Could you take a look?', '¿Podrías revisarlo?');
    const typed = await addPhrase(db, alice.id, 'Hello.');

    expect(await findPhraseTranslation(db, alice.id, picked.id)).toEqual({
      text: 'Could you take a look?',
      translation: '¿Podrías revisarlo?',
    });
    expect((await findPhraseTranslation(db, alice.id, typed.id))?.translation).toBeNull();
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

  it('drops the saved translation when the text changes, and keeps it when it does not', async () => {
    const phrase = await addPhrase(db, alice.id, 'Hello.');
    await saveTranslation(db, alice.id, phrase.id, 'Hello.', 'Hola.');

    await updatePhrase(db, alice.id, phrase.id, 'Hello.');
    expect((await findPhraseTranslation(db, alice.id, phrase.id))?.translation).toBe('Hola.');
    await updatePhrase(db, alice.id, phrase.id, 'Hello there.');
    expect(await findPhraseTranslation(db, alice.id, phrase.id)).toEqual({ text: 'Hello there.', translation: null });
  });

  it('saves no translation for text that changed while it was being translated', async () => {
    const phrase = await addPhrase(db, alice.id, 'Hello there.');

    await saveTranslation(db, alice.id, phrase.id, 'Hello.', 'Hola.');

    expect((await findPhraseTranslation(db, alice.id, phrase.id))?.translation).toBeNull();
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
    expect((await listReminderCandidates(db)).map((candidate) => candidate.userId)).toEqual([bob.id]);
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

describe('AI usage', () => {
  const day = (iso: string) => new Date(`${iso}T12:00:00Z`);

  it("adds up each service's requests on their UTC day", async () => {
    await recordAiUse(db, { service: 'groq_chat', ok: true, rateLimited: false, units: 300 }, day('2026-11-10'));
    await recordAiUse(db, { service: 'groq_chat', ok: false, rateLimited: true, units: 0 }, day('2026-11-11'));
    await recordAiUse(db, { service: 'groq_chat', ok: true, rateLimited: false, units: 250 }, day('2026-11-11'));
    await recordAiUse(db, { service: 'mymemory', ok: true, rateLimited: false, units: 42 }, day('2026-11-11'));

    expect(await aiUsageSince(db, 30, day('2026-11-11'))).toEqual([
      { day: '2026-11-10', service: 'groq_chat', calls: 1, failures: 0, rateLimited: 0, units: 300 },
      { day: '2026-11-11', service: 'groq_chat', calls: 2, failures: 1, rateLimited: 1, units: 250 },
      { day: '2026-11-11', service: 'mymemory', calls: 1, failures: 0, rateLimited: 0, units: 42 },
    ]);
  });

  it('gives only the last days asked for, today included', async () => {
    await recordAiUse(db, { service: 'groq_speech', ok: true, rateLimited: false, units: 3 }, day('2026-11-01'));
    await recordAiUse(db, { service: 'groq_speech', ok: true, rateLimited: false, units: 4 }, day('2026-11-02'));

    const days = await aiUsageSince(db, 10, day('2026-11-11'));

    expect(days.map((row) => row.day)).toEqual(['2026-11-02']);
  });

  it("keeps the latest of what Groq said is left of each model's daily requests", async () => {
    const chat = { service: 'groq_chat', ok: true, rateLimited: false, units: 1 } as const;
    await recordAiUse(db, { ...chat, quota: { limit: 1000, left: 900 } }, new Date('2026-11-11T10:00:00Z'));
    await recordAiUse(db, { ...chat, quota: { limit: 1000, left: 899 } }, new Date('2026-11-11T10:05:00Z'));
    await recordAiUse(db, chat); // Without headers, the last one stays.

    expect(await aiQuotas(db)).toEqual([
      { service: 'groq_chat', limit: 1000, left: 899, checkedAt: new Date('2026-11-11T10:05:00Z') },
    ]);
  });
});

describe('cron runs', () => {
  const run = (startedAt: string, changes: Partial<Parameters<typeof recordCronRun>[1]> = {}) => ({
    startedAt: new Date(startedAt),
    finishedAt: new Date(new Date(startedAt).getTime() + 2000),
    users: 2,
    devices: 3,
    delivered: 3,
    removed: 0,
    errors: 0,
    firstError: null,
    version: 'abc1234',
    ...changes,
  });

  it('keeps each run, newest first', async () => {
    await recordCronRun(db, run('2026-11-11T12:00:00Z'));
    await recordCronRun(db, run('2026-11-11T12:15:00Z', { errors: 1, delivered: 2, firstError: 'Push service down' }));

    const runs = await cronRunsSince(db, new Date('2026-11-11T00:00:00Z'));

    expect(runs.map((each) => [each.startedAt.toISOString(), each.errors, each.firstError])).toEqual([
      ['2026-11-11T12:15:00.000Z', 1, 'Push service down'],
      ['2026-11-11T12:00:00.000Z', 0, null],
    ]);
    expect(runs[0]).toMatchObject({ users: 2, devices: 3, delivered: 2, removed: 0, version: 'abc1234' });
  });

  it('drops runs older than 30 days', async () => {
    await recordCronRun(db, run('2026-10-01T12:00:00Z'));
    await recordCronRun(db, run('2026-11-11T12:00:00Z'));

    const runs = await cronRunsSince(db, new Date('2026-01-01T00:00:00Z'));

    expect(runs).toHaveLength(1);
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
    expect((await listReminderCandidates(old)).map((candidate) => candidate.userId)).toEqual([owner.id]);
  });

  it('makes the oldest user the admin of a database from before admins', async () => {
    const pglite = new PGlite();
    const old: Db = { query: (sql, params) => pglite.query(sql, params as any[]) };
    await old.query(`CREATE TABLE users (
      id SERIAL PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await old.query("INSERT INTO users (email, password_hash) VALUES ('first@example.com', 'h'), ('second@example.com', 'h')");

    await ensureSchema(old);
    await ensureSchema(old);

    expect((await listUsers(old)).map((user) => [user.email, user.isAdmin])).toEqual([
      ['first@example.com', true],
      ['second@example.com', false],
    ]);
  });
});
