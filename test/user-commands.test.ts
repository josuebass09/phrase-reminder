import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { findUserByEmail, listRecent, type Db } from '../src/db.js';
import { verifyPassword } from '../src/passwords.js';
import { CommandError, runUsersCommand, USAGE } from '../src/user-commands.js';
import { clearTables, createTestDb, insertAged, insertUser } from './helpers.js';

const PASSWORD = 'a long enough password';

let db: Db;
let lines: string[];

function run(args: string[], password = PASSWORD) {
  return runUsersCommand(db, args, { readNewPassword: async () => password, log: (line) => lines.push(line) });
}

beforeAll(async () => {
  db = await createTestDb();
});

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
    expect(lines).toEqual(['Created user me@example.com']);
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
});

describe('npm run users -- list', () => {
  it('lists users with their phrase and device counts', async () => {
    const user = await insertUser(db, 'me@example.com');
    await insertAged(db, user.id, 'one', 1);

    await run(['list']);

    expect(lines).toEqual([`${user.id}\tme@example.com\t1 phrases\t0 devices`]);
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
