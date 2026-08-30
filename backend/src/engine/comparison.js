/**
 * Side-by-side: the decision engine against the naive baseline, same 80 cases.
 *
 * Both halves are measured the same way from stored/simulated rows — nothing is
 * reported for one that is not reported for the other.
 */

import { runBaseline, describeConfig } from './baseline.js';

export function buildComparison(db) {
  const { results: baseline } = runBaseline(db);

  const cases = db.prepare(`
    SELECT rc.*, c.name AS customer_name FROM recovery_cases rc
    JOIN customers c ON c.id = rc.customer_id
    WHERE rc.delivery_mode = 'simulated'`).all();

  // A "contact" is an intervention the customer can perceive. Silent retries
  // notify nobody, so they are not contact — that distinction is the whole
  // point of the second half of this comparison.
  const contactsByCase = new Map(
    db.prepare(`
      SELECT case_id, COUNT(*) AS n FROM intervention_logs
      WHERE executed_at IS NOT NULL AND channel != 'none'
      GROUP BY case_id`).all().map((r) => [r.case_id, r.n]),
  );

  const engine = cases.map((c) => ({
    amount_inr: c.amount_at_risk_inr,
    status: c.status,
    recovered_amount_inr: c.recovered_amount_inr,
    attempts_used: c.attempts_used,
    contacts_made: contactsByCase.get(c.id) ?? 0,
    days_to_recovery: c.status === 'recovered' && c.closed_at
      ? (new Date(c.closed_at) - new Date(c.opened_at)) / 86400000
      : null,
  }));

  return {
    atRiskInr: engine.reduce((n, c) => n + c.amount_inr, 0),
    caseCount: engine.length,
    engine: summarise(engine),
    baseline: summarise(baseline),
    config: describeConfig(),
  };
}

function summarise(rows) {
  const recovered = rows.filter((r) => r.status === 'recovered');
  const recoveredInr = rows.reduce((n, r) => n + (r.recovered_amount_inr || 0), 0);
  const atRisk = rows.reduce((n, r) => n + r.amount_inr, 0);
  const daysList = recovered.map((r) => r.days_to_recovery).filter((d) => d != null);
  const attemptsList = recovered.map((r) => r.attempts_used).filter((a) => a > 0);
  const contacts = rows.reduce((n, r) => n + (r.contacts_made || 0), 0);

  return {
    recoveredCases: recovered.length,
    recoveredInr,
    caseRate: rows.length ? recovered.length / rows.length : 0,
    valueRate: atRisk ? recoveredInr / atRisk : 0,
    totalContacts: contacts,
    // "Excessive" = three or more messages to one customer on one failure.
    heavilyContacted: rows.filter((r) => (r.contacts_made || 0) >= 3).length,
    contactedAtAll: rows.filter((r) => (r.contacts_made || 0) > 0).length,
    avgAttemptsToRecovery: attemptsList.length
      ? attemptsList.reduce((a, b) => a + b, 0) / attemptsList.length : null,
    avgDaysToRecovery: daysList.length
      ? daysList.reduce((a, b) => a + b, 0) / daysList.length : null,
  };
}
