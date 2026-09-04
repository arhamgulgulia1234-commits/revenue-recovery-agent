/**
 * Forward migrations for a database that already exists.
 *
 * `schema.sql` is all `CREATE TABLE IF NOT EXISTS`, which means it creates a new
 * database correctly and silently does nothing to an old one. Anyone holding a
 * seeded book from a previous version would otherwise get a database whose
 * tables are missing the columns the engine now writes, and the failure would
 * surface as a confusing SQL error deep inside a batch run.
 *
 * Every step here is idempotent and safe to run on every open.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Columns added after the first release, per table. */
const ADDED_COLUMNS = {
  payment_attempts: {
    source: "TEXT NOT NULL DEFAULT 'seed'",
  },
  recovery_cases: {
    next_action_at: 'TEXT',
    awaiting_log_id: 'TEXT',
    delivery_mode: "TEXT NOT NULL DEFAULT 'simulated'",
    contact_phone: 'TEXT',
    payment_link_id: 'TEXT',
    payment_link_url: 'TEXT',
    payment_link_ref: 'TEXT',
    payment_link_status: 'TEXT',
    payment_link_created_at: 'TEXT',
    payment_link_checked_at: 'TEXT',
    payment_id: 'TEXT',
    paid_at: 'TEXT',
  },
  intervention_logs: {
    response_deadline_at: 'TEXT',
    responded_at: 'TEXT',
  },
};

/**
 * Columns that no longer exist, per table.
 *
 * These came in with the Twilio outbox — a message could be written and then
 * separately accepted, refused or held by a provider, and the row had to say
 * which. With no provider there is no second event to record: the agent writes
 * the message, and that is the whole of what happened. A column that can only
 * ever hold one value is worse than no column, so they are dropped rather than
 * left behind reading 'simulated' forever.
 *
 * SQLite cannot drop a column in place on older versions, and doing it one
 * ALTER at a time would leave a half-migrated table if the process died between
 * them, so the table is rebuilt from schema.sql the same way a widened CHECK is.
 */
const REMOVED_COLUMNS = {
  intervention_logs: [
    'delivery_status', 'provider_message_id', 'delivered_to', 'delivered_at', 'delivery_error',
  ],
};

/**
 * CHECK constraints that gained a new allowed value. SQLite cannot alter a
 * constraint in place, so the table is rebuilt from the current schema.sql when
 * the stored definition is missing the value.
 */
const WIDENED_CHECKS = {
  recovery_cases: 'awaiting_response',
};

export function migrate(db) {
  const applied = [];

  for (const [table, columns] of Object.entries(ADDED_COLUMNS)) {
    if (!tableExists(db, table)) continue;
    const have = new Set(db.pragma(`table_info(${table})`).map((c) => c.name));
    for (const [name, decl] of Object.entries(columns)) {
      if (have.has(name)) continue;
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${decl}`);
      applied.push(`${table}.${name}`);
    }
  }

  for (const [table, columns] of Object.entries(REMOVED_COLUMNS)) {
    if (!tableExists(db, table)) continue;
    const have = new Set(db.pragma(`table_info(${table})`).map((c) => c.name));
    const stale = columns.filter((c) => have.has(c));
    if (!stale.length) continue;
    rebuild(db, table);
    applied.push(`${table} (dropped ${stale.join(', ')})`);
  }

  for (const [table, needle] of Object.entries(WIDENED_CHECKS)) {
    if (!tableExists(db, table)) continue;
    const sql = definitionOf(db, table);
    if (sql.includes(needle)) continue;
    rebuild(db, table);
    applied.push(`${table} (CHECK widened for '${needle}')`);
  }

  return applied;
}

const tableExists = (db, table) =>
  Boolean(db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));

const definitionOf = (db, table) =>
  db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table).sql;

/**
 * Rebuild one table against its current definition in schema.sql, carrying over
 * every column the two versions share.
 *
 * The definition is read out of schema.sql rather than repeated here, so the
 * migration cannot drift from the schema it is migrating towards.
 */
function rebuild(db, table) {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  const match = schema.match(
    new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\);`));
  if (!match) throw new Error(`migrate: no CREATE TABLE for ${table} in schema.sql`);

  const target = `${table}__migrating`;
  const carried = db.pragma(`table_info(${table})`).map((c) => c.name);

  const fkWasOn = db.pragma('foreign_keys', { simple: true });
  db.pragma('foreign_keys = OFF');
  db.transaction(() => {
    db.exec(`CREATE TABLE ${target} (${match[1]}\n)`);
    const targetCols = new Set(db.pragma(`table_info(${target})`).map((c) => c.name));
    const cols = carried.filter((c) => targetCols.has(c)).map((c) => `"${c}"`).join(',');
    db.exec(`INSERT INTO ${target} (${cols}) SELECT ${cols} FROM ${table}`);
    db.exec(`DROP TABLE ${table}`);
    db.exec(`ALTER TABLE ${target} RENAME TO ${table}`);
  })();
  if (fkWasOn) db.pragma('foreign_keys = ON');
}
