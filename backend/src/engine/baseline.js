/**
 * Naive baseline: what blind retrying gets you.
 *
 * Runs the *same* 80 failures through the approach most systems actually take —
 * retry three times on a fixed schedule, send the same generic message every
 * time, never ask why the payment failed.
 *
 * ── Keeping the comparison honest ────────────────────────────────────────────
 *
 * The temptation is to make the baseline stupid enough to lose. Four rules
 * guard against that:
 *
 * 1. SAME MACHINERY. Engagement, attempt decay, reliability weighting and
 *    amount friction all come from outcomes.js unchanged. Only the *inputs* the
 *    real engine derives from diagnosis are removed.
 *
 * 2. NUMBERS ARE ANCHORED, NOT INVENTED. Every probability below either already
 *    exists in the engine's own table or is derived from it. Where a judgement
 *    call was unavoidable it is marked and justified inline.
 *
 * 3. THE BASELINE IS COMPLIANT. It gets the same 3-attempt cap and honours
 *    opt-outs and disputes exactly as the real engine does. We are not beating
 *    a strawman that spams customers who asked to be left alone — the recovery
 *    comparison is about intelligence alone.
 *
 * 4. NO CREDIT WHERE NONE IS DUE. On transient failures a blind retry is
 *    exactly as good as ours, and the table says so. The real engine wins there
 *    on speed, not outcome, and the comparison does not pretend otherwise.
 *
 * The baseline does not know the root cause — but reality still does. An
 * expired card cannot be fixed by retrying it, whether or not the system
 * understands why. That is what the table below encodes: the baseline is not
 * penalised for being ignorant, it is penalised for the actions ignorance leads
 * it to take.
 */

import { makeRandom } from '../lib/rng.js';
import { classify } from './classifier.js';
import { OUTCOME_TABLES } from './outcomes.js';
import { checkHardStop } from './policy.js';
import { POLICY } from '../lib/taxonomy.js';
import { iso } from '../lib/time.js';

const HOUR = 3600000;
const DAY = 86400000;

/** Fixed 24-hour interval — no timing intelligence of any kind. */
const RETRY_INTERVAL_MS = 24 * HOUR;

/**
 * P(a blind retry succeeds), by what actually broke.
 *
 *  transient       identical to the engine's own silent_retry row. A retry is
 *                  the correct action here and the baseline stumbles into it,
 *                  so it gets full credit.
 *  timing_issue    the engine's own `timing_issue:silent_retry` row — the
 *                  penalty it already applies to an *untimed* retry. Not a
 *                  number invented for this comparison.
 *  bank_side_block judgement call. Issuer soft-declines sometimes clear on a
 *                  later attempt, but a retry offers no alternate method, so
 *                  this sits well below the 0.45 conversion the engine gets
 *                  from actually suggesting UPI.
 *  the rest        a retry cannot repair an expired card, supply a missing CVV,
 *                  complete an abandoned checkout, or make a finance team pay
 *                  an invoice. Non-zero only for the chance the customer fixed
 *                  it themselves in the meantime.
 */
const BLIND_RETRY_SUCCESS = {
  transient:         OUTCOME_TABLES.RETRY_SUCCESS['transient:silent_retry'],
  timing_issue:      OUTCOME_TABLES.RETRY_SUCCESS['timing_issue:silent_retry'],
  bank_side_block:   [0.12, 0.09, 0.06],
  instrument_issue:  [0.02, 0.015, 0.01],
  user_input_error:  [0.02, 0.015, 0.01],
  drop_off:          [0.02, 0.015, 0.01],
  receivable:        [0.03, 0.02, 0.015],
};

/**
 * P(pays | reads the generic message).
 *
 * Anchored to the floor of the engine's own CONVERSION table (drop_off:nudge,
 * 0.30) — the least effective tailored intervention it models. A message that
 * says "please retry your payment" without naming the problem or the fix cannot
 * reasonably beat the weakest message that does.
 */
const GENERIC_CONVERSION = Math.min(...Object.values(OUTCOME_TABLES.CONVERSION));

/** One channel for everyone, no preference lookup. Email is the usual default. */
const GENERIC_CHANNEL = 'email';

export const GENERIC_MESSAGE =
  'Your recent payment did not go through. Please retry your payment at your earliest '
  + 'convenience to avoid interruption to your service.';

const clamp = (n, lo = 0.01, hi = 0.97) => Math.min(hi, Math.max(lo, n));
const reliabilityFactor = (r, strength) => 1 - strength + r * (strength * 2);

function amountFriction(amountInr) {
  if (amountInr > 500000) return 0.85;
  if (amountInr > 100000) return 0.92;
  return 1;
}

/**
 * Run the naive approach over every failed attempt.
 * Pure — reads the same rows the engine did, writes nothing.
 */
export function runBaseline(db, { seed = Number(process.env.SEED) || 20260829 } = {}) {
  const rand = makeRandom(seed + 991); // own stream, so it cannot perturb the engine's
  const now = process.env.SEED_NOW ? new Date(process.env.SEED_NOW).getTime() : Date.now();

  const attempts = db.prepare(`
    SELECT * FROM payment_attempts WHERE status = 'failed' ORDER BY created_at ASC`).all();
  const customers = new Map(db.prepare('SELECT * FROM customers').all().map((c) => [c.id, c]));

  const results = [];

  for (const attempt of attempts) {
    const customer = customers.get(attempt.customer_id);
    // Reality decides what broke, even though this system never asks.
    const { bucket } = classify(attempt);
    const openedAt = new Date(attempt.created_at).getTime();

    const row = {
      payment_attempt_id: attempt.id,
      customer_id: attempt.customer_id,
      customer_name: customer.name,
      amount_inr: attempt.amount_inr,
      root_cause: bucket,
      status: 'failed',
      attempts_used: 0,
      contacts_made: 0,
      recovered_amount_inr: 0,
      recovered_at: null,
      days_to_recovery: null,
    };

    // Same hard stops as the real engine — see rule 3 above.
    if (checkHardStop(customer, openedAt).stop) {
      row.status = 'stopped';
      row.stop_reason = 'hard_stop';
      results.push(row);
      continue;
    }

    for (let k = 0; k < POLICY.MAX_ATTEMPTS_PER_CASE; k++) {
      const at = openedAt + (k + 1) * RETRY_INTERVAL_MS;
      if (at > now) break; // not due yet, same as the engine

      row.attempts_used = k + 1;
      // Every attempt messages the customer: no concept of a silent retry.
      row.contacts_made += 1;

      const retryTable = BLIND_RETRY_SUCCESS[bucket] ?? [0.05, 0.03, 0.02];
      const pRetry = clamp(retryTable[Math.min(k, retryTable.length - 1)]
        * reliabilityFactor(customer.reliability_score, 0.15));

      if (rand.next() < pRetry) {
        row.status = 'recovered';
        row.recovered_amount_inr = attempt.amount_inr;
        row.recovered_at = iso(at);
        row.days_to_recovery = (at - openedAt) / DAY;
        break;
      }

      // The generic message. Same engagement machinery as the real engine.
      const pEngage = clamp(
        OUTCOME_TABLES.ENGAGEMENT_BY_CHANNEL[GENERIC_CHANNEL]
        * [1.0, 0.82, 0.66][Math.min(k, 2)]
        * reliabilityFactor(customer.reliability_score, 0.2),
      );
      if (rand.next() < pEngage) {
        const pConvert = clamp(GENERIC_CONVERSION
          * reliabilityFactor(customer.reliability_score, 0.15)
          * amountFriction(attempt.amount_inr));
        if (rand.next() < pConvert) {
          row.status = 'recovered';
          row.recovered_amount_inr = attempt.amount_inr;
          row.recovered_at = iso(at);
          row.days_to_recovery = (at - openedAt) / DAY;
          break;
        }
      }
    }

    if (row.status === 'failed' && row.attempts_used >= POLICY.MAX_ATTEMPTS_PER_CASE) {
      row.stop_reason = 'max_attempts_reached';
    } else if (row.status === 'failed') {
      row.status = 'in_progress';
    }
    results.push(row);
  }

  return { results, config: describeConfig() };
}

export function describeConfig() {
  return {
    retryIntervalHours: RETRY_INTERVAL_MS / HOUR,
    maxAttempts: POLICY.MAX_ATTEMPTS_PER_CASE,
    channel: GENERIC_CHANNEL,
    genericConversion: GENERIC_CONVERSION,
    honoursHardStops: true,
    blindRetrySuccess: BLIND_RETRY_SUCCESS,
  };
}
