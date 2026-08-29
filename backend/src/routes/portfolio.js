import { Router } from 'express';
import { getDb } from '../db/index.js';

export const portfolioRouter = Router();

/** Top-line view of the at-risk book, before any recovery work. */
portfolioRouter.get('/stats', (req, res) => {
  const db = getDb();
  const one = (sql) => db.prepare(sql).get();
  const all = (sql) => db.prepare(sql).all();

  res.json({
    totals: one(`
      SELECT COUNT(*) AS failed_attempts,
             COALESCE(SUM(amount_inr), 0) AS at_risk_inr,
             COUNT(DISTINCT customer_id) AS customers_affected
      FROM payment_attempts WHERE status = 'failed'`),
    byDeclineCode: all(`
      SELECT decline_code, COUNT(*) AS n, SUM(amount_inr) AS at_risk_inr
      FROM payment_attempts WHERE status = 'failed'
      GROUP BY decline_code ORDER BY n DESC`),
    bySegment: all(`
      SELECT c.segment, COUNT(*) AS n, SUM(p.amount_inr) AS at_risk_inr
      FROM payment_attempts p JOIN customers c ON c.id = p.customer_id
      WHERE p.status = 'failed' GROUP BY c.segment ORDER BY at_risk_inr DESC`),
    byChannel: all(`
      SELECT channel, COUNT(*) AS n, SUM(amount_inr) AS at_risk_inr
      FROM payment_attempts WHERE status = 'failed' GROUP BY channel`),
    hardStops: one(`
      SELECT SUM(opted_out_at IS NOT NULL) AS opted_out,
             SUM(disputed_at IS NOT NULL) AS disputed
      FROM customers`),
    recovery: one(`
      SELECT COUNT(*) AS cases,
             COALESCE(SUM(recovered_amount_inr), 0) AS recovered_inr,
             COALESCE(SUM(amount_at_risk_inr), 0) AS at_risk_inr,
             SUM(status = 'recovered') AS n_recovered,
             SUM(status IN ('in_progress', 'promise_to_pay')) AS n_retrying,
             SUM(status = 'stopped') AS n_stopped,
             ROUND(AVG(CASE WHEN status = 'recovered'
                       THEN julianday(closed_at) - julianday(opened_at) END), 1) AS avg_days_to_recovery
      FROM recovery_cases`),
    stopReasons: all(`
      SELECT closure_reason, COUNT(*) AS n, SUM(amount_at_risk_inr) AS at_risk_inr
      FROM recovery_cases WHERE status = 'stopped'
      GROUP BY closure_reason ORDER BY n DESC`),
    byRootCause: all(`
      SELECT root_cause, COUNT(*) AS n,
             SUM(status = 'recovered') AS recovered,
             SUM(status IN ('in_progress','promise_to_pay')) AS retrying,
             SUM(status = 'stopped') AS stopped,
             SUM(recovered_amount_inr) AS recovered_inr
      FROM recovery_cases GROUP BY root_cause ORDER BY n DESC`),
  });
});

/** The raw failure feed the agent picks up from. */
portfolioRouter.get('/failures', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const rows = getDb().prepare(`
    SELECT p.*, c.name AS customer_name, c.segment, c.reliability_score,
           c.opted_out_at, c.disputed_at,
           s.plan_name, i.invoice_number,
           rc.id AS case_id, rc.status AS case_status, rc.root_cause,
           rc.attempts_used, rc.closure_reason, rc.recovered_amount_inr
    FROM payment_attempts p
    JOIN customers c ON c.id = p.customer_id
    LEFT JOIN subscriptions s ON s.id = p.subscription_id
    LEFT JOIN invoices i ON i.id = p.invoice_id
    LEFT JOIN recovery_cases rc ON rc.payment_attempt_id = p.id
    WHERE p.status = 'failed'
    ORDER BY p.created_at DESC
    LIMIT ?`).all(limit);
  res.json({ count: rows.length, failures: rows });
});

portfolioRouter.get('/customers', (req, res) => {
  const rows = getDb().prepare(`
    SELECT c.*,
           (SELECT COUNT(*) FROM payment_attempts p
             WHERE p.customer_id = c.id AND p.status = 'failed') AS failed_attempts
    FROM customers c ORDER BY c.lifetime_value_inr DESC`).all();
  res.json({ count: rows.length, customers: rows });
});
