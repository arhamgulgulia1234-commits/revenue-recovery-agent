/**
 * Compliance gates.
 *
 * Every intervention passes through here before it executes. A gate can block
 * an action permanently (hard stop), block the whole case (attempt cap), or
 * merely delay it (quiet hours). Each returns a reason string, because "the
 * agent stopped" is only useful if it also says why.
 */

import { POLICY, isQuietHour } from '../lib/taxonomy.js';
import { toIstParts, istToUtcMs, formatIst } from '../lib/time.js';

const DAY = 86400000;

export const STOP_REASONS = {
  customer_opted_out: 'Customer opted out of contact',
  customer_disputed: 'Customer raised a dispute',
  max_attempts_reached: `Reached the ${POLICY.MAX_ATTEMPTS_PER_CASE}-attempt cap`,
  sequence_exhausted: 'Intervention sequence exhausted with no recovery',
};

/**
 * Hard stops. These are permanent and non-negotiable: once a customer has
 * opted out or disputed, the agent may never contact or debit them again —
 * not on this case, not on any future one.
 *
 * `asOf` matters: a dispute raised *after* recovery already succeeded should not
 * retroactively stop a closed case.
 */
export function checkHardStop(customer, asOf = Date.now()) {
  const optedOut = customer.opted_out_at && new Date(customer.opted_out_at).getTime() <= asOf;
  const disputed = customer.disputed_at && new Date(customer.disputed_at).getTime() <= asOf;

  if (disputed) {
    return {
      stop: true,
      reason: 'customer_disputed',
      detail: STOP_REASONS.customer_disputed,
      since: customer.disputed_at,
    };
  }
  if (optedOut) {
    return {
      stop: true,
      reason: 'customer_opted_out',
      detail: STOP_REASONS.customer_opted_out,
      since: customer.opted_out_at,
    };
  }
  return { stop: false };
}

/** The attempt cap. Counts the agent's own interventions, not the gateway's. */
export function checkAttemptCap(attemptsUsed) {
  if (attemptsUsed >= POLICY.MAX_ATTEMPTS_PER_CASE) {
    return {
      stop: true,
      reason: 'max_attempts_reached',
      detail: STOP_REASONS.max_attempts_reached,
    };
  }
  return { stop: false };
}

/**
 * Quiet hours: 21:00–08:00 in the customer's timezone.
 *
 * This gate applies to *outreach* only. A silent retry sends no notification and
 * wakes nobody, so blocking it at 2am would cost recovery for no compliance
 * benefit. Anything the customer can hear is deferred to 08:30 the next morning.
 */
export function applyQuietHours(scheduledFor, { silent }) {
  if (silent) return { scheduledFor, deferred: false };

  const parts = toIstParts(scheduledFor);
  if (!isQuietHour(parts.hour)) return { scheduledFor, deferred: false };

  // Before 08:00 → this morning. At/after 21:00 → tomorrow morning.
  const rollToTomorrow = parts.hour >= POLICY.QUIET_HOURS.startHour;
  const baseDay = rollToTomorrow ? scheduledFor + DAY : scheduledFor;
  const d = toIstParts(baseDay);
  const deferredTo = istToUtcMs(d.year, d.month, d.day, POLICY.QUIET_HOURS.endHour, 30);

  return {
    scheduledFor: deferredTo,
    deferred: true,
    detail:
      `Outreach fell at ${formatIst(scheduledFor)}, inside quiet hours ` +
      `(${POLICY.QUIET_HOURS_LABEL}). Held until ${formatIst(deferredTo)}.`,
  };
}

/**
 * Run every gate for one proposed intervention.
 *
 * `notBefore` is the earliest the action may run whatever the matrix asked for:
 * the previous action has to have finished, and its response window has to have
 * closed, before the next one is allowed. It is applied *before* quiet hours,
 * not after, because the order matters \u2014 flooring a time that quiet hours had
 * already moved out of the night can push it straight back into it.
 *
 * @returns {{allowed:boolean, stop?:object, scheduledFor:number, deferral?:object}}
 */
export function screen({ customer, attemptsUsed, proposed, asOf, notBefore = 0 }) {
  const hard = checkHardStop(customer, asOf);
  if (hard.stop) return { allowed: false, stop: hard, scheduledFor: proposed.scheduledFor };

  const cap = checkAttemptCap(attemptsUsed);
  if (cap.stop) return { allowed: false, stop: cap, scheduledFor: proposed.scheduledFor };

  const earliest = Math.max(proposed.scheduledFor, notBefore);
  const quiet = applyQuietHours(earliest, proposed);
  return {
    allowed: true,
    scheduledFor: quiet.scheduledFor,
    deferral: quiet.deferred ? quiet : null,
  };
}
