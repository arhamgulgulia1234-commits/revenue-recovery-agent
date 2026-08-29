/**
 * Print the full decision history for one case, or for a representative sample.
 *
 *   npm run case              # one example of each interesting shape
 *   npm run case -- case_0007 # a specific case
 */
import '../lib/env.js';
import { getDb } from '../db/index.js';
import { formatIst } from '../lib/time.js';
import { BUCKETS } from '../engine/classifier.js';
import { ACTION_LABELS } from '../engine/matrix.js';

const db = getDb();
const inr = (n) => '₹' + Math.round(n).toLocaleString('en-IN');
const wrap = (text, width = 84, indent = '      ') =>
  text.split('\n').flatMap((para) => {
    const out = [];
    let line = '';
    for (const word of para.split(' ')) {
      if ((line + word).length > width) { out.push(line.trimEnd()); line = ''; }
      line += word + ' ';
    }
    out.push(line.trimEnd());
    return out;
  }).map((l) => indent + l).join('\n');

function show(caseId) {
  const c = db.prepare(`
    SELECT rc.*, cu.name customer_name, cu.segment, cu.reliability_score, cu.salary_day,
           cu.preferred_channel, cu.opted_out_at, cu.disputed_at,
           p.decline_code, p.gateway_message, p.attempt_number, p.created_at failed_at,
           s.plan_name, i.invoice_number
    FROM recovery_cases rc
    JOIN customers cu ON cu.id = rc.customer_id
    JOIN payment_attempts p ON p.id = rc.payment_attempt_id
    LEFT JOIN subscriptions s ON s.id = p.subscription_id
    LEFT JOIN invoices i ON i.id = p.invoice_id
    WHERE rc.id = ?`).get(caseId);

  if (!c) { console.log(`  no such case: ${caseId}`); return; }

  const audit = db.prepare('SELECT * FROM audit_entries WHERE case_id = ? ORDER BY sequence').all(caseId);
  const logs = db.prepare('SELECT * FROM intervention_logs WHERE case_id = ? ORDER BY sequence').all(caseId);
  const byLabel = { recovered: '✓ RECOVERED', in_progress: '⋯ RETRYING', promise_to_pay: '⋯ RETRYING (promise to pay)', stopped: '■ STOPPED' };

  console.log('\n' + '─'.repeat(92));
  console.log(`  ${c.id}   ${byLabel[c.status] ?? c.status}   ${inr(c.amount_at_risk_inr)}`);
  console.log('─'.repeat(92));
  console.log(`  Customer     ${c.customer_name} (${c.segment}, reliability ${c.reliability_score}${c.salary_day ? `, salary day ${c.salary_day}` : ''})`);
  console.log(`  Item         ${c.plan_name ?? c.invoice_number}`);
  console.log(`  Failure      ${c.decline_code} — "${c.gateway_message}"`);
  console.log(`  Diagnosed    ${BUCKETS[c.root_cause].label} (${Math.round(c.root_cause_confidence * 100)}% confidence)`);
  console.log(`  Attempts     ${c.attempts_used} of 3${c.closure_reason ? `   ·   closed: ${c.closure_reason}` : ''}`);
  if (c.opted_out_at) console.log(`  ⚠ Opted out  ${formatIst(c.opted_out_at)}`);
  if (c.disputed_at) console.log(`  ⚠ Disputed   ${formatIst(c.disputed_at)}`);

  console.log('\n  TIMELINE');
  for (const a of audit) {
    console.log(`\n  [${String(a.sequence).padStart(2)}] ${formatIst(a.created_at).padEnd(26)} ${a.event_type}`);
    console.log(`       ${a.decision}`);
    console.log(wrap(a.reasoning_text, 82, '       '));

    // Attach the message body to the intervention it belongs to.
    if (a.event_type === 'intervention_selected') {
      const log = logs.find((l) => l.scheduled_for === a.created_at || l.executed_at === a.created_at);
      if (log?.message_sent) {
        console.log(`\n       ┌─ ${ACTION_LABELS[log.action_type]} · ${log.channel} · ${log.tone}`);
        for (const line of log.message_sent.split('\n')) console.log(`       │ ${line}`);
        console.log('       └─');
      }
    }
  }
  console.log('');
}

const arg = process.argv[2];
if (arg) {
  show(arg);
} else {
  // One example of each shape worth eyeballing.
  const picks = [
    ['Recovered on a timed retry (insufficient funds)',
      `SELECT rc.id FROM recovery_cases rc WHERE rc.status='recovered' AND rc.root_cause='timing_issue'
       AND EXISTS (SELECT 1 FROM intervention_logs l WHERE l.case_id=rc.id AND l.action_type='timed_retry' AND l.outcome='recovered') LIMIT 1`],
    ['Stopped on a pre-existing hard stop',
      `SELECT id FROM recovery_cases WHERE closure_reason IN ('customer_opted_out','customer_disputed') ORDER BY amount_at_risk_inr DESC LIMIT 1`],
    ['Ran the full 3 attempts and stopped at the cap',
      `SELECT id FROM recovery_cases WHERE closure_reason='max_attempts_reached' AND root_cause='receivable' ORDER BY amount_at_risk_inr DESC LIMIT 1`],
    ['Outreach deferred out of quiet hours, then recovered',
      `SELECT rc.id FROM recovery_cases rc WHERE rc.status='recovered'
       AND EXISTS (SELECT 1 FROM audit_entries a WHERE a.case_id=rc.id AND a.event_type='quiet_hours_deferred') LIMIT 1`],
  ];
  for (const [label, sql] of picks) {
    const row = db.prepare(sql).get();
    if (!row) { console.log(`\n  (no case matching: ${label})`); continue; }
    console.log(`\n\n══ ${label} ══`);
    show(row.id);
  }
}
