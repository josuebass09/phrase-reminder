import { stdin, stdout } from 'node:process';
import { connect, ensureSchema } from './db.js';
import { requireEnv } from './env.js';
import { CommandError, runUsersCommand, USAGE } from './user-commands.js';

/** Reads a line without echoing it. Piped input works too: its first line is the answer. */
async function readSecret(prompt: string): Promise<string> {
  if (!stdin.isTTY) {
    let input = '';
    for await (const chunk of stdin) input += chunk;
    return input.split(/\r?\n/)[0] ?? '';
  }
  stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.setEncoding('utf8');
  stdin.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = () => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write('\n');
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') {
          finish();
          return resolve(value);
        }
        if (char === '\u0003') {
          finish();
          return reject(new CommandError('Cancelled'));
        }
        value = char === '\u007f' || char === '\b' ? [...value].slice(0, -1).join('') : value + char;
      }
    };
    stdin.on('data', onData);
  });
}

async function readNewPassword(): Promise<string> {
  const password = await readSecret('Password: ');
  if (stdin.isTTY && (await readSecret('Repeat the password: ')) !== password) {
    throw new CommandError("The passwords don't match");
  }
  return password;
}

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error(USAGE);
  process.exit(1);
}

const db = connect(requireEnv('DATABASE_URL'));
try {
  await ensureSchema(db);
  await runUsersCommand(db, args, { readNewPassword, log: (line) => console.log(line) });
} catch (error) {
  console.error(error instanceof CommandError ? error.message : error);
  process.exitCode = 1;
} finally {
  await db.end();
}
