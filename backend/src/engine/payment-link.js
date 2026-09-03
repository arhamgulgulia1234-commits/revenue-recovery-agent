/**
 * Real Razorpay payment links on a live case.
 *
 * Two moments, and the gap between them is the whole design:
 *
 *   mint    — before the case opens, once the matrix has said its first outreach
 *             will carry a link. The URL then exists in time for the narrator to
 *             put it in the message the customer actually receives.
 *   settle  — afterwards, on demand, when someone asks what happened to it.
 *             Razorpay is the authority; nothing here infers that money arrived.
 *
 * ## Why the link is minted before the case, not during it
 *
 * The runner is synchronous — better-sqlite3 is, and every caller depends on it
 * — so an HTTP call cannot happen inside `runCase`. And the link cannot simply
 * be fetched afterwards either: it has to exist *before* the copy that quotes
 * it. So the matrix is asked what it will choose, and the link is minted only if
 * that answer carries one. A silent retry mints nothing.
 *
 * ## Why settling is a pull, not a webhook
 *
 * A webhook would be the right thing in production and the wrong thing in a
 * demo: it needs a public URL, a signing secret, and a tunnel, and it fails
 * silently when any of the three is off. Asking Razorpay directly is the same
 * fact from the same source, needs nothing but the API key, and can be pressed
 * on stage. The trade is that a payment is recorded when someone asks rather
 * than the instant it lands — which is exactly why the case closes at Razorpay's
 * timestamp and not at ours.
 */

import { createPaymentLink, fetchPaymentLink, RazorpayError, isConfigured } from '../lib/razorpay.js';
import { appendSystemAudit } from './audit.js';
import { ACTION_LABELS } from './matrix.js';
import { formatIst, iso } from '../lib/time.js';

/**
 * Action types whose message copy embeds a payment URL.
 *
 * Derived from narrator.js's `draftMessage`: these are the branches that
 * interpolate `${link}`. `escalation_flag` deliberately does not — a 30-day
 * escalation hands the invoice to a human and asks for a conversation, not a
 * payment — and the two silent retries send nothing at all.
 */
export const ACTIONS_WITH_LINK = new Set([
  'payment_link',
  'update_card_link',
  'alt_method_link',
  'nudge',
  'nudge_with_incentive',
  'reminder_polite',
  'reminder_firm',
]);

export const actionCarriesLink = (actionType) => ACTIONS_WITH_LINK.has(actionType);

export class NoPaymentLink extends Error {}

// ---------------------------------------------------------------------------
// Minting
// ---------------------------------------------------------------------------

/**
 * Mint the link this case's first outreach will quote.
 *
 * Returns `null` rather than throwing when Razorpay is not configured: a live
 * case without a real link is a perfectly good case that falls back to the
 * synthetic link text, and refusing to open it would be worse than opening it
 * unlinked. A configured Razorpay that then *fails* is different — that is
 * reported, because the operator asked for a real link and did not get one.
 *
 * @returns {Promise<{link:object|null, error:string|null, skipped:string|null}>}
 */
export async function mintForCase({ input, customer, forecast, referenceId }) {
  if (!forecast) {
    return { link: null, error: null, skipped: 'the agent takes no action on this case' };
  }
  if (!actionCarriesLink(forecast.actionType)) {
    return {
      link: null,
      error: null,
      skipped: `the agent's first action is ${(ACTION_LABELS[forecast.actionType] ?? forecast.actionType).toLowerCase()}`
             + (forecast.silent ? ', which sends no message' : ', which carries no payment link'),
    };
  }
  if (!isConfigured()) {
    return { link: null, error: null, skipped: 'Razorpay is not configured' };
  }

  try {
    const link = await createPaymentLink({
      amountInr: input.amountInr,
      description: describe(input, customer),
      customer: { name: customer.name, email: customer.email, phone: input.phone },
      referenceId,
      // Notes are what make a link on the Razorpay dashboard traceable back to
      // the decision that minted it, months later, by someone who was not here.
      notes: {
        source: 'revyn',
        decline_code: input.declineCode,
        segment: input.segment,
        action_type: forecast.actionType,
        customer_name: customer.name,
      },
    });
    return { link, error: null, skipped: null };
  } catch (err) {
    if (!(err instanceof RazorpayError)) throw err;
    return { link: null, error: err.message, skipped: null };
  }
}

/** What the payer sees on the Razorpay checkout as the reason they are paying. */
function describe(input, customer) {
  const amount = `₹${Math.round(input.amountInr).toLocaleString('en-IN')}`;
  return input.declineCode === 'invoice_overdue'
    ? `Overdue invoice — ${amount} for ${customer.name}`
    : `Recovering a failed payment of ${amount} for ${customer.name}`;
}

/** The columns a freshly minted link puts on the case row. */
export function linkColumns(link) {
  return {
    payment_link_id: link?.id ?? null,
    payment_link_url: link?.shortUrl ?? null,
    payment_link_ref: link?.referenceId ?? null,
    payment_link_status: link?.status ?? null,
    payment_link_created_at: link?.createdAt ?? null,
    payment_link_checked_at: null,
    payment_id: null,
    paid_at: null,
  };
}

/** The eight Razorpay columns, absent. Every case that has no link carries these. */
export const NO_LINK_COLUMNS = linkColumns(null);

// ---------------------------------------------------------------------------
// Settling
// ---------------------------------------------------------------------------

/**
 * Ask Razorpay what has happened to this case's link, and act on the answer.
 *
 * Idempotent in both directions: asking twice about an unpaid link changes
 * nothing but the checked-at stamp, and asking twice about a paid one does not
 * write the closure or the audit line a second time.
 *
 * @returns {Promise<object>} what Razorpay said and what the case did about it
 */
export async function checkPaymentStatus(db, caseId) {
  const caseRow = db.prepare('SELECT * FROM recovery_cases WHERE id = ?').get(caseId);
  if (!caseRow) throw new NoPaymentLink(`No such case: ${caseId}`);
  if (!caseRow.payment_link_id) {
    throw new NoPaymentLink(
      `Case ${caseId} has no Razorpay payment link. Only live cases whose first outreach `
      + 'carries a link get one, and only when a test-mode key is configured.');
  }

  const link = await fetchPaymentLink(caseRow.payment_link_id);
  const checkedAt = iso(Date.now());

  // Recorded before any decision is taken about it, so a crash between the two
  // leaves the trail saying we asked and got this — never that we did not ask.
  db.prepare(`
    UPDATE recovery_cases SET payment_link_status = @status, payment_link_checked_at = @at,
      payment_link_url = COALESCE(payment_link_url, @url) WHERE id = @id`).run({
    id: caseId, status: link.status, at: checkedAt, url: link.shortUrl,
  });

  const alreadySettled = Boolean(caseRow.paid_at);
  const paid = link.status === 'paid';

  let settled = null;
  if (paid && !alreadySettled) settled = settle(db, caseRow, link, checkedAt);

  return {
    caseId,
    paymentLinkId: link.id,
    paymentLinkUrl: link.shortUrl ?? caseRow.payment_link_url,
    status: link.status,
    statusLabel: STATUS_LABELS[link.status] ?? link.status,
    paid,
    checkedAt,
    checkedAtLabel: formatIst(checkedAt),
    amountInr: link.amountInr,
    amountPaidInr: link.amountPaidInr,
    payment: link.payment,
    /** True only on the call that actually closed the case, never on a re-check. */
    caseClosedNow: Boolean(settled),
    case: db.prepare('SELECT * FROM recovery_cases WHERE id = ?').get(caseId),
    audit: settled?.auditId ?? null,
    note: paid
      ? (settled
        ? 'Payment confirmed — case closed as recovered.'
        : 'Already settled; the case was closed by an earlier check.')
      : UNPAID_NOTES[link.status] ?? 'No payment on this link yet.',
  };
}

const STATUS_LABELS = {
  created: 'Awaiting payment',
  partially_paid: 'Partially paid',
  paid: 'Paid',
  expired: 'Expired',
  cancelled: 'Cancelled',
};

const UNPAID_NOTES = {
  created: 'The link is live and nobody has paid it yet.',
  partially_paid: 'Part of the amount has been paid. The case stays open — this build does not '
                + 'accept partial settlement, and the link was minted with partial payment off.',
  expired: 'The link expired before it was paid. The case is unchanged; mint a new case to try again.',
  cancelled: 'The link was cancelled on the Razorpay dashboard. The case is unchanged.',
};

/**
 * Close the case against a real payment.
 *
 * Every timestamp written here is Razorpay's, not ours. Someone can pay at 14:02
 * and have the status checked at 16:40; a case that closed at 16:40 would report
 * a recovery that took two and a half hours longer than it did, and the elapsed
 * times on the dashboard would quietly be wrong.
 */
function settle(db, caseRow, link, checkedAt) {
  const paidAt = link.payment?.paidAt ?? checkedAt;
  const recovered = Math.round(link.payment?.amountInr ?? link.amountPaidInr ?? caseRow.amount_at_risk_inr);
  const method = link.payment?.method ? ` by ${link.payment.method}` : '';

  // The outreach the customer was responding to when they paid. Usually the one
  // the case is parked on; on a case whose window already expired, the last one
  // that actually went out.
  const log = db.prepare(`
    SELECT * FROM intervention_logs
    WHERE case_id = ? AND executed_at IS NOT NULL
    ORDER BY sequence DESC LIMIT 1`).get(caseRow.id);

  let auditId;
  db.transaction(() => {
    if (log) {
      db.prepare(`
        UPDATE intervention_logs SET responded_at = @at, outcome = 'recovered',
          outcome_detail = @detail WHERE id = @id`).run({
        id: log.id,
        at: paidAt,
        detail: `Paid${method} through the Razorpay link — ₹${recovered.toLocaleString('en-IN')} received`,
      });
    }

    db.prepare(`
      UPDATE recovery_cases SET status = 'recovered', closure_reason = 'payment_recovered',
        recovered_amount_inr = @recovered, closed_at = @paidAt, next_action_at = NULL,
        awaiting_log_id = NULL, payment_id = @paymentId, paid_at = @paidAt,
        payment_link_status = @status, payment_link_checked_at = @checkedAt
      WHERE id = @id`).run({
      id: caseRow.id,
      recovered,
      paidAt,
      paymentId: link.payment?.id ?? null,
      status: link.status,
      checkedAt,
    });

    auditId = appendSystemAudit(db, caseRow.id, {
      eventType: 'payment_confirmed',
      // The line an auditor reads first. Kept short and unambiguous on purpose.
      decision: 'Payment confirmed via Razorpay — case closed.',
      reasoning:
        `Razorpay reports payment link ${link.id} as paid: ₹${recovered.toLocaleString('en-IN')} `
        + `received${method}${link.payment?.id ? ` (payment ${link.payment.id})` : ''} at `
        + `${formatIst(paidAt)}. The case is closed as recovered at that moment — the timestamp is `
        + 'Razorpay\'s own, not the moment the status was checked, so the recovery time on this '
        + 'case is what actually elapsed. No outcome was modelled or inferred here: this is a real '
        + 'payment on a real link, and it is the only thing that can close a live case.',
      at: paidAt,
      policyRefs: 'real_payment_event',
    });
  })();

  return { auditId, paidAt, recovered };
}
