import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const DB_PATH =
  process.env.DB_PATH || path.join(__dirname, '..', '..', 'data', 'recovery.sqlite');

let _db;

/** Open (and migrate) the SQLite database. Cached per process. */
export function getDb() {
  if (_db) return _db;

  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  _db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  return _db;
}

/**
 * A throwaway database, schema and all, that lives only in this process.
 *
 * The live simulator runs the real engine over one hand-entered failure. That
 * engine writes cases, interventions and audit rows as it goes — which is the
 * point, it is the same code path as the batch — but those rows must not land
 * in the real book, where they would move the dashboard totals and the priors
 * every score is measured against. Giving it its own empty database is cheaper
 * and far safer than teaching the runner not to persist.
 */
export function createScratchDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  return db;
}

/** Drop every table. Used by `npm run reset` so demos start from a clean slate. */
export function resetDb() {
  const db = getDb();
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((r) => r.name);

  db.pragma('foreign_keys = OFF');
  const drop = db.transaction(() => {
    for (const t of tables) db.exec(`DROP TABLE IF EXISTS "${t}"`);
  });
  drop();
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  return tables;
}
