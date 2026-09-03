/**
 * Remove live cases, leaving the seeded book untouched.
 *
 *   npm run live:reset
 *
 * Rehearsing the real payment flow means opening real cases, and they accumulate.
 * `npm run reset` is the wrong tool — it clears everything and would cost a
 * reseed and a re-simulate to get the demo back. This removes only what the
 * live path created: cases marked `delivery_mode = 'live'`, the rows hanging off
 * them, and the failures and customers invented to carry them.
 */
import '../lib/env.js';
import { getDb } from '../db/index.js';

const db = getDb();

const cases = db.prepare(
  "SELECT id, payment_attempt_id, customer_id FROM recovery_cases WHERE delivery_mode = 'live'").all();

if (!cases.length) {
  console.log('\n  No live cases to remove.\n');
  process.exit(0);
}

// Foreign keys are turned off for the duration: recovery_cases.awaiting_log_id
// points at intervention_logs and intervention_logs.case_id points back, so
// there is no order in which both can be deleted with the constraint enforced.
const fkWasOn = db.pragma('foreign_keys', { simple: true });
db.pragma('foreign_keys = OFF');

const removed = db.transaction(() => {
  const counts = { cases: 0, logs: 0, audit: 0, promises: 0, attempts: 0, customers: 0 };

  for (const c of cases) {
    counts.audit += db.prepare('DELETE FROM audit_entries WHERE case_id = ?').run(c.id).changes;
    counts.logs += db.prepare('DELETE FROM intervention_logs WHERE case_id = ?').run(c.id).changes;
    counts.promises += db.prepare('DELETE FROM promises_to_pay WHERE case_id = ?').run(c.id).changes;
    counts.cases += db.prepare('DELETE FROM recovery_cases WHERE id = ?').run(c.id).changes;
  }

  // Only rows the live path invented. A live case opened against a customer who
  // was already in the seeded book leaves that customer alone.
  const attempts = db.prepare("SELECT id FROM payment_attempts WHERE source = 'live'").all();
  for (const a of attempts) {
    db.prepare('DELETE FROM subscriptions WHERE id IN (SELECT subscription_id FROM payment_attempts WHERE id = ?)').run(a.id);
    db.prepare('DELETE FROM invoices WHERE id IN (SELECT invoice_id FROM payment_attempts WHERE id = ?)').run(a.id);
  }
  counts.attempts = db.prepare("DELETE FROM payment_attempts WHERE source = 'live'").run().changes;
  counts.customers = db.prepare(`
    DELETE FROM customers WHERE id LIKE 'cust_live_%'
      AND id NOT IN (SELECT customer_id FROM payment_attempts)`).run().changes;

  return counts;
})();

if (fkWasOn) db.pragma('foreign_keys = ON');

console.log('\n  Live data cleared\n');
for (const [k, v] of Object.entries(removed)) {
  console.log(`  ${k.padEnd(12)} ${v}`);
}

const left = db.prepare("SELECT COUNT(*) n FROM recovery_cases WHERE delivery_mode = 'simulated'").get().n;
console.log(`\n  Seeded book untouched: ${left} simulated cases still on the book.\n`);
