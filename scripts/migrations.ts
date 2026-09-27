import { readFile, readdir } from 'node:fs/promises';
import { URL as NodeURL } from 'node:url';
// The same ordered forward SQL files are used by Wrangler and local tests.
export async function applyMigrations(
  db: D1Database,
  name: 'private' | 'public',
  through = Infinity,
) {
  await db.exec(
    'CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE NOT NULL,applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)',
  );
  const dir = new NodeURL('../migrations/' + name + '/', import.meta.url);
  const files = (await readdir(dir)).filter((f) => /^\d+.*\.sql$/.test(f)).sort();
  for (const file of files) {
    if (Number(file.slice(0, 4)) > through) continue;
    if (await db.prepare('SELECT name FROM d1_migrations WHERE name=?').bind(file).first())
      continue;
    // Existing Phase 1 local stores predate the migration journal.
    const baseline =
      file === '0001_initial.sql' &&
      (await db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
        .bind(name === 'private' ? 'sources' : 'source_publications')
        .first());
    if (!baseline)
      await db.exec(
        (await readFile(new NodeURL(file, dir), 'utf8')).replace(/^--.*$/gm, '').trim(),
      );
    await db.prepare('INSERT INTO d1_migrations(name) VALUES (?)').bind(file).run();
  }
}
