import {
  claimUnowned,
  createUser,
  endAllSessions,
  endUserSessions,
  findUserByEmail,
  isValidEmail,
  listUsers,
  setPasswordHash,
  weeklyActivity,
  type Db,
} from './db.js';
import { checkNewPassword, hashPassword } from './passwords.js';

export const USAGE = `Usage:
  npm run users -- add <email>            Create a user. Asks for the password.
  npm run users -- set-password <email>   Change a user's password. Asks for the new one.
  npm run users -- list                   List users.
  npm run users -- log-out <email>        Log a user out of every device.
  npm run users -- log-out --all          Log everyone out.
  npm run users -- stats [weeks]          Each user's activity by week, for the last 4 weeks or as many as given.`;

/** A problem to report in one line, without a stack trace. */
export class CommandError extends Error {}

export interface CommandIO {
  /** Asks for the new password, twice when a person is typing it. */
  readNewPassword(): Promise<string>;
  log(line: string): void;
}

/** Runs `npm run users -- <args>`. Throws CommandError for anything the person should fix. */
export async function runUsersCommand(db: Db, args: string[], io: CommandIO): Promise<void> {
  const [command, email] = args;

  if (command === 'list' && !email) {
    const users = await listUsers(db);
    if (users.length === 0) io.log('No users yet. Create one with: npm run users -- add <email>');
    for (const user of users) {
      const role = user.isAdmin ? '\tadmin' : '';
      io.log(`${user.id}\t${user.email}\t${user.phrases} phrases\t${user.devices} devices${role}`);
    }
    return;
  }

  if (command === 'stats') {
    const weeks = email === undefined ? 4 : Number(email);
    if (!Number.isInteger(weeks) || weeks < 1 || weeks > 52) throw new CommandError('Give the weeks as a whole number from 1 to 52');
    const rows = await weeklyActivity(db, weeks);
    if (rows.length === 0) io.log(`No activity in the last ${weeks === 1 ? 'week' : `${weeks} weeks`}.`);
    for (const row of rows) {
      io.log(
        [
          row.email,
          `week of ${row.week}`,
          `${row.remindersSent} reminders`,
          `${row.remindersOpened} opened`,
          `${row.todayViewed} days with Today`,
          `${row.phrasesPracticed} phrases practiced`,
        ].join('\t'),
      );
    }
    return;
  }

  if (command === 'add' && email) {
    if (!isValidEmail(email)) throw new CommandError(`"${email}" doesn't look like an email`);
    if (await findUserByEmail(db, email)) throw new CommandError(`A user with the email ${email} already exists`);

    const user = await createUser(db, email, await hashPassword(await readValidPassword(io)));
    io.log(user.isAdmin ? `Created user ${user.email}, the admin` : `Created user ${user.email}`);

    // The first user gets what was saved before accounts existed.
    const claimed = await claimUnowned(db, user.id);
    if (claimed.phrases + claimed.devices > 0) {
      io.log(`Gave them ${claimed.phrases} existing phrases and ${claimed.devices} devices`);
    }
    return;
  }

  if (command === 'set-password' && email) {
    const user = await findUserByEmail(db, email);
    if (!user) throw new CommandError(`No user with the email ${email}`);

    await setPasswordHash(db, user.id, await hashPassword(await readValidPassword(io)));
    // Whoever knew the old password may still be logged in somewhere.
    const ended = await endUserSessions(db, user.id);
    io.log(`Changed the password for ${user.email} and logged them out of ${devices(ended)}.`);
    return;
  }

  if (command === 'log-out' && email === '--all') {
    io.log(`Logged everyone out of ${devices(await endAllSessions(db))}.`);
    return;
  }

  if (command === 'log-out' && email) {
    const user = await findUserByEmail(db, email);
    if (!user) throw new CommandError(`No user with the email ${email}`);

    io.log(`Logged ${user.email} out of ${devices(await endUserSessions(db, user.id))}.`);
    return;
  }

  throw new CommandError(USAGE);
}

const devices = (count: number) => (count === 1 ? '1 device' : `${count} devices`);

async function readValidPassword(io: CommandIO): Promise<string> {
  const password = await io.readNewPassword();
  const problem = checkNewPassword(password);
  if (problem) throw new CommandError(problem);
  return password;
}
