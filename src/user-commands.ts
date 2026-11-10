import {
  claimUnowned,
  createUser,
  findUserByEmail,
  isValidEmail,
  listUsers,
  setPasswordHash,
  type Db,
} from './db.js';
import { checkNewPassword, hashPassword } from './passwords.js';

export const USAGE = `Usage:
  npm run users -- add <email>            Create a user. Asks for the password.
  npm run users -- set-password <email>   Change a user's password. Asks for the new one.
  npm run users -- list                   List users.`;

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
    for (const user of users) io.log(`${user.id}\t${user.email}\t${user.phrases} phrases\t${user.devices} devices`);
    return;
  }

  if (command === 'add' && email) {
    if (!isValidEmail(email)) throw new CommandError(`"${email}" doesn't look like an email`);
    if (await findUserByEmail(db, email)) throw new CommandError(`A user with the email ${email} already exists`);

    const user = await createUser(db, email, await hashPassword(await readValidPassword(io)));
    io.log(`Created user ${user.email}`);

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
    io.log(`Changed the password for ${user.email}. Devices already logged in stay so until their token expires.`);
    return;
  }

  throw new CommandError(USAGE);
}

async function readValidPassword(io: CommandIO): Promise<string> {
  const password = await io.readNewPassword();
  const problem = checkNewPassword(password);
  if (problem) throw new CommandError(problem);
  return password;
}
