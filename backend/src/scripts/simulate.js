/**
 * Batch run: push every open failure through the recovery agent and report the
 * aggregate numbers. Seeded, so the whole batch is reproducible.
 */
import '../lib/env.js';
import { getDb } from '../db/index.js';
import { makeRandom } from '../lib/rng.js';
import { createRunner } from '../engine/runner.js';
import { iso } from '../lib/time.js';
import { BUCKETS } from '../engine/classifier.js';
import { ACTION_LABELS } from '../engine/matrix.js';

const inr = (n) => '₹' + Math.round(n).toLocaleString('en-IN');
const pct = (n) => (n * 100).toFixed(1) + '%';

const db = getDb();
const seed = Number(process.env.SEED) || 20260829;
const rand = makeRandom(seed + 7);
const now = Date.now();

const existing = db.prepare('SELECT COUNT(*) n FROM recovery_cases').get().n;
if (existing > 0) {
  console.error(`✗ ${existing} cases already exist. Run \`npm run reset && npm run seed\` first.`);
  process.exit(1);
}

const attempts = db.prepare(`
  SELECT * FROM payment_attempts WHERE status = 'failed' ORDER BY created_at ASC`).all();

const getCustomer = db.prepare('SELECT * FROM customers WHERE id = ?');
const getSub = db.prepare('SELECT * FROM subscriptions WHERE id = ?');
const getInvoice = db.prepare('SELECT * FROM invoices WHERE id = ?');

const runId = `run_${Date.now().toString(36)}`;
db.prepare('INSERT INTO engine_runs (id,started_at,cases_processed,notes) VALUES (?,?,0,?)')
  .run(runId, iso(now), `seed=${seed}`);

const runner = createRunner({ db, rand, now });
const results = [];

const batch = db.transaction(() => {
  for (const attempt of attempts) {
    results.push(runner.runCase({
      attempt,
      customer: getCustomer.get(attempt.customer_id),
      subscription: attempt.subscription_id ? getSub.get(attempt.subscription_id) : null,
      invoice: attempt.invoice_id ? getInvoice.get(attempt.invoice_id) : null,
    }));
  }
});
batch();

db.prepare('UPDATE engine_runs SET finished_at=?, cases_processed=? WHERE id=?')
  .run(iso(Date.now()), results.length, runId);

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
const q = (sql, ...p) => db.prepare(sql).all(...p);
const q1 = (sql, ...p) => db.prepare(sql).get(...p);

const totals = q1(`
  SELECT COUNT(*) cases,
         SUM(amount_at_risk_inr) at_risk,
         SUM(recovered_amount_inr) recovered,
         SUM(status='recovered') n_recovered,
         SUM(status IN ('in_progress','promise_to_pay')) n_retrying,
         SUM(status='stopped') n_stopped
  FROM recovery_cases`);

console.log(`\n  ══ Recovery run complete ══  (seed=${seed}, ${results.length} cases)\n`);
console.log(`  Revenue at risk       ${inr(totals.at_risk)}`);
console.log(`  Revenue recovered     ${inr(totals.recovered)}`);
console.log(`  Recovery rate         ${pct(totals.n_recovered / totals.cases)} of cases · ${pct(totals.recovered / totals.at_risk)} of value\n`);
console.log(`  Recovered             ${totals.n_recovered}`);
console.log(`  Still retrying        ${totals.n_retrying}`);
console.log(`  Stopped               ${totals.n_stopped}\n`);

console.log('  ── Outcome by root cause ──');
console.log(`  ${'root cause'.padEnd(20)} ${'n'.padStart(3)} ${'rec'.padStart(4)} ${'retry'.padStart(6)} ${'stop'.padStart(5)}  rate`);
for (const r of q(`
  SELECT root_cause, COUNT(*) n,
         SUM(status='recovered') rec,
         SUM(status IN ('in_progress','promise_to_pay')) retry,
         SUM(status='stopped') stop
  FROM recovery_cases GROUP BY root_cause ORDER BY n DESC`)) {
  console.log(`  ${BUCKETS[r.root_cause].label.padEnd(20)} ${String(r.n).padStart(3)} ${String(r.rec).padStart(4)} ${String(r.retry).padStart(6)} ${String(r.stop).padStart(5)}  ${pct(r.rec / r.n).padStart(6)}`);
}

console.log('\n  ── Why cases stopped ──');
for (const r of q(`
  SELECT closure_reason, COUNT(*) n, SUM(amount_at_risk_inr) amt
  FROM recovery_cases WHERE status='stopped' GROUP BY closure_reason ORDER BY n DESC`)) {
  console.log(`  ${r.closure_reason.padEnd(26)} ${String(r.n).padStart(3)}   ${inr(r.amt)}`);
}

console.log('\n  ── Interventions executed ──');
for (const r of q(`
  SELECT action_type, COUNT(*) n, SUM(outcome='recovered') rec
  FROM intervention_logs WHERE executed_at IS NOT NULL
  GROUP BY action_type ORDER BY n DESC`)) {
  console.log(`  ${(ACTION_LABELS[r.action_type] ?? r.action_type).padEnd(30)} ${String(r.n).padStart(3)} sent, ${String(r.rec).padStart(2)} recovered  ${pct(r.rec / r.n).padStart(6)}`);
}

const compliance = q1(`
  SELECT (SELECT COUNT(*) FROM audit_entries WHERE event_type='quiet_hours_deferred') quiet,
         (SELECT COUNT(*) FROM audit_entries WHERE policy_refs='hard_stop') hard,
         (SELECT COUNT(*) FROM audit_entries WHERE policy_refs='attempt_cap') cap,
         (SELECT MAX(attempts_used) FROM recovery_cases) max_attempts,
         (SELECT COUNT(*) FROM intervention_logs WHERE case_id IN
            (SELECT id FROM recovery_cases WHERE closure_reason IN ('customer_opted_out','customer_disputed'))
          AND executed_at IS NOT NULL) touched_hard_stops`);

const timing = q1(`
  SELECT ROUND(AVG(julianday(closed_at) - julianday(opened_at)), 1) avg_days
  FROM recovery_cases WHERE status='recovered'`);

console.log('\n  ── Compliance ──');
console.log(`  Quiet-hour deferrals          ${compliance.quiet}`);
console.log(`  Hard stops enforced           ${compliance.hard}`);
console.log(`  Attempt-cap stops             ${compliance.cap}`);
console.log(`  Max attempts on any case      ${compliance.max_attempts}  ${compliance.max_attempts <= 3 ? '✓ within cap' : '✗ CAP BREACHED'}`);
console.log(`  Actions taken on hard stops   ${compliance.touched_hard_stops}  ${compliance.touched_hard_stops === 0 ? '✓ none, as required' : '✗ VIOLATION'}`);
console.log(`\n  Avg days to recovery          ${timing.avg_days}`);

const auditCount = q1('SELECT COUNT(*) n FROM audit_entries').get?.n ?? q1('SELECT COUNT(*) n FROM audit_entries').n;
console.log(`  Audit entries written         ${auditCount}\n`);
