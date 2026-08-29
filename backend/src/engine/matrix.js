/**
 * The intervention decision matrix.
 *
 * Given a root-cause bucket and how many attempts have already happened, decide
 * exactly one action: what to do, when to do it, and over which channel.
 *
 * Pure and deterministic — same inputs, same decision, every time. Nothing here
 * calls a model. The LLM's job starts *after* this returns, writing the copy and
 * the reasoning for a decision that has already been made.
 */

import { toIstParts, istToUtcMs } from '../lib/time.js';

const HOUR = 3600000;
const DAY = 86400000;

/** Channels a customer can be reached on, best-first, if their preference fails. */
function contactChannel(customer) {
  if (customer.segment === 'enterprise') return 'email';
  return customer.preferred_channel;
}

/** How long we're willing to sit on a retry waiting for a salary credit. */
const MAX_FUNDS_WAIT = 7 * DAY;

/**
 * When is money most likely to be in this account again?
 *
 * Most Indian salaries land on the 1st; the generator gives each customer their
 * own cluster day, and we aim one day after it so the credit has settled.
 *
 * But waiting is not free. If the next salary date is more than a week out,
 * parking the retry until then means sitting on the money while the customer
 * churns — and accounts receive inflows other than salary. So beyond a week we
 * fall back to a plain 3-day retry rather than holding for the perfect date.
 */
export function likelyFundsDate(customer, from) {
  const day = customer.salary_day || 1;
  const p = toIstParts(from);
  let salary = istToUtcMs(p.year, p.month, day, 11, 0);
  if (salary <= from + 12 * HOUR) {
    const nextMonth = p.month === 12 ? 1 : p.month + 1;
    const nextYear = p.month === 12 ? p.year + 1 : p.year;
    salary = istToUtcMs(nextYear, nextMonth, day, 11, 0);
  }
  salary += DAY; // let the credit settle

  if (salary - from <= MAX_FUNDS_WAIT) {
    return { when: salary, alignedToSalary: true, day };
  }
  return { when: from + 3 * DAY, alignedToSalary: false, day };
}

/**
 * @returns {null|{actionType,channel,tone,scheduledFor,rationale,silent}}
 *          null means "no further action available" (sequence exhausted).
 */
export function decideIntervention({ bucket, attemptIndex, customer, attempt, caseOpenedAt }) {
  const n = attemptIndex; // 0-based: which agent intervention this is
  const channel = contactChannel(customer);
  const base = caseOpenedAt;

  // A gateway that already burned 3 silent retries has proven silent retries
  // don't work here. Skip straight to talking to the customer.
  const gatewayExhausted = (attempt.attempt_number || 1) >= 3;

  switch (bucket) {
    case 'transient': {
      // Nothing is wrong with the customer. Retry quietly and quickly.
      const delays = [15 * 60000, 2 * HOUR, 12 * HOUR];
      if (n > 2) return null;
      return {
        actionType: 'silent_retry',
        channel: 'none',
        tone: null,
        silent: true,
        scheduledFor: base + delays[n],
        rationale: {
          why: 'the failure was on the payment rails, not the customer',
          timing: ['a 15-minute', 'a 2-hour', 'a 12-hour'][n] + ' back-off',
        },
      };
    }

    case 'timing_issue': {
      // The money will exist; we just asked on the wrong day.
      if (n > 2) return null;

      if (n === 0 && !gatewayExhausted) {
        const funds = likelyFundsDate(customer, base);
        return {
          actionType: 'timed_retry',
          channel: 'none',
          tone: null,
          silent: true,
          scheduledFor: funds.when,
          fundsTiming: funds,
          rationale: {
            why: 'the balance was short, not the instrument broken',
            // Phrased so the negative case cannot be read as its opposite:
            // a narrator that sees "3-day delay" next to "salary day 7" will
            // otherwise reconstruct the delay as *reaching* the salary date,
            // which reverses the actual reasoning.
            timing: funds.alignedToSalary
              ? `aligned to this customer's salary-credit cluster, which lands on day ${funds.day} of the month, so the retry is timed to land just after money arrives`
              : `a plain 3-day back-off. Salary alignment was considered and rejected here: their salary lands on day ${funds.day}, more than a week away, and holding a retry idle that long risks losing the customer before it ever runs. This retry is deliberately NOT timed to their salary date`,
          },
        };
      }

      // Retrying twice into an empty account is just noise — ask instead.
      return {
        actionType: 'payment_link',
        channel,
        tone: ['friendly', 'friendly', 'firm'][n],
        silent: false,
        scheduledFor: base + [1, 3, 7][n] * DAY,
        rationale: {
          why: gatewayExhausted && n === 0
            ? 'the gateway already spent its own retries on this mandate, so another silent attempt would just repeat a known failure'
            : 'a second silent retry into a short account would fail the same way',
          timing: `${[1, 3, 7][n]} day${[1, 3, 7][n] === 1 ? '' : 's'} after the original failure`,
        },
      };
    }

    case 'instrument_issue': {
      // Only the customer can fix this. Retrying an expired card is pointless.
      if (n > 2) return null;
      return {
        actionType: 'update_card_link',
        channel: n === 2 ? 'email' : channel,
        tone: ['friendly', 'neutral', 'firm'][n],
        silent: false,
        scheduledFor: base + [HOUR, 3 * DAY, 7 * DAY][n],
        rationale: {
          why: 'the stored card has expired and no retry can succeed until it is replaced',
          timing: ['within the hour', 'after 3 days with no update', 'after a week with no update'][n],
        },
      };
    }

    case 'bank_side_block': {
      if (n > 2) return null;
      return {
        actionType: 'alt_method_link',
        channel: n === 2 ? 'email' : channel,
        tone: ['friendly', 'neutral', 'firm'][n],
        silent: false,
        scheduledFor: base + [2 * HOUR, 1 * DAY, 4 * DAY][n],
        rationale: {
          why: 'the issuer blocked the card without a reason, so the card itself is the obstacle',
          timing: ['same day', 'after 1 day', 'after 4 days'][n],
        },
      };
    }

    case 'user_input_error': {
      // Never silently retry a CVV or 3DS failure — the customer has to re-enter.
      if (n > 2) return null;
      return {
        actionType: 'payment_link',
        channel: n === 2 ? 'email' : channel,
        tone: ['friendly', 'neutral', 'firm'][n],
        silent: false,
        scheduledFor: base + [30 * 60000, 2 * DAY, 5 * DAY][n],
        rationale: {
          why: 'authentication needs fresh input from the customer, which a silent retry cannot supply',
          timing: ['within the hour', 'after 2 days', 'after 5 days'][n],
        },
      };
    }

    case 'drop_off': {
      if (n > 2) return null;
      // Escalate to an incentive only once the plain nudge has failed.
      const withIncentive = n >= 1;
      return {
        actionType: withIncentive ? 'nudge_with_incentive' : 'nudge',
        channel: n === 2 ? 'email' : channel,
        tone: 'friendly',
        silent: false,
        scheduledFor: base + [1 * HOUR, 1 * DAY, 3 * DAY][n],
        rationale: {
          why: withIncentive
            ? 'a plain reminder did not bring them back, so the offer needs a reason to act'
            : 'the customer showed intent but did not complete payment',
          timing: ['1 hour after drop-off', 'next day', 'after 3 days'][n],
        },
      };
    }

    case 'receivable': {
      // Escalating, never threatening. Measured from the invoice due date.
      if (n > 2) return null;
      const steps = [
        { actionType: 'reminder_polite', tone: 'friendly', day: 7,
          why: 'the invoice is a week past due and this is usually an AP processing lag' },
        { actionType: 'reminder_firm', tone: 'firm', day: 14,
          why: 'two weeks past due with no response means the polite reminder did not reach the right desk' },
        { actionType: 'escalation_flag', tone: 'formal', day: 30,
          why: 'a month past due — this needs a human account manager, not another automated email' },
      ];
      const step = steps[n];
      return {
        actionType: step.actionType,
        channel: 'email',
        tone: step.tone,
        silent: false,
        scheduledFor: base + step.day * DAY,
        rationale: { why: step.why, timing: `day ${step.day} of the reminder sequence` },
      };
    }

    default:
      return null;
  }
}

/** Human label for each action type, used in the audit trail and the UI. */
export const ACTION_LABELS = {
  silent_retry: 'Silent auto-retry',
  timed_retry: 'Timed retry',
  payment_link: 'Payment link',
  update_card_link: 'Update payment method link',
  alt_method_link: 'Alternate payment method (UPI)',
  nudge: 'Checkout nudge',
  nudge_with_incentive: 'Checkout nudge + incentive',
  reminder_polite: 'Polite payment reminder',
  reminder_firm: 'Firm payment reminder',
  escalation_flag: 'Escalated to account manager',
};
