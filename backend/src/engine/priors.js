/**
 * Empirical priors learned from completed cases.
 *
 * Not a trained model — just conditional recovery rates counted off the batch,
 * smoothed so a seven-case bucket can't swing the score around. Everything the
 * scorer uses comes from here, so `npm run score -- --priors` shows you exactly
 * what the numbers are and where they came from.
 */

const SMOOTHING = 5; // pseudo-observations pulled toward the global rate

/**
 * Shrink a small sample toward the population mean.
 * A bucket with 3 cases and 3 recoveries is not a 100% bucket; it's a bucket we
 * know almost nothing about. `SMOOTHING` is how many observations of "average"
 * we pretend to have seen before trusting the bucket's own rate.
 */
export function smoothRate(recovered, total, globalRate, k = SMOOTHING) {
  return (recovered + k * globalRate) / (total + k);
}

/**
 * Cases the agent never acted on tell us nothing about recoverability — only
 * about permission. A case stopped at open because the customer had opted out
 * would otherwise drag every rate it touches downward for no reason.
 */
const EXCLUDED_CLOSURES = new Set(['customer_opted_out', 'customer_disputed']);

/** Statuses that mean the case has not landed either way yet. */
const IN_FLIGHT = new Set(['open', 'in_progress', 'awaiting_response', 'promise_to_pay']);

/**
 * Every case the agent was allowed to work, whatever its current status.
 *
 * Restricting to settled cases would be the obvious move and it is wrong here:
 * a case that recovers closes the moment it recovers, while a case that keeps
 * failing grinds through all three attempts and stays open. Conditioning on
 * "settled" therefore over-samples wins — on this batch it reads 67% against a
 * true recovery rate of 46%, and every score inherits that optimism.
 *
 * So in-progress cases stay in the denominator and count as not-recovered. That
 * is mildly pessimistic for a young case, and it keeps the score answering the
 * same question the dashboard headline answers: of cases like this one, how
 * many are recovered?
 */
export function buildPriors(db) {
  const cases = db.prepare(`
    SELECT rc.id, rc.root_cause, rc.status, rc.attempts_used, rc.closure_reason,
           rc.amount_at_risk_inr, c.segment
    FROM recovery_cases rc
    JOIN customers c ON c.id = rc.customer_id
    WHERE rc.delivery_mode = 'simulated'`).all();

  // Only cases where the agent actually got to try.
  const usable = cases.filter(
    (c) => !(c.attempts_used === 0 && EXCLUDED_CLOSURES.has(c.closure_reason)));

  const globalRate = rate(usable);

  const byRootCause = groupRates(usable, (c) => c.root_cause, globalRate);
  const bySegment = groupRates(usable, (c) => c.segment, globalRate);

  // -- Recovery rate conditional on k interventions having already failed -----
  // "Given the agent has already tried k times without success, how often does
  // the case still end up recovered?" Counted from the interventions, not
  // assumed to decay.
  const logs = db.prepare(`
    SELECT case_id, sequence, outcome FROM intervention_logs
    WHERE executed_at IS NOT NULL ORDER BY case_id, sequence`).all();

  const failuresByCase = new Map();
  for (const l of logs) {
    if (l.outcome !== 'recovered') {
      failuresByCase.set(l.case_id, (failuresByCase.get(l.case_id) || 0) + 1);
    }
  }

  const byAttempt = {};
  for (let k = 0; k < 3; k++) {
    // Cohort: cases that reached the point of having k failed interventions.
    const cohort = usable.filter((c) => (failuresByCase.get(c.id) || 0) >= k);
    byAttempt[k] = {
      n: cohort.length,
      recovered: cohort.filter((c) => c.status === 'recovered').length,
      rate: smoothRate(
        cohort.filter((c) => c.status === 'recovered').length,
        cohort.length, globalRate),
      raw: cohort.length ? cohort.filter((c) => c.status === 'recovered').length / cohort.length : null,
    };
  }

  return {
    globalRate,
    sampleSize: usable.length,
    settled: usable.filter((c) => !IN_FLIGHT.has(c.status)).length,
    excluded: cases.length - usable.length,
    byRootCause,
    bySegment,
    byAttempt,
    smoothing: SMOOTHING,
  };
}

function rate(rows) {
  if (!rows.length) return 0.4;
  return rows.filter((r) => r.status === 'recovered').length / rows.length;
}

function groupRates(rows, keyFn, globalRate) {
  const out = {};
  for (const r of rows) {
    const k = keyFn(r);
    (out[k] ??= { n: 0, recovered: 0 }).n++;
    if (r.status === 'recovered') out[k].recovered++;
  }
  for (const k of Object.keys(out)) {
    out[k].raw = out[k].recovered / out[k].n;
    out[k].rate = smoothRate(out[k].recovered, out[k].n, globalRate);
  }
  return out;
}

/**
 * Per-customer history: what this customer did on their *earlier* cases.
 *
 * `opened_at` is carried so the scorer can restrict itself to cases that opened
 * before the one being scored. That ordering is not a nicety — without it the
 * modifier inverts. Take a customer with two cases, one recovered and one lost:
 * scoring the lost one sees a recovered sibling and marks it up, while scoring
 * the recovered one sees a lost sibling and marks it down. The signal ends up
 * pointing the wrong way on exactly the mixed pairs it was meant to help with.
 * At real scoring time you only know the past, so the fix is also the honest
 * simulation of it.
 */
export function buildCustomerHistory(db) {
  const rows = db.prepare(`
    SELECT rc.id AS case_id, rc.customer_id, rc.status, rc.amount_at_risk_inr, rc.opened_at
    FROM recovery_cases rc WHERE rc.delivery_mode = 'simulated'`).all();

  const amounts = db.prepare(`
    SELECT customer_id, amount_inr FROM payment_attempts WHERE source = 'seed'`).all();

  const history = new Map();
  for (const r of rows) {
    const h = history.get(r.customer_id) ?? { cases: [] };
    h.cases.push(r);
    history.set(r.customer_id, h);
  }
  for (const a of amounts) {
    const h = history.get(a.customer_id) ?? { cases: [] };
    (h.amounts ??= []).push(a.amount_inr);
    history.set(a.customer_id, h);
  }
  for (const h of history.values()) {
    const sorted = (h.amounts ?? []).slice().sort((x, y) => x - y);
    h.typicalAmount = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
  }
  return history;
}
