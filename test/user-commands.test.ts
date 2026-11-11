import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { findUserByEmail, listRecent, recordActivity, type Db } from '../src/db.js';
import { verifyPassword } from '../src/passwords.js';
import { CommandError, runUsersCommand, USAGE } from '../src/user-commands.js';
import { clearTables, createTestDb, insertAged, insertUser, openSession } from './helpers.js';

const PASSWORD = 'a long enough password';

let db: Db;
let lines: string[];

function run(args: string[], password = PASSWORD) {
  return runUsersCommand(db, args, { readNewPassword: async () => password, log: (line) => lines.push(line) });
}

beforeAll(async () => {
  db = await createTestDb();
});

/** Open sessions by user id, for each user. */
async function sessionCount(): Promise<Record<number, number>> {
  const { rows } = await db.query(
    'SELECT u.id, count(s.id)::int AS sessions FROM users u LEFT JOIN sessions s ON s.user_id = u.id GROUP BY u.id',
  );
  return Object.fromEntries(rows.map((row) => [row.id, row.sessions]));
}

beforeEach(async () => {
  await clearTables(db);
  lines = [];
});

describe('npm run users -- add', () => {
  it('creates a user who can log in with the password', async () => {
    await run(['add', 'Me@Example.com']);

    const user = await findUserByEmail(db, 'me@example.com');
    expect(user?.email).toBe('me@example.com');
    expect(await verifyPassword(PASSWORD, user!.passwordHash)).toBe(true);
    expect(lines).toEqual(['Created user me@example.com, the admin']);
    expect(user?.isAdmin).toBe(true);
  });

  it('gives the new user the phrases saved before accounts existed', async () => {
    await insertAged(db, null, 'from before accounts', 30);

    await run(['add', 'me@example.com']);

    const user = await findUserByEmail(db, 'me@example.com');
    expect((await listRecent(db, user!.id)).map((p) => p.text)).toEqual(['from before accounts']);
    expect(lines).toContain('Gave them 1 existing phrases and 0 devices');
  });

  it('refuses an email that is taken, before asking for a password', async () => {
    await insertUser(db, 'me@example.com');
    let asked = false;

    const attempt = runUsersCommand(db, ['add', 'ME@example.com'], {
      readNewPassword: async () => {
        asked = true;
        return PASSWORD;
      },
      log: () => {},
    });

    await expect(attempt).rejects.toThrow('A user with the email ME@example.com already exists');
    expect(asked).toBe(false);
  });

  it.each([
    ['an invalid email', ['add', 'not-an-email'], PASSWORD, `"not-an-email" doesn't look like an email`],
    ['a short password', ['add', 'me@example.com'], 'short', 'Use at least 12 characters'],
  ])('refuses %s', async (_name, args, password, message) => {
    await expect(run(args, password)).rejects.toThrow(message);
    expect(await findUserByEmail(db, 'me@example.com')).toBeNull();
  });
});

describe('npm run users -- set-password', () => {
  it('replaces the password', async () => {
    await run(['add', 'me@example.com']);

    await run(['set-password', 'me@example.com'], 'a brand new password');

    const user = await findUserByEmail(db, 'me@example.com');
    expect(await verifyPassword('a brand new password', user!.passwordHash)).toBe(true);
    expect(await verifyPassword(PASSWORD, user!.passwordHash)).toBe(false);
  });

  it('refuses an unknown email', async () => {
    await expect(run(['set-password', 'nobody@example.com'])).rejects.toThrow('No user with the email nobody@example.com');
  });

  it('logs the user out of every device, since someone may know the old password', async () => {
    const user = await insertUser(db, 'me@example.com');
    const friend = await insertUser(db, 'friend@example.com');
    await openSession(db, user.id);
    await openSession(db, user.id);
    await openSession(db, friend.id);

    await run(['set-password', 'me@example.com'], 'a brand new password');

    expect(lines.at(-1)).toBe('Changed the password for me@example.com and logged them out of 2 devices.');
    expect(await sessionCount()).toEqual({ [user.id]: 0, [friend.id]: 1 });
  });
});

describe('npm run users -- log-out', () => {
  it('logs one user out of every device', async () => {
    const user = await insertUser(db, 'me@example.com');
    const friend = await insertUser(db, 'friend@example.com');
    await openSession(db, user.id);
    await openSession(db, friend.id);

    await run(['log-out', 'Me@Example.com']);

    expect(lines).toEqual(['Logged me@example.com out of 1 device.']);
    expect(await sessionCount()).toEqual({ [user.id]: 0, [friend.id]: 1 });
  });

  it('logs everyone out with --all', async () => {
    const user = await insertUser(db, 'me@example.com');
    const friend = await insertUser(db, 'friend@example.com');
    await openSession(db, user.id);
    await openSession(db, friend.id);

    await run(['log-out', '--all']);

    expect(lines).toEqual(['Logged everyone out of 2 devices.']);
    expect(await sessionCount()).toEqual({ [user.id]: 0, [friend.id]: 0 });
  });

  it('refuses an unknown email', async () => {
    await expect(run(['log-out', 'nobody@example.com'])).rejects.toThrow('No user with the email nobody@example.com');
  });
});

describe('npm run users -- list', () => {
  it('lists users with their phrase and device counts', async () => {
    const user = await insertUser(db, 'me@example.com');
    const friend = await insertUser(db, 'friend@example.com');
    await insertAged(db, user.id, 'one', 1);

    await run(['list']);

    expect(lines).toEqual([
      `${user.id}\tme@example.com\t1 phrases\t0 devices\tadmin`,
      `${friend.id}\tfriend@example.com\t0 phrases\t0 devices`,
    ]);
  });

  it('says how to start when there are no users', async () => {
    await run(['list']);

    expect(lines).toEqual(['No users yet. Create one with: npm run users -- add <email>']);
  });
});

it.each([[['delete', 'me@example.com']], [['add']], [['list', 'extra']]])('shows the usage for %j', async (args) => {
  const attempt = run(args);

  await expect(attempt).rejects.toBeInstanceOf(CommandError);
  await expect(attempt).rejects.toThrow(USAGE);
});

describe('npm run users -- stats', () => {
  /** A day as YYYY-MM-DD, counted back from today by the database's clock, and the Monday of its week. */
  async function daysAgo(days: number): Promise<{ day: string; week: string }> {
    const { rows } = await db.query(
      `SELECT to_char(current_date - $1::int, 'YYYY-MM-DD') AS day,
              to_char(date_trunc('week', current_date - $1::int), 'YYYY-MM-DD') AS week`,
      [days],
    );
    return rows[0];
  }

  it("shows each user's weeks: reminder days sent and opened, days with Today, and phrases practiced", async () => {
    const user = await insertUser(db, 'me@example.com');
    const { day, week } = await daysAgo(0);
    await recordActivity(db, user.id, day, 'reminder_sent');
    await recordActivity(db, user.id, day, 'reminder_opened');
    await recordActivity(db, user.id, day, 'today_viewed');
    await recordActivity(db, user.id, day, 'phrase_heard', 1);
    await recordActivity(db, user.id, day, 'phrase_translated', 1);
    await recordActivity(db, user.id, day, 'phrase_scored', 2);

    await run(['stats']);

    expect(lines).toEqual([
      `me@example.com\tweek of ${week}\t1 reminders\t1 opened\t1 days with Today\t2 phrases practiced`,
    ]);
  });

  it('leaves out weeks before the ones asked for', async () => {
    const user = await insertUser(db, 'me@example.com');
    await recordActivity(db, user.id, (await daysAgo(70)).day, 'reminder_sent');
    const recent = await daysAgo(0);
    await recordActivity(db, user.id, recent.day, 'reminder_sent');

    await run(['stats']);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`week of ${recent.week}`);

    lines = [];
    await run(['stats', '12']);
    expect(lines).toHaveLength(2);
  });

  it('says when there is no activity', async () => {
    await run(['stats', '1']);

    expect(lines).toEqual(['No activity in the last week.']);
  });

  it.each(['0', '53', 'two', '1.5'])('refuses %s weeks', async (weeks) => {
    await expect(run(['stats', weeks])).rejects.toThrow('Give the weeks as a whole number from 1 to 52');
  });
});
