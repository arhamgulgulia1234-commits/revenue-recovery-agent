/**
 * Synthetic dataset generator.
 *
 * Produces a realistic book of at-risk revenue: customers, their subscriptions
 * and B2B invoices, and ~80 failed payment attempts spread across the decline
 * codes the decision engine knows how to handle.
 *
 * Everything is driven by a seeded PRNG, so `npm run seed` is reproducible.
 * Nothing here touches the database — it returns plain objects, so the dataset
 * can be inspected or unit-tested without SQLite.
 */

import { makeRandom } from '../lib/rng.js';
import { iso, toIstParts, istToUtcMs } from '../lib/time.js';
import { DECLINE_CODES } from '../lib/taxonomy.js';
import {
  FIRST_NAMES, LAST_NAMES, COMPANY_PREFIX, COMPANY_SUFFIX, COMPANY_TYPE,
  PLANS, INVOICE_ITEMS,
} from './catalog.js';

const DAY = 86400000;

/** How the failure mix is weighted. Roughly mirrors real gateway decline distributions. */
const DECLINE_WEIGHTS = [
  ['insufficient_funds', 30],
  ['expired_card', 13],
  ['do_not_honor', 14],
  ['card_declined', 8],
  ['authentication_failed', 9],
  ['technical_error', 7],
  ['gateway_timeout', 6],
  ['invalid_cvv', 5],
  ['abandoned_checkout', 8],
];

const SEGMENT_MIX = [
  ['consumer', 26],
  ['prosumer', 14],
  ['smb', 12],
  ['enterprise', 8],
];

/** Reliability priors per segment: [mean, sd]. Enterprises pay late, but they pay. */
const RELIABILITY = {
  consumer: [0.62, 0.16],
  prosumer: [0.7, 0.14],
  smb: [0.72, 0.13],
  enterprise: [0.78, 0.11],
};

const pad = (n, w = 4) => String(n).padStart(w, '0');

export function generateDataset({
  seed = Number(process.env.SEED) || 20260829,
  customerCount = 60,
  failureCount = 80,
  b2bFailureCount = 15,
  now = Date.now(),
} = {}) {
  const rand = makeRandom(seed);

  const customers = [];
  const subscriptions = [];
  const invoices = [];
  const paymentAttempts = [];

  // -- Customers ------------------------------------------------------------
  const segmentPool = [];
  for (const [segment, count] of SEGMENT_MIX) {
    for (let i = 0; i < count; i++) segmentPool.push(segment);
  }
  while (segmentPool.length < customerCount) segmentPool.push('consumer');
  const segments = rand.shuffle(segmentPool).slice(0, customerCount);

  segments.forEach((segment, i) => {
    const id = `cust_${pad(i + 1)}`;
    const isCompany = segment === 'enterprise';
    const person = `${rand.pick(FIRST_NAMES)} ${rand.pick(LAST_NAMES)}`;
    const name = isCompany
      ? `${rand.pick(COMPANY_PREFIX)} ${rand.pick(COMPANY_SUFFIX)} ${rand.pick(COMPANY_TYPE)}`
      : person;

    const [mean, sd] = RELIABILITY[segment];
    const reliability = Number(rand.normal(mean, sd, 0.18, 0.98).toFixed(3));

    const ltvBase = { consumer: 4200, prosumer: 22000, smb: 145000, enterprise: 1850000 }[segment];

    customers.push({
      id,
      name,
      segment,
      phone: `+9198${rand.int(10000000, 99999999)}`,
      email: isCompany
        ? `ap@${name.split(' ')[0].toLowerCase()}${rand.int(10, 99)}.co.in`
        : `${person.split(' ')[0].toLowerCase()}.${person.split(' ')[1].toLowerCase()}${rand.int(1, 99)}@example.com`,
      reliability_score: reliability,
      lifetime_value_inr: Math.round(ltvBase * rand.float(0.5, 2.1)),
      timezone: 'Asia/Kolkata',
      // Salary-credit day drives insufficient_funds retry timing. Companies have none.
      salary_day: isCompany ? null : rand.weighted([[1, 40], [2, 15], [5, 20], [7, 10], [10, 10], [28, 5]]),
      preferred_channel: isCompany
        ? 'email'
        : rand.weighted([['whatsapp', 55], ['sms', 30], ['email', 15]]),
      opted_out_at: null,
      disputed_at: null,
      created_at: iso(now - rand.int(60, 900) * DAY),
    });
  });

  // -- Subscriptions (non-enterprise) --------------------------------------
  let subN = 0;
  for (const c of customers) {
    if (c.segment === 'enterprise') continue;
    const howMany = rand.bool(0.45) ? 2 : 1;
    for (let k = 0; k < howMany; k++) {
      const plan = rand.pick(PLANS[c.segment]);
      const frequency = rand.weighted([['monthly', 78], ['quarterly', 14], ['annual', 8]]);
      const multiplier = { monthly: 1, quarterly: 2.7, annual: 9.5 }[frequency];
      subscriptions.push({
        id: `sub_${pad(++subN)}`,
        customer_id: c.id,
        plan_name: plan.name,
        amount_inr: Math.round((rand.int(plan.min, plan.max) * multiplier) / 10) * 10,
        frequency,
        status: 'active',
        mandate_type: rand.weighted([['upi_autopay', 52], ['card', 36], ['enach', 12]]),
        started_at: iso(now - rand.int(30, 800) * DAY),
        next_billing_at: iso(now + rand.int(1, 30) * DAY),
      });
    }
  }

  // -- B2B invoices (enterprise) -------------------------------------------
  let invN = 0;
  for (const c of customers) {
    if (c.segment !== 'enterprise') continue;
    const howMany = rand.int(2, 4);
    for (let k = 0; k < howMany; k++) {
      const issued = now - rand.int(35, 120) * DAY;
      const termDays = rand.weighted([[30, 55], [45, 25], [60, 20]]);
      invoices.push({
        id: `inv_${pad(++invN)}`,
        customer_id: c.id,
        invoice_number: `RZP/2026/${pad(4200 + invN, 4)}`,
        amount_inr: Math.round(rand.int(45000, 850000) / 500) * 500,
        issued_at: iso(issued),
        due_at: iso(issued + termDays * DAY),
        status: 'open',
        po_number: rand.bool(0.7) ? `PO-${rand.int(100000, 999999)}` : null,
        _item: rand.pick(INVOICE_ITEMS),
      });
    }
  }

  // -- Failed payment attempts ---------------------------------------------
  // Unreliable customers fail more often, so weight subscription selection by
  // (1 - reliability). Sampled without replacement to keep cases distinct.
  const byCustomer = new Map(customers.map((c) => [c.id, c]));
  const subFailureCount = failureCount - b2bFailureCount;

  const subPool = subscriptions.map((s) => ({
    sub: s,
    weight: 0.25 + (1 - byCustomer.get(s.customer_id).reliability_score),
  }));

  const chosenSubs = [];
  for (let i = 0; i < subFailureCount && subPool.length > 0; i++) {
    const total = subPool.reduce((sum, e) => sum + e.weight, 0);
    let roll = rand.next() * total;
    let idx = subPool.length - 1;
    for (let j = 0; j < subPool.length; j++) {
      roll -= subPool[j].weight;
      if (roll <= 0) { idx = j; break; }
    }
    chosenSubs.push(subPool.splice(idx, 1)[0].sub);
  }

  let attemptN = 0;
  for (const sub of chosenSubs) {
    const customer = byCustomer.get(sub.customer_id);
    const code = pickDeclineCode(rand, customer);
    const meta = DECLINE_CODES[code];
    const isCheckout = code === 'abandoned_checkout';
    const failedAt = failureTimestamp(rand, now);

    if (isCheckout) sub.status = 'pending';
    else sub.status = 'past_due';

    paymentAttempts.push({
      id: `pay_${pad(++attemptN)}`,
      customer_id: customer.id,
      subscription_id: sub.id,
      invoice_id: null,
      amount_inr: sub.amount_inr,
      status: 'failed',
      decline_code: code,
      gateway_message: rand.pick(meta.gatewayMessages),
      // Gateways usually take one or two swings on their own before we take over.
      attempt_number: isCheckout ? 1 : rand.weighted([[1, 65], [2, 30], [3, 5]]),
      channel: isCheckout ? 'checkout' : 'autopay',
      created_at: iso(failedAt),
      _caseType: isCheckout ? 'checkout' : 'subscription',
    });
  }

  // Overdue B2B invoices — weight by how far past due they already are.
  const overdue = rand
    .shuffle(invoices.filter((i) => new Date(i.due_at).getTime() < now))
    .slice(0, b2bFailureCount);

  for (const inv of overdue) {
    inv.status = 'overdue';
    const daysOverdue = Math.floor((now - new Date(inv.due_at).getTime()) / DAY);
    paymentAttempts.push({
      id: `pay_${pad(++attemptN)}`,
      customer_id: inv.customer_id,
      subscription_id: null,
      invoice_id: inv.id,
      amount_inr: inv.amount_inr,
      status: 'failed',
      decline_code: 'invoice_overdue',
      gateway_message: `Invoice ${inv.invoice_number} is ${daysOverdue} days past due — no payment received`,
      attempt_number: 1,
      channel: 'invoice_link',
      // AP flags an overdue invoice during working hours, a day or three after the due date.
      created_at: iso(atIstClock(rand, new Date(inv.due_at).getTime() + Math.min(daysOverdue, 3) * DAY, [
        [10, 12], [11, 14], [12, 10], [14, 12], [15, 14], [16, 12], [17, 10], [18, 8], [19, 5],
      ])),
      _caseType: 'b2b_invoice',
    });
  }

  // -- Pre-existing hard stops ---------------------------------------------
  // A handful of customers already opted out or raised a dispute *before* these
  // failures. The engine must stop those cases on sight — that is the
  // compliance rule the dashboard shows off.
  const withFailures = rand.shuffle([...new Set(paymentAttempts.map((a) => a.customer_id))]);
  for (const id of withFailures.slice(0, 3)) {
    byCustomer.get(id).opted_out_at = iso(now - rand.int(20, 90) * DAY);
  }
  for (const id of withFailures.slice(3, 5)) {
    byCustomer.get(id).disputed_at = iso(now - rand.int(10, 60) * DAY);
  }

  for (const inv of invoices) delete inv._item;

  return { seed, generatedAt: iso(now), customers, subscriptions, invoices, paymentAttempts };
}

/**
 * Decline codes are not independent of the customer. A chronically unreliable
 * consumer bounces for insufficient funds; a reliable enterprise buyer does not.
 */
function pickDeclineCode(rand, customer) {
  const weights = DECLINE_WEIGHTS.map(([code, w]) => {
    let weight = w;
    if (code === 'insufficient_funds') {
      weight *= 0.5 + (1 - customer.reliability_score) * 1.8;
      if (customer.segment === 'smb') weight *= 0.7;
    }
    if (code === 'expired_card' || code === 'invalid_cvv') {
      weight *= customer.reliability_score > 0.75 ? 1.4 : 0.9;
    }
    if (code === 'abandoned_checkout' && customer.segment === 'smb') weight *= 0.5;
    return [code, weight];
  });
  return rand.weighted(weights);
}

/**
 * Autopay debits cluster on billing days and business hours, but a meaningful
 * slice lands late at night — which is exactly what makes the quiet-hours rule
 * worth enforcing.
 */
function failureTimestamp(rand, now) {
  const daysAgo = rand.weighted([[1, 10], [2, 12], [3, 12], [5, 14], [7, 14], [10, 12], [14, 12], [18, 8], [21, 6]]);
  const hour = rand.weighted([
    [9, 8], [10, 10], [11, 10], [12, 8], [13, 7], [14, 9], [15, 9],
    [16, 8], [17, 8], [18, 7], [19, 6], [20, 5],
    [21, 5], [22, 4], [23, 3], [2, 3], [4, 3], [6, 4], [7, 5],
  ]);
  return atIstClock(rand, now - daysAgo * DAY, null, hour);
}

/**
 * Place an instant at a given IST hour on the same IST day. Computed against a
 * fixed +05:30 offset rather than the host clock, so seeded data is identical
 * on any machine.
 */
function atIstClock(rand, baseMs, hourWeights, fixedHour = null) {
  const hour = fixedHour ?? rand.weighted(hourWeights);
  const p = toIstParts(baseMs);
  return istToUtcMs(p.year, p.month, p.day, hour, rand.int(0, 59), rand.int(0, 59));
}

/** Console-friendly rollup used by the seed script. */
export function summarize(dataset) {
  const { customers, subscriptions, invoices, paymentAttempts } = dataset;
  const byCode = {};
  const byType = {};
  let atRisk = 0;
  for (const a of paymentAttempts) {
    byCode[a.decline_code] = (byCode[a.decline_code] || 0) + 1;
    byType[a._caseType] = (byType[a._caseType] || 0) + 1;
    atRisk += a.amount_inr;
  }
  return {
    customers: customers.length,
    subscriptions: subscriptions.length,
    invoices: invoices.length,
    failures: paymentAttempts.length,
    atRiskInr: atRisk,
    byCode,
    byType,
    optedOut: customers.filter((c) => c.opted_out_at).length,
    disputed: customers.filter((c) => c.disputed_at).length,
  };
}
