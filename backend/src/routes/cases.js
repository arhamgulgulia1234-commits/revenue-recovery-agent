import { Router } from 'express';
import { getDb } from '../db/index.js';
import { scoreCases } from '../engine/score-service.js';

export const casesRouter = Router();

casesRouter.get('/', (req, res) => {
  const { status, root_cause } = req.query;
  const where = [];
  const params = [];
  if (status) { where.push('rc.status = ?'); params.push(status); }
  if (root_cause) { where.push('rc.root_cause = ?'); params.push(root_cause); }

  const rows = getDb().prepare(`
    SELECT rc.*, c.name AS customer_name, c.segment, c.reliability_score,
           p.decline_code, s.plan_name, i.invoice_number
    FROM recovery_cases rc
    JOIN customers c ON c.id = rc.customer_id
    JOIN payment_attempts p ON p.id = rc.payment_attempt_id
    LEFT JOIN subscriptions s ON s.id = p.subscription_id
    LEFT JOIN invoices i ON i.id = p.invoice_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY rc.amount_at_risk_inr DESC`).all(...params);
  res.json({ count: rows.length, cases: rows });
});

/** Full decision history for one case: interventions and audit trail, in order. */
casesRouter.get('/:id', (req, res) => {
  const db = getDb();
  const c = db.prepare(`
    SELECT rc.*, cu.name AS customer_name, cu.segment, cu.phone, cu.email,
           cu.reliability_score, cu.preferred_channel, cu.salary_day,
           cu.opted_out_at, cu.disputed_at,
           p.decline_code, p.gateway_message, p.attempt_number, p.channel AS failure_channel,
           p.created_at AS failed_at,
           s.plan_name, s.frequency, s.mandate_type, i.invoice_number, i.due_at
    FROM recovery_cases rc
    JOIN customers cu ON cu.id = rc.customer_id
    JOIN payment_attempts p ON p.id = rc.payment_attempt_id
    LEFT JOIN subscriptions s ON s.id = p.subscription_id
    LEFT JOIN invoices i ON i.id = p.invoice_id
    WHERE rc.id = ?`).get(req.params.id);

  if (!c) return res.status(404).json({ error: 'case_not_found', id: req.params.id });

  const interventions = db.prepare(
    'SELECT * FROM intervention_logs WHERE case_id = ? ORDER BY sequence').all(c.id);
  const audit = db.prepare(
    'SELECT * FROM audit_entries WHERE case_id = ? ORDER BY sequence').all(c.id);
  const promises = db.prepare(
    'SELECT * FROM promises_to_pay WHERE case_id = ? ORDER BY created_at').all(c.id);

  const [scored] = scoreCases(db, [c]).scored;

  res.json({
    case: { ...c, recovery_score: scored.recovery_score, score_band: scored.score_band,
            score_explanation: scored.score_explanation },
    interventions,
    audit,
    promises,
    timeline: buildTimeline(audit, interventions),
  });
});

/**
 * Stitch the audit trail and the intervention log into one ordered story.
 *
 * The runner emits exactly one `intervention_selected` entry per intervention,
 * in order, so the Nth such entry is intervention sequence N — that pairing is
 * done here rather than in the UI, where a mismatch would be invisible.
 */
function buildTimeline(audit, interventions) {
  const bySequence = new Map(interventions.map((i) => [i.sequence, i]));
  let selected = 0;
  let current = null;

  return audit.map((a) => {
    if (a.event_type === 'intervention_selected') {
      selected += 1;
      current = bySequence.get(selected) ?? null;
      return { ...a, intervention: current, attemptNumber: selected };
    }
    if (a.event_type === 'outcome_recorded') {
      return { ...a, intervention: current, attemptNumber: selected };
    }
    return { ...a, intervention: null, attemptNumber: null };
  });
}
