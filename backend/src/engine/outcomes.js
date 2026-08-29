/**
 * Outcome simulation.
 *
 * Stands in for the real world: does the retry go through, does the customer
 * open the message, do they actually pay. Every probability lives in a table
 * here rather than scattered through the engine, so the recovery rate can be
 * audited and tuned in one place.
 *
 * Two-stage for anything involving a message: first *engagement* (did it get
 * seen), then *conversion* (having seen it, did they pay). That split is what
 * makes "expired card + update link succeeds ~40% if clicked" mean what it says
 * — 40% is the conversion leg, not the end-to-end rate.
 */

/** Direct success of a retry — no customer involvement, by attempt index. */
const RETRY_SUCCESS = {
  'transient:silent_retry': [0.8, 0.55, 0.4],
  'timing_issue:timed_retry': [0.6, 0.42, 0.3],
  'timing_issue:silent_retry': [0.3, 0.22, 0.16],
};

/** P(message is seen and clicked), before modifiers. */
const ENGAGEMENT_BY_CHANNEL = { whatsapp: 0.62, sms: 0.45, email: 0.38, voice: 0.5 };

/** Each follow-up is read by fewer people than the last. */
const ATTEMPT_DECAY = [1.0, 0.82, 0.66];

/** P(pays | engaged). The headline "success if clicked" number. */
const CONVERSION = {
  'instrument_issue:update_card_link': 0.4,
  'bank_side_block:alt_method_link': 0.45,
  'user_input_error:payment_link': 0.5,
  'timing_issue:payment_link': 0.38,
  'drop_off:nudge': 0.3,
  'drop_off:nudge_with_incentive': 0.42,
  'receivable:reminder_polite': 0.34,
  'receivable:reminder_firm': 0.46,
  'receivable:escalation_flag': 0.58,
};

/** P(promise to pay | engaged but did not pay). Only where a promise is meaningful. */
const PROMISE_RATE = { receivable: 0.38, timing_issue: 0.22 };

/** P(this outreach itself triggers an opt-out or dispute), by tone. */
const OPT_OUT_RISK = { friendly: 0.015, neutral: 0.022, firm: 0.038, formal: 0.02 };
const DISPUTE_RISK = 0.01;

const clamp = (n, lo = 0.02, hi = 0.97) => Math.min(hi, Math.max(lo, n));

/** Reliable payers pay; unreliable ones don't. Applied to both legs, gently. */
const reliabilityFactor = (r, strength) => 1 - strength + r * (strength * 2);

/** Large invoices need a human approval chain, so they convert worse. */
function amountFriction(amountInr) {
  if (amountInr > 500000) return 0.85;
  if (amountInr > 100000) return 0.92;
  return 1;
}

/**
 * @returns {{outcome, detail, engaged, p}} where `p` records the probabilities
 *          actually used, so the audit trail can quote them.
 */
export function simulateOutcome({ bucket, action, customer, attemptIndex, amountInr, rand }) {
  const key = `${bucket}:${action.actionType}`;
  const r = customer.reliability_score;

  // ---- Silent / timed retries: one roll, no customer involvement ----------
  if (action.silent) {
    const table = RETRY_SUCCESS[key] ?? [0.25, 0.18, 0.12];
    const p = clamp(table[Math.min(attemptIndex, table.length - 1)] * reliabilityFactor(r, 0.15));
    if (rand.next() < p) {
      return {
        outcome: 'recovered',
        detail: 'Retry authorised by the issuer',
        engaged: null,
        p: { success: round(p) },
      };
    }
    return {
      outcome: 'failed',
      detail: 'Retry declined again',
      engaged: null,
      p: { success: round(p) },
    };
  }

  // ---- Outreach: engagement, then conversion ------------------------------
  const pEngage = clamp(
    (ENGAGEMENT_BY_CHANNEL[action.channel] ?? 0.4) *
      ATTEMPT_DECAY[Math.min(attemptIndex, 2)] *
      reliabilityFactor(r, 0.2),
  );

  if (rand.next() >= pEngage) {
    return {
      outcome: 'no_response',
      detail: `No open or click on the ${action.channel} message`,
      engaged: false,
      p: { engage: round(pEngage) },
    };
  }

  // They saw it. Did the message itself cost us the customer?
  const optOutRisk = OPT_OUT_RISK[action.tone] ?? 0.02;
  if (rand.next() < optOutRisk) {
    return {
      outcome: 'failed',
      detail: 'Customer opted out of further contact after this message',
      engaged: true,
      triggeredHardStop: 'customer_opted_out',
      p: { engage: round(pEngage), optOut: round(optOutRisk) },
    };
  }
  if (rand.next() < DISPUTE_RISK) {
    return {
      outcome: 'failed',
      detail: 'Customer raised a dispute in response to this message',
      engaged: true,
      triggeredHardStop: 'customer_disputed',
      p: { engage: round(pEngage), dispute: DISPUTE_RISK },
    };
  }

  const pConvert = clamp(
    (CONVERSION[key] ?? 0.3) * reliabilityFactor(r, 0.15) * amountFriction(amountInr),
  );

  if (rand.next() < pConvert) {
    return {
      outcome: 'recovered',
      detail: 'Customer completed payment from the message',
      engaged: true,
      p: { engage: round(pEngage), convert: round(pConvert) },
    };
  }

  // Engaged, didn't pay — but may commit to a date.
  const pPromise = PROMISE_RATE[bucket] ?? 0;
  if (pPromise && rand.next() < pPromise) {
    return {
      outcome: 'promise_to_pay',
      detail: 'Customer acknowledged and committed to a payment date',
      engaged: true,
      p: { engage: round(pEngage), convert: round(pConvert), promise: pPromise },
    };
  }

  return {
    outcome: 'failed',
    detail: 'Message was seen but no payment followed',
    engaged: true,
    p: { engage: round(pEngage), convert: round(pConvert) },
  };
}

/** Does a promise-to-pay actually get honoured? */
export function simulatePromiseKept({ customer, rand }) {
  const p = clamp(0.5 + customer.reliability_score * 0.35);
  return { kept: rand.next() < p, p: round(p) };
}

const round = (n) => Number(n.toFixed(3));

export const OUTCOME_TABLES = { RETRY_SUCCESS, ENGAGEMENT_BY_CHANNEL, CONVERSION, PROMISE_RATE };
