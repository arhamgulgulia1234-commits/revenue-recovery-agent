/**
 * Scoring for the API layer.
 *
 * Priors are rebuilt per request rather than cached or persisted. At 80 cases
 * that is a few milliseconds, and it means a score is never stale relative to
 * the batch it was learned from — run the engine again and every score moves
 * with it, with no migration and no invalidation to get wrong.
 */

import { buildPriors, buildCustomerHistory } from './priors.js';
import { scoreCase, needsAttention } from './scorer.js';

/** Score a list of case rows. Rows must carry the customer columns they need. */
export function scoreCases(db, caseRows) {
  const priors = buildPriors(db);
  const history = buildCustomerHistory(db);
  const customers = new Map(db.prepare('SELECT * FROM customers').all().map((c) => [c.id, c]));

  const scored = caseRows.map((caseRow) => {
    const customer = customers.get(caseRow.customer_id);
    const result = scoreCase({ caseRow, customer, priors, history: history.get(caseRow.customer_id) });
    return {
      ...caseRow,
      recovery_score: Number(result.score.toFixed(4)),
      score_band: result.band.label,
      score_explanation: result.explanation,
      score_factors: result.factors,
    };
  });

  return { scored, priors };
}

export function attentionList(db, options) {
  const rows = db.prepare(`
    SELECT rc.*, c.name AS customer_name, c.segment, p.decline_code,
           s.plan_name, i.invoice_number
    FROM recovery_cases rc
    JOIN customers c ON c.id = rc.customer_id
    JOIN payment_attempts p ON p.id = rc.payment_attempt_id
    LEFT JOIN subscriptions s ON s.id = p.subscription_id
    LEFT JOIN invoices i ON i.id = p.invoice_id`).all();

  const { scored } = scoreCases(db, rows);
  return needsAttention(
    scored.map((s) => ({ ...s, caseRow: s, score: s.recovery_score, factors: s.score_factors })),
    options,
  ).map(({ caseRow, factors, ...rest }) => rest);
}
