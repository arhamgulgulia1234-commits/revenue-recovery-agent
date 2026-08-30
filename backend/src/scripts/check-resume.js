/**
 * Does a case parked mid-flight land where an uninterrupted run would put it?
 *
 * This is the load-bearing claim of the waiting state. The engine no longer
 * works a case start to finish: it sends, parks on a real deadline, and is
 * picked back up later by the scheduler — possibly in a different process, in
 * whatever order the deadlines happen to fall. If the outcome depended on any of
 * that, the batch numbers would be an artefact of scheduling rather than a
 * property of the book, and nothing downstream could be trusted.
 *
 * So: run the whole book twice against the same anchor. Once in a single pass,
 * and once cut off early enough that most cases park, then swept forward. The
 * two must agree on every case, exactly.
 *
 *   npm run check:resume
 */
import '../lib/env.js';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DB_PATH } from '../db/index.js';
import { createRunner } from '../engine/runner.js';
import { sweep } from '../engine/scheduler.js';

const DAY = 86400000;
const CUTOFF_DAYS = Number(process.env.RESUME_CHECK_CUTOFF_DAYS) || 12;
const SEED = Number(process.env.SEED) || 20260829;
const anchor = process.env.SEED_NOW ? new Date(process.env.SEED_NOW).getTime() : Date.now();

if (!fs.existsSync(DB_PATH)) {
  console.error(`  ✗ No database at ${DB_PATH}. Run \`npm run seed\` first.`);
  process.exit(1);
}

/** A private copy of the seeded book with every engine-written row removed. */
function fresh(tag) {
  const file = path.join(os.tmpdir(), `recovery-resume-${tag}-${process.pid}.sqlite`);
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(file + suffix); } catch { /* not there */ }
  }
  fs.copyFileSync(DB_PATH, file);

  const db = new Database(file);
  db.pragma('foreign_keys = OFF');
  for (const t of ['recovery_cases', 'intervention_logs', 'audit_entries', 'promises_to_pay']) {
    db.exec(`DELETE FROM ${t}`);
  }
  // Opt-outs the engine wrote back onto customers during a previous run would
  // otherwise pre-stop cases that should get to run here.
  db.exec(`UPDATE customers SET opted_out_at = NULL
            WHERE opted_out_at IS NOT NULL AND opted_out_at > (SELECT MIN(created_at) FROM payment_attempts)`);
  db.exec(`UPDATE customers SET disputed_at = NULL
            WHERE disputed_at IS NOT NULL AND disputed_at > (SELECT MIN(created_at) FROM payment_attempts)`);
  db.pragma('foreign_keys = ON');
  return { db, file };
}

function runAt(db, now) {
  const runner = createRunner({ db, seed: SEED, now });
  const attempts = db.prepare(
    `SELECT * FROM payment_attempts WHERE status = 'failed' ORDER BY created_at ASC`).all();
  const get = (table, id) =>
    id ? db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) : null;

  db.transaction(() => {
    for (const attempt of attempts) {
      runner.runCase({
        attempt,
        customer: get('customers', attempt.customer_id),
        subscription: get('subscriptions', attempt.subscription_id),
        invoice: get('invoices', attempt.invoice_id),
      });
    }
  })();
}

const shape = (db) => db.prepare(`
  SELECT id, status, attempts_used, closure_reason, recovered_amount_inr, closed_at
  FROM recovery_cases ORDER BY id`).all()
  .map((c) => [c.id, c.status, c.attempts_used, c.closure_reason ?? '-',
    c.recovered_amount_inr, c.closed_at ?? '-'].join(' '));

// -- One uninterrupted pass at the anchor ------------------------------------
const single = fresh('single');
runAt(single.db, anchor);

// -- The same book, cut off early and then swept forward ---------------------
const resumed = fresh('resumed');
runAt(resumed.db, anchor - CUTOFF_DAYS * DAY);
const parked = resumed.db.prepare(`
  SELECT COUNT(*) n FROM recovery_cases
   WHERE status IN ('in_progress','awaiting_response','promise_to_pay')`).get().n;

let passes = 0;
let result;
do {
  result = sweep(resumed.db);
  passes += 1;
} while (result.advanced.length && passes < 50);

// -- Compare -----------------------------------------------------------------
const a = shape(single.db);
const b = shape(resumed.db);
const differing = a.filter((row, i) => row !== b[i]);

console.log('\n  Resume equivalence\n');
console.log(`  Cases in the book                 ${a.length}`);
console.log(`  Parked at a ${String(CUTOFF_DAYS).padStart(2)}-day-early cutoff    ${parked}`);
console.log(`  Sweeper passes to catch up        ${passes}`);
console.log(`  Cases differing from a single run ${differing.length}`);

for (const row of differing.slice(0, 8)) {
  console.log(`\n    single pass : ${row}`);
  console.log(`    resumed     : ${b[a.indexOf(row)]}`);
}

for (const { file } of [single, resumed]) {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(file + suffix); } catch { /* already gone */ }
  }
}

console.log(differing.length === 0
  ? '\n  ✓ Identical — a parked case resumes exactly where an uninterrupted run leaves it\n'
  : '\n  ✗ Resuming a parked case does not reproduce the uninterrupted run\n');
process.exit(differing.length === 0 ? 0 : 1);
