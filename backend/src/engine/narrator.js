/**
 * Narration: the plain-English layer over decisions the engine has already made.
 *
 * Two jobs — the audit reasoning string for each decision, and the outreach copy
 * for each message. This is the deterministic template implementation, and it is
 * also the fallback: it needs no API key, runs offline, and produces identical
 * text on every run, which is what makes an 80-case batch reviewable.
 *
 * `llm-narrator.js` implements this same interface with Claude. Swapping it in
 * changes the prose, never the decision — the decision was made upstream in
 * matrix.js and policy.js before either narrator is called.
 *
 * Interface:
 *   reason(eventType, ctx) -> string
 *   message(action, ctx)   -> { subject?: string, body: string }
 */

import { formatIst } from '../lib/time.js';
import { POLICY } from '../lib/taxonomy.js';
import { BUCKETS } from './classifier.js';
import { ACTION_LABELS } from './matrix.js';

export const MERCHANT_NAME = process.env.MERCHANT_NAME || 'Trellis';

const inr = (n) => '₹' + Math.round(n).toLocaleString('en-IN');
const day = (ms) => Math.max(0, Math.round(ms / 86400000));
const firstName = (name) => name.split(' ')[0];

export const templateNarrator = {
  source: 'template',

  reason(eventType, ctx) {
    const { customer, attempt, classification, action, outcome, stop, deferral, caseRow } = ctx;

    switch (eventType) {
      case 'case_opened':
        return (
          `Opened a recovery case for ${inr(attempt.amount_inr)} after ${customer.name}'s ` +
          `${attempt.channel === 'invoice_link' ? 'invoice went unpaid' : 'payment failed'} ` +
          `on ${formatIst(attempt.created_at)}. The gateway had already tried ` +
          `${attempt.attempt_number} time${attempt.attempt_number === 1 ? '' : 's'} on its own.`
        );

      case 'root_cause_classified':
        // The numeric confidence is shown as its own field in the UI. Keeping it
        // out of the prose stops a narrator repeating it as though it were a
        // fact about the customer rather than a property of the lookup table.
        return (
          `Classified as ${BUCKETS[classification.bucket].label.toLowerCase()} because the gateway ` +
          `returned "${attempt.decline_code}" — ${BUCKETS[classification.bucket].summary}.` +
          (classification.confidence < 0.7
            ? ' The issuer did not give a specific reason, so this bucket is inferred rather than stated by the code.'
            : ' The decline code states this directly, so there is no ambiguity about the cause.')
        );

      case 'intervention_selected': {
        const lead =
          `Attempt ${ctx.attemptIndex + 1} of 3: ${ACTION_LABELS[action.actionType].toLowerCase()}` +
          (action.silent ? '' : ` over ${action.channel} in a ${action.tone} tone`);
        const because = `, chosen because ${action.rationale.why}`;
        const when = `. Scheduled ${action.rationale.timing} (${formatIst(action.scheduledFor)})`;
        // The matrix already explains its own timing; only add context it lacks.
        const extra =
          customer.segment === 'enterprise' && action.channel === 'email'
            ? ', routed to the AP desk on email as the only channel of record for a business account'
            : !action.silent && customer.preferred_channel === action.channel
              ? `, on ${action.channel} because that is this customer's preferred channel`
              : '';
        return lead + because + when + extra + '.';
      }

      case 'quiet_hours_deferred':
        return (
          `Held the outreach rather than sending it: ${deferral.detail} ` +
          `Silent retries are exempt from this rule — they notify nobody — but anything the ` +
          `customer can hear waits until morning.`
        );

      case 'response_window_opened':
        return (
          `${ACTION_LABELS[action.actionType]} sent to ${firstName(customer.name)} over ` +
          `${action.channel}. The case now waits up to ${POLICY.RESPONSE_WINDOW_DAYS} days for a ` +
          `response — until ${formatIst(ctx.deadline)} — and no further outreach goes out before ` +
          `then. Escalating to the next attempt while the customer still has an unanswered ` +
          `message in front of them would be chasing, not recovering.`
        );

      case 'outcome_recorded': {
        const p = outcome.p;
        const odds = p.convert
          ? `Modelled at ${Math.round(p.engage * 100)}% chance of being seen and ` +
            `${Math.round(p.convert * 100)}% chance of payment once seen.`
          : p.engage
            ? `Modelled at ${Math.round(p.engage * 100)}% chance of being seen.`
            : `Modelled at ${Math.round((p.success ?? 0) * 100)}% chance of authorisation.`;
        const window = outcome.engaged === false
          ? ` The ${POLICY.RESPONSE_WINDOW_DAYS}-day response window closed with nothing back, `
            + 'so the agent now decides whether to escalate or stop.'
          : '';
        return `${outcome.detail}. ${odds}${window}`;
      }

      case 'promise_recorded':
        return (
          `${firstName(customer.name)} committed to paying ${inr(ctx.promise.promised_amount_inr)} ` +
          `by ${formatIst(ctx.promise.promised_date)}. Holding all further outreach until that date ` +
          `passes — chasing someone who has already given a date is how goodwill gets burned.`
        );

      case 'promise_kept':
        return `Promise honoured — ${inr(caseRow.amount_at_risk_inr)} received on the committed date.`;

      case 'promise_broken':
        return (
          `The promised date passed with no payment. The case returns to the reminder sequence ` +
          `at the next escalation step, still inside the 3-attempt cap.`
        );

      case 'case_stopped':
        return stopReason(stop, ctx);

      case 'case_recovered':
        return (
          `Recovered ${inr(caseRow.recovered_amount_inr)} after ` +
          `${caseRow.attempts_used} intervention${caseRow.attempts_used === 1 ? '' : 's'}, ` +
          `${day(new Date(caseRow.closed_at) - new Date(caseRow.opened_at))} days after the original failure. ` +
          `Case closed.`
        );

      default:
        return `${eventType} recorded.`;
    }
  },

  message(action, ctx) {
    return draftMessage(action, ctx);
  },
};

function stopReason(stop, ctx) {
  const { customer, caseRow } = ctx;
  switch (stop.reason) {
    case 'customer_opted_out':
      return (
        `Stopped permanently. ${customer.name} opted out of contact on ` +
        `${formatIst(stop.since)}, before this failure occurred. No retry and no message may be ` +
        `sent on this case or any future one — the opt-out covers the customer, not the case.`
      );
    case 'customer_disputed':
      return (
        `Stopped permanently. ${customer.name} raised a dispute on ${formatIst(stop.since)}. ` +
        `While a dispute is open, any further debit attempt or collection message would be ` +
        `improper, so the agent takes no action and hands the case to a human.`
      );
    case 'max_attempts_reached':
      return (
        `Stopped after 3 interventions with no recovery. The cap exists so the agent cannot ` +
        `harass a customer into paying; ${inr(caseRow.amount_at_risk_inr)} stays unrecovered and ` +
        `the case is handed off rather than retried a fourth time.`
      );
    case 'sequence_exhausted':
      return (
        `Stopped: every intervention this root cause supports has been tried. ` +
        `${inr(caseRow.amount_at_risk_inr)} remains unrecovered.`
      );
    case 'opted_out_mid_recovery':
      return (
        `Stopped permanently mid-recovery. ${customer.name} opted out in response to attempt ` +
        `${caseRow.attempts_used}. Contact ends immediately and permanently.`
      );
    case 'disputed_mid_recovery':
      return (
        `Stopped permanently mid-recovery. ${customer.name} raised a dispute in response to ` +
        `attempt ${caseRow.attempts_used}. All collection activity ends immediately.`
      );
    default:
      return `Stopped: ${stop.detail ?? stop.reason}.`;
  }
}

// ---------------------------------------------------------------------------
// Outreach copy
// ---------------------------------------------------------------------------

/**
 * Channel shapes the form: SMS is terse and unpunctuated by emoji, WhatsApp is
 * conversational, email carries a subject and a signature. Tone escalates
 * across attempts but never threatens — for B2B especially, the strongest
 * register available is "we are escalating internally", never a legal threat.
 */
function draftMessage(action, ctx) {
  const { customer, attempt, subscription, invoice } = ctx;
  const name = firstName(customer.name);
  const amount = inr(attempt.amount_inr);
  const item = subscription?.plan_name ?? invoice?.invoice_number ?? 'your payment';
  const link = `${MERCHANT_NAME.toLowerCase()}.in/p/${attempt.id.replace('pay_', '')}`;

  switch (action.actionType) {
    case 'update_card_link':
      return channelWrap(action, {
        subject: `Your card on file has expired — ${item}`,
        sms: `${MERCHANT_NAME}: the card saved for ${item} has expired, so we couldn't collect ${amount}. Update it here: ${link}`,
        whatsapp: `Hi ${name}, the card saved for your ${item} has expired, so this month's ${amount} didn't go through. It takes about a minute to add a new one: ${link}\n\nNothing else changes — your plan stays active.`,
        email: `Hi ${name},\n\nWe weren't able to collect ${amount} for ${item} because the card saved on your account has expired.\n\nYou can add a new payment method here: ${link}\n\nYour plan is still active — we'll retry automatically once the new card is saved.\n\n— ${MERCHANT_NAME}`,
      });

    case 'alt_method_link':
      return channelWrap(action, {
        subject: `Couldn't process ${amount} — try UPI instead?`,
        sms: `${MERCHANT_NAME}: your bank declined the card payment of ${amount} for ${item}. Paying by UPI usually works: ${link}`,
        whatsapp: `Hi ${name}, your bank declined the ${amount} card payment for ${item} — this happens fairly often with recurring card mandates and it isn't anything you did.\n\nUPI tends to go through where the card doesn't: ${link}`,
        email: `Hi ${name},\n\nYour issuing bank declined the ${amount} payment for ${item}. Bank declines on recurring card mandates are common and usually aren't a problem with your account.\n\nThe quickest fix is to pay via UPI: ${link}\n\n— ${MERCHANT_NAME}`,
      });

    case 'payment_link':
      return channelWrap(action, {
        subject: `Payment of ${amount} needs a quick re-try`,
        sms: `${MERCHANT_NAME}: we couldn't verify the ${amount} payment for ${item}. Complete it here: ${link}`,
        whatsapp: `Hi ${name}, the ${amount} payment for ${item} didn't complete — the verification step timed out.\n\nHere's a fresh link to finish it: ${link}`,
        email: `Hi ${name},\n\nThe ${amount} payment for ${item} didn't complete — authentication wasn't finished in time.\n\nYou can pay securely here: ${link}\n\n— ${MERCHANT_NAME}`,
      });

    case 'nudge':
      return channelWrap(action, {
        subject: `You left something unfinished`,
        sms: `${MERCHANT_NAME}: your ${item} checkout is still open. Finish here: ${link}`,
        whatsapp: `Hi ${name}, you were partway through setting up ${item} and the payment didn't go through.\n\nYour details are saved — you can pick up where you left off: ${link}`,
        email: `Hi ${name},\n\nYou were partway through subscribing to ${item} (${amount}) and didn't finish.\n\nEverything's saved: ${link}\n\n— ${MERCHANT_NAME}`,
      });

    case 'nudge_with_incentive':
      return channelWrap(action, {
        subject: `Still interested? Here's 15% off your first month`,
        sms: `${MERCHANT_NAME}: finish setting up ${item} today and get 15% off month one. ${link}`,
        whatsapp: `Hi ${name}, your ${item} setup is still waiting.\n\nIf it was the price, here's 15% off your first month — applied automatically at this link: ${link}`,
        email: `Hi ${name},\n\nYour ${item} signup is still incomplete.\n\nIf cost was the sticking point, we've applied 15% off your first month — it's already on this link: ${link}\n\n— ${MERCHANT_NAME}`,
      });

    case 'reminder_polite':
      return {
        subject: `Invoice ${item} — ${amount} due`,
        body: `Hello,\n\nInvoice ${item} for ${amount} became due on ${formatIst(invoice?.due_at ?? attempt.created_at).split(',')[0]} and we haven't yet received payment.\n\nIf it's already in your approval queue, please ignore this note. If anything is missing on our side — a PO reference, a corrected line item — reply here and we'll get it sorted the same day.\n\nPayment link: ${link}\n\nRegards,\nAccounts Receivable, ${MERCHANT_NAME}`,
      };

    case 'reminder_firm':
      return {
        subject: `Second notice — invoice ${item}, ${amount}, now 14 days overdue`,
        body: `Hello,\n\nInvoice ${item} for ${amount} is now 14 days past its due date. We wrote on day 7 and haven't had a response.\n\nCould you confirm either a payment date or the reason it's being held? If there's a dispute on the invoice we'd rather know now and resolve it than keep sending reminders.\n\nPayment link: ${link}\n\nRegards,\nAccounts Receivable, ${MERCHANT_NAME}`,
      };

    case 'escalation_flag':
      return {
        subject: `Invoice ${item} — 30 days overdue, escalating internally`,
        body: `Hello,\n\nInvoice ${item} for ${amount} is now 30 days past due with no response to our previous two notices.\n\nWe're passing this to your account manager so a person can pick it up directly rather than continuing automated reminders. They'll be in touch this week.\n\nIf payment has already been sent, please share the reference and we'll close this off.\n\nRegards,\nAccounts Receivable, ${MERCHANT_NAME}`,
      };

    default:
      return null; // silent retries send nothing
  }
}

function channelWrap(action, variants) {
  const body = variants[action.channel] ?? variants.email;
  return action.channel === 'email' ? { subject: variants.subject, body } : { body };
}
