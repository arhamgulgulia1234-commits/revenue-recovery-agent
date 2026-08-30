/**
 * Opening a real case: one that sends an actual WhatsApp message to an actual
 * phone, and is written to the real book rather than a scratch database.
 *
 * This is the deliberate opposite of live-run.js. That module exists to *show*
 * the agent working and persists nothing; this one commits. The distinction is
 * carried on the row itself as `delivery_mode`, and everything downstream —
 * which clock the case runs on, whether an outcome may be invented, whether a
 * message is really sent — keys off it.
 *
 * ## Why the failure is dated in the past
 *
 * The matrix schedules interventions relative to the failure: a card-update
 * reminder on day 3, an invoice reminder on day 7 past due. A failure stamped
 * "just now" would therefore schedule its first outreach days out, and testing
 * it would mean waiting days. So the failure is back-dated by exactly the offset
 * the matrix asks for, which puts the first action due right now.
 *
 * That offset is measured by asking the matrix rather than guessing: build the
 * case at `now`, read where it wanted to put the first action, and shift the
 * failure back by that gap. Because the matrix's offsets are constants relative
 * to its anchor, shifting the anchor moves the action one-for-one, so a single
 * pass lands it exactly. Nothing about the decision is altered — the agent still
 * decides for itself what to send and when; it is only being asked about a
 * failure that is genuinely old enough for its answer to be due.
 *
 * Quiet hours are *not* compensated for. If the resulting send lands between
 * 9 PM and 8 AM IST, the compliance gate defers it to the morning exactly as it
 * would for any other case, and the caller is told so.
 */

import { classify } from './classifier.js';
import { decideIntervention } from './matrix.js';
import { createRunner } from './runner.js';
import { normalisePhone, InvalidPhone } from '../lib/phone.js';
import { iso } from '../lib/time.js';
import { DECLINE_CODES, POLICY } from '../lib/taxonomy.js';
import { PLANS, INVOICE_ITEMS } from '../data/catalog.js';

const DAY = 86400000;
const HOUR = 3600000;

/** The floor the runner puts under a first action: opened_at + 1 hour. */
const FIRST_ACTION_FLOOR = HOUR;

export class InvalidLiveInput extends Error {}

const SEGMENTS = ['consumer', 'prosumer', 'smb'];
const DEFAULT_RELIABILITY = { consumer: 0.62, prosumer: 0.7, smb: 0.72 };
const DEFAULT_LTV = { consumer: 4200, prosumer: 22000, smb: 145000 };

const hash = (s) => [...s].reduce((n, ch) => (n * 31 + ch.charCodeAt(0)) >>> 0, 7);

/**
 * Validate the form.
 *
 * `enterprise` is refused rather than accepted-and-ignored: the matrix routes
 * enterprise contact to email unconditionally, so an enterprise live case would
 * open, behave correctly, and never send a WhatsApp message. Saying so up front
 * beats a silent no-op.
 */
export function parseLiveInput(body = {}) {
  const bad = (msg) => { throw new InvalidLiveInput(msg); };

  const customerName = String(body.customerName ?? '').trim().slice(0, 80);
  if (!customerName) bad('Give the customer a name.');

  let phone;
  try {
    phone = normalisePhone(body.phone);
  } catch (err) {
    if (err instanceof InvalidPhone) bad(err.message);
    throw err;
  }

  const segment = String(body.segment ?? 'consumer');
  if (segment === 'enterprise') {
    bad('Enterprise cases are routed to email by the intervention matrix and will never send ' +
        'a WhatsApp message. Use consumer, prosumer or smb for a live WhatsApp test.');
  }
  if (!SEGMENTS.includes(segment)) bad(`Unknown segment: ${segment}. One of ${SEGMENTS.join(', ')}.`);

  const declineCode = String(body.declineCode ?? '');
  if (!DECLINE_CODES[declineCode]) bad(`Unknown decline code: ${declineCode || '(none)'}`);

  const amountInr = Math.round(Number(body.amountInr));
  if (!Number.isFinite(amountInr) || amountInr < 1 || amountInr > 100_000_000) {
    bad('Amount must be between ₹1 and ₹10,00,00,000.');
  }

  return { customerName, phone, segment, declineCode, amountInr };
}

/** A persisted customer for this live case, reusing one by phone if it exists. */
function upsertCustomer(db, input, now) {
  const existing = db.prepare(
    'SELECT * FROM customers WHERE phone = ? ORDER BY created_at DESC LIMIT 1').get(input.phone);
  if (existing) return existing;

  const first = input.customerName.split(' ')[0].toLowerCase();
  const customer = {
    id: `cust_live_${hash(input.phone).toString(36)}`,
    name: input.customerName,
    segment: input.segment,
    phone: input.phone,
    email: `${first}@example.com`,
    reliability_score: DEFAULT_RELIABILITY[input.segment],
    lifetime_value_inr: DEFAULT_LTV[input.segment],
    timezone: 'Asia/Kolkata',
    salary_day: 1,
    // Forced, not defaulted. Someone who handed over a WhatsApp number for this
    // has stated their channel; the matrix reads this field to pick one.
    preferred_channel: 'whatsapp',
    opted_out_at: null,
    disputed_at: null,
    created_at: iso(now - 400 * DAY),
  };
  // A second case for the same phone reuses the row rather than duplicating it.
  const clash = db.prepare('SELECT * FROM customers WHERE id = ?').get(customer.id);
  if (clash) return clash;

  const cols = Object.keys(customer);
  db.prepare(`INSERT INTO customers (${cols.join(',')}) VALUES (${cols.map((c) => '@' + c).join(',')})`)
    .run(customer);
  return customer;
}

/** The failed payment, and whatever it was for, at a given failure time. */
function buildFailure(db, customer, input, failedAt, suffix) {
  const meta = DECLINE_CODES[input.declineCode];
  const isInvoice = input.declineCode === 'invoice_overdue';
  const isCheckout = input.declineCode === 'abandoned_checkout';
  const h = hash(customer.name + input.declineCode);

  if (isInvoice) {
    // AP flags an overdue invoice a few days after the due date; the matrix
    // counts reminder days from the due date, so that is the anchor.
    const dueAt = failedAt - 3 * DAY;
    const invoice = {
      id: `inv_live_${suffix}`,
      customer_id: customer.id,
      invoice_number: `RZP/2026/${String(9000 + (h % 900))}`,
      amount_inr: input.amountInr,
      issued_at: iso(dueAt - 30 * DAY),
      due_at: iso(dueAt),
      status: 'overdue',
      po_number: `PO-${100000 + (h % 900000)}`,
    };
    const daysOverdue = Math.max(0, Math.floor((Date.now() - dueAt) / DAY));
    return {
      invoice,
      subscription: null,
      attempt: {
        id: `pay_live_${suffix}`,
        customer_id: customer.id,
        subscription_id: null,
        invoice_id: invoice.id,
        amount_inr: input.amountInr,
        status: 'failed',
        decline_code: input.declineCode,
        gateway_message: `Invoice ${invoice.invoice_number} is ${daysOverdue} days past due — no payment received`,
        attempt_number: 1,
        channel: 'invoice_link',
        created_at: iso(failedAt),
        source: 'live',
      },
    };
  }

  const plans = PLANS[customer.segment] ?? [{ name: 'Platform subscription' }];
  const subscription = {
    id: `sub_live_${suffix}`,
    customer_id: customer.id,
    plan_name: plans[h % plans.length].name,
    amount_inr: input.amountInr,
    frequency: 'monthly',
    status: isCheckout ? 'pending' : 'past_due',
    mandate_type: 'card',
    started_at: iso(failedAt - 200 * DAY),
    next_billing_at: iso(failedAt + 30 * DAY),
  };

  return {
    subscription,
    invoice: null,
    attempt: {
      id: `pay_live_${suffix}`,
      customer_id: customer.id,
      subscription_id: subscription.id,
      invoice_id: null,
      amount_inr: input.amountInr,
      status: 'failed',
      decline_code: input.declineCode,
      gateway_message: meta.gatewayMessages[h % meta.gatewayMessages.length],
      attempt_number: 1,
      channel: isCheckout ? 'checkout' : 'autopay',
      created_at: iso(failedAt),
      source: 'live',
    },
  };
}

/**
 * How far back this failure has to be dated for its first action to be due now.
 *
 * Asks the matrix where it would put the first intervention for a failure
 * stamped `now`, and returns that gap. Zero if it is already due.
 */
function leadTimeFor(db, customer, input, now) {
  const probe = buildFailure(db, customer, input, now, 'probe');
  const { bucket } = classify(probe.attempt);
  const anchor = probe.invoice ? new Date(probe.invoice.due_at).getTime() : now;
  const decision = decideIntervention({
    bucket, attemptIndex: 0, customer, attempt: probe.attempt, caseOpenedAt: anchor,
  });
  if (!decision) return 0;
  return Math.max(0, decision.scheduledFor + FIRST_ACTION_FLOOR - now);
}

const insert = (db, table, row) => {
  const cols = Object.keys(row);
  db.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map((c) => '@' + c).join(',')})`)
    .run(row);
};

/**
 * Open a live case, persist it, and take it as far as it can go right now.
 *
 * Does not send anything — that is engine/delivery.js, called by the route just
 * after. This function only leaves the outbox row behind.
 *
 * @returns {{caseRow:object, attempt:object, customer:object, interventions:object[]}}
 */
export function openLiveCase(db, input, { now = Date.now(), seed = Date.now() % 2147483647 } = {}) {
  const customer = upsertCustomer(db, input, now);

  // A live case must never inherit a hard stop silently: if this customer opted
  // out on a previous case, the runner will stop this one before it acts, which
  // is correct — but the caller should be told why rather than seeing a case
  // that opened and did nothing.
  const lead = leadTimeFor(db, customer, input, now);
  const failedAt = now - lead;

  const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
  const { attempt, subscription, invoice } = buildFailure(db, customer, input, failedAt, suffix);

  if (subscription) insert(db, 'subscriptions', subscription);
  if (invoice) insert(db, 'invoices', invoice);
  insert(db, 'payment_attempts', attempt);

  const runner = createRunner({ db, seed, now, mode: 'live' });
  const caseRow = runner.runCase({
    attempt, customer, subscription, invoice,
    deliveryMode: 'live',
    contactPhone: input.phone,
  });

  const interventions = db.prepare(
    'SELECT * FROM intervention_logs WHERE case_id = ? ORDER BY sequence').all(caseRow.id);

  return {
    caseRow, attempt, customer, subscription, invoice, interventions,
    backdatedBy: lead,
    responseWindowDays: POLICY.RESPONSE_WINDOW_DAYS,
  };
}

export { SEGMENTS as LIVE_SEGMENTS };
