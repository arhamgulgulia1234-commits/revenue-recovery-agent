import { Router } from 'express';
import { getDb } from '../db/index.js';

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

  res.json({
    case: c,
    interventions: db.prepare(
      'SELECT * FROM intervention_logs WHERE case_id = ? ORDER BY sequence').all(c.id),
    audit: db.prepare(
      'SELECT * FROM audit_entries WHERE case_id = ? ORDER BY sequence').all(c.id),
    promises: db.prepare(
      'SELECT * FROM promises_to_pay WHERE case_id = ? ORDER BY created_at').all(c.id),
  });
});
