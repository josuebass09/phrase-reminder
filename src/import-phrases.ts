import { readFile } from 'node:fs/promises';
import { connect, ensureSchema, importPhrases } from './db.js';
import { requireEnv } from './env.js';

const file = process.argv[2];
if (!file) {
  console.error('Usage: npm run import -- <file with one phrase per line>');
  process.exit(1);
}

const lines = (await readFile(file, 'utf8'))
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean);

const db = connect(requireEnv('DATABASE_URL'));
try {
  await ensureSchema(db);
  const added = await importPhrases(db, lines);
  console.log(`Imported ${added} of ${lines.length} phrases`);
} finally {
  await db.end();
}
