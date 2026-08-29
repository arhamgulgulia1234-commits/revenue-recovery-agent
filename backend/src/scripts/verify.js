/**
 * Independent compliance check.
 *
 * Re-derives every policy claim straight from the stored rows rather than from
 * the engine's own bookkeeping. If the engine ever drifts from its stated rules,
 * this is what catches it.
 */
import 'dotenv/config';
import { getDb } from '../db/index.js';
import { istHour, formatIst } from '../lib/time.js';
import { POLICY, isQuietHour } from '../lib/taxonomy.js';

const db = getDb();
const all = (sql, ...p) => db.prepare(sql).all(...p);
const checks = [];
const check = (name, pass, detail = '') => checks.push({ name, pass, detail });

// 1. Attempt cap
const overCap = all(
  `SELECT id, attempts_used FROM recovery_cases WHERE attempts_used > ?`,
  POLICY.MAX_ATTEMPTS_PER_CASE);
check(`No case exceeds the ${POLICY.MAX_ATTEMPTS_PER_CASE}-attempt cap`,
  overCap.length === 0, overCap.map((c) => `${c.id}=${c.attempts_used}`).join(', '));

// Executed intervention count must match attempts_used
const mismatched = all(`
  SELECT c.id, c.attempts_used,
         (SELECT COUNT(*) FROM intervention_logs l
           WHERE l.case_id = c.id AND l.executed_at IS NOT NULL) AS executed
  FROM recovery_cases c WHERE c.attempts_used != executed`);
check('attempts_used matches executed interventions on every case',
  mismatched.length === 0, mismatched.slice(0, 5).map((c) => c.id).join(', '));

// 2. Hard stops — no action of any kind on an opted-out or disputed customer
const touched = all(`
  SELECT l.id, l.case_id, l.action_type, c.name
  FROM intervention_logs l
  JOIN recovery_cases rc ON rc.id = l.case_id
  JOIN customers c ON c.id = rc.customer_id
  WHERE l.executed_at IS NOT NULL
    AND ((c.opted_out_at IS NOT NULL AND l.executed_at > c.opted_out_at)
      OR (c.disputed_at IS NOT NULL AND l.executed_at > c.disputed_at))`);
check('No intervention executed after a customer opted out or disputed',
  touched.length === 0, touched.slice(0, 5).map((t) => `${t.case_id}/${t.action_type}`).join(', '));

const unstopped = all(`
  SELECT rc.id, rc.status FROM recovery_cases rc JOIN customers c ON c.id = rc.customer_id
  WHERE (c.opted_out_at IS NOT NULL OR c.disputed_at IS NOT NULL)
    AND rc.status NOT IN ('stopped','recovered')`);
check('Every case on a hard-stopped customer is closed',
  unstopped.length === 0, unstopped.map((c) => `${c.id}=${c.status}`).join(', '));

// 3. Quiet hours — outreach only; silent retries are exempt by design
const noisy = all(`
  SELECT id, case_id, channel, executed_at FROM intervention_logs
  WHERE executed_at IS NOT NULL AND channel != 'none'`)
  .filter((l) => isQuietHour(istHour(l.executed_at)));
check(`No outreach sent during quiet hours (${POLICY.QUIET_HOURS_LABEL})`,
  noisy.length === 0,
  noisy.slice(0, 5).map((l) => `${l.case_id} @ ${formatIst(l.executed_at)}`).join(', '));

// 4. Every stop carries a logged reason
const unreasoned = all(`
  SELECT id FROM recovery_cases WHERE status = 'stopped'
    AND (closure_reason IS NULL OR closure_reason = '')`);
check('Every stopped case has a closure reason', unreasoned.length === 0,
  unreasoned.map((c) => c.id).join(', '));

const noStopAudit = all(`
  SELECT rc.id FROM recovery_cases rc WHERE rc.status = 'stopped'
    AND NOT EXISTS (SELECT 1 FROM audit_entries a
                     WHERE a.case_id = rc.id AND a.event_type = 'case_stopped')`);
check('Every stopped case has a case_stopped audit entry', noStopAudit.length === 0,
  noStopAudit.map((c) => c.id).join(', '));

// 5. Audit coverage — every case classified, every execution narrated
const unclassified = all(`SELECT id FROM recovery_cases WHERE root_cause IS NULL`);
check('Every case has a root cause', unclassified.length === 0,
  unclassified.map((c) => c.id).join(', '));

const unnarrated = all(`
  SELECT l.id, l.case_id FROM intervention_logs l WHERE l.executed_at IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM audit_entries a
                     WHERE a.case_id = l.case_id AND a.event_type = 'outcome_recorded')`);
check('Every executed intervention has an outcome audit entry', unnarrated.length === 0,
  unnarrated.slice(0, 5).map((l) => l.case_id).join(', '));

const emptyReasoning = all(
  `SELECT id, event_type FROM audit_entries WHERE reasoning_text IS NULL OR length(reasoning_text) < 20`);
check('Every audit entry carries real reasoning text', emptyReasoning.length === 0,
  emptyReasoning.slice(0, 5).map((a) => a.event_type).join(', '));

// 6. Money adds up
const money = all(`
  SELECT SUM(recovered_amount_inr) rec, SUM(amount_at_risk_inr) risk FROM recovery_cases`)[0];
const badMoney = all(`
  SELECT id FROM recovery_cases
   WHERE (status = 'recovered' AND recovered_amount_inr != amount_at_risk_inr)
      OR (status != 'recovered' AND recovered_amount_inr != 0)`);
check('Recovered amounts are consistent with case status', badMoney.length === 0,
  badMoney.map((c) => c.id).join(', '));

// 7. No message sent on a silent action
const silentTalked = all(`
  SELECT id, case_id FROM intervention_logs
   WHERE channel = 'none' AND message_sent IS NOT NULL`);
check('Silent retries send no message', silentTalked.length === 0,
  silentTalked.map((l) => l.case_id).join(', '));

// -- Report ------------------------------------------------------------------
console.log('\n  Compliance verification\n');
let failed = 0;
for (const c of checks) {
  if (!c.pass) failed++;
  console.log(`  ${c.pass ? '✓' : '✗'} ${c.name}${c.pass ? '' : `\n      ↳ ${c.detail}`}`);
}
console.log(
  `\n  ${checks.length - failed}/${checks.length} passed · ` +
  `₹${money.rec.toLocaleString('en-IN')} recovered of ₹${money.risk.toLocaleString('en-IN')} at risk\n`);
process.exit(failed > 0 ? 1 : 0);
