import { readFile } from 'node:fs/promises';
import { connect, ensureSchema, findUserByEmail, importPhrases } from './db.js';
import { requireEnv } from './env.js';

const [email, file] = process.argv.slice(2);
if (!email || !file) {
  console.error('Usage: npm run import -- <user email> <file with one phrase per line>');
  process.exit(1);
}

const lines = (await readFile(file, 'utf8'))
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean);

const db = connect(requireEnv('DATABASE_URL'));
try {
  await ensureSchema(db);
  const user = await findUserByEmail(db, email);
  if (!user) {
    console.error(`No user with the email ${email}. Create one with: npm run users -- add ${email}`);
    process.exitCode = 1;
  } else {
    const added = await importPhrases(db, user.id, lines);
    console.log(`Imported ${added} of ${lines.length} phrases for ${user.email}`);
  }
} finally {
  await db.end();
}
