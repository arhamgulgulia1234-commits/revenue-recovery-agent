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
  });
});

/** The raw failure feed the agent picks up from. */
portfolioRouter.get('/failures', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const rows = getDb().prepare(`
    SELECT p.*, c.name AS customer_name, c.segment, c.reliability_score,
           c.opted_out_at, c.disputed_at,
           s.plan_name, i.invoice_number
    FROM payment_attempts p
    JOIN customers c ON c.id = p.customer_id
    LEFT JOIN subscriptions s ON s.id = p.subscription_id
    LEFT JOIN invoices i ON i.id = p.invoice_id
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
