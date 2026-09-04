/**
 * Razorpay Payment Links, test mode.
 *
 * Written against `fetch` rather than the Razorpay SDK: the whole client is two
 * JSON calls, so the request on the wire is visible in this file instead of
 * three layers down in a vendor library, and it is one fewer dependency to
 * install on a demo machine. Everything configurable comes from the
 * environment; the key secret is never logged and never serialised.
 *
 * ## Why only test keys
 *
 * A live key here would mint links that take real money from real people, on a
 * path whose entire purpose is rehearsal. There is no benign reading of that, so
 * `rzp_live_` is refused outright rather than warned about — see `keyMode`.
 *
 * ## The two calls
 *
 *   POST /v1/payment_links      mint a link for one case's amount
 *   GET  /v1/payment_links/:id  ask what has happened to it since
 *
 * Razorpay is the authority on both the status and the moment of payment. This
 * module never infers either: `paidAt` comes off the payment Razorpay reports,
 * not off our own clock when we happened to ask.
 */

/**
 * Overridable so the success path can be exercised against a local stub without
 * minting anything on Razorpay's side.
 */
const API_ROOT = () => process.env.RAZORPAY_API_ROOT || 'https://api.razorpay.com/v1';

/** Read fresh each call so a .env edit does not need a restart to take effect. */
const config = () => ({
  keyId: (process.env.RAZORPAY_KEY_ID || '').trim(),
  keySecret: (process.env.RAZORPAY_KEY_SECRET || '').trim(),
});

export class RazorpayError extends Error {
  constructor(message, { status = null, code = null, retriable = false } = {}) {
    super(message);
    this.name = 'RazorpayError';
    this.status = status;
    this.code = code;
    this.retriable = retriable;
  }
}

/** Which required settings are missing, if any. */
export function missingConfig() {
  const c = config();
  const missing = [];
  if (!c.keyId) missing.push('RAZORPAY_KEY_ID');
  if (!c.keySecret) missing.push('RAZORPAY_KEY_SECRET');
  return missing;
}

/** 'test' | 'live' | null — read off the key id, which carries its own mode. */
export function keyMode() {
  const { keyId } = config();
  if (keyId.startsWith('rzp_test_')) return 'test';
  if (keyId.startsWith('rzp_live_')) return 'live';
  return null;
}

/**
 * Configured *and* safe to use. A live key counts as not configured on purpose:
 * every caller already has a "no links, carry on" path, and routing a live key
 * down it is the correct outcome rather than an error someone might dismiss.
 */
export const isConfigured = () => missingConfig().length === 0 && keyMode() === 'test';

/** Safe to serialise anywhere, including to the browser. The secret never appears. */
export function configSummary() {
  const { keyId } = config();
  const missing = missingConfig();
  const mode = keyMode();
  return {
    configured: isConfigured(),
    missing,
    mode,
    keyId: keyId ? `${keyId.slice(0, 12)}…${keyId.slice(-4)}` : null,
    refusal: mode === 'live'
      ? 'RAZORPAY_KEY_ID is a live key (rzp_live_…). This build mints links in test mode only — '
        + 'a live key would take real money on a rehearsal path. Swap in the test key from '
        + 'Dashboard → Account & Settings → API Keys, with the Test Mode toggle on.'
      : null,
  };
}

const auth = () => {
  const { keyId, keySecret } = config();
  return `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`;
};

/**
 * One request, with the timeout and error translation every call needs.
 *
 * Razorpay has no server-side timeout that helps here; without this an unhealthy
 * connection would hold a request handler open indefinitely.
 */
async function call(method, path, { body = null, timeoutMs = 15000 } = {}) {
  const missing = missingConfig();
  if (missing.length) {
    throw new RazorpayError(
      `Razorpay is not configured — set ${missing.join(', ')} in .env`,
      { code: 'not_configured' });
  }
  if (keyMode() !== 'test') {
    throw new RazorpayError(configSummary().refusal ?? 'RAZORPAY_KEY_ID is not a test key.',
      { code: 'not_test_mode' });
  }

  let res;
  try {
    res = await fetch(`${API_ROOT()}${path}`, {
      method,
      headers: {
        // Built here rather than put in a URL so the secret cannot end up in a
        // redirect or a log line.
        Authorization: auth(),
        'Content-Type': 'application/json',
      },
      body: body == null ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    // Network-level failure: worth another go later.
    throw new RazorpayError(
      err.name === 'TimeoutError'
        ? `Razorpay did not respond within ${timeoutMs / 1000}s`
        : `Could not reach Razorpay: ${err.message}`,
      { code: 'network', retriable: true });
  }

  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new RazorpayError(describeError(res.status, payload), {
      status: res.status,
      code: payload?.error?.code ?? null,
      // 429 is rate limiting and 5xx is Razorpay's own trouble; both pass.
      // A 4xx is a bad request and will fail identically forever.
      retriable: res.status === 429 || res.status >= 500,
    });
  }
  return payload;
}

/** Turn Razorpay's error envelope into something actionable. */
function describeError(status, payload) {
  const err = payload?.error;
  const base = err?.description || `Razorpay returned HTTP ${status}`;
  const field = err?.field ? ` (field "${err.field}")` : '';

  if (status === 401) {
    return `${base}${field} — Razorpay rejected the credentials. Check RAZORPAY_KEY_ID and `
         + 'RAZORPAY_KEY_SECRET, and that both come from the same Test Mode key pair.';
  }
  if (err?.code === 'BAD_REQUEST_ERROR') return `${base}${field}`;
  return err?.code ? `${base}${field} (${err.code})` : `${base}${field}`;
}

// ---------------------------------------------------------------------------
// Payment links
// ---------------------------------------------------------------------------

/** Rupees to paise. Razorpay counts in the smallest unit, always. */
const paise = (inr) => Math.round(Number(inr) * 100);

/**
 * Mint a payment link for one case.
 *
 * Razorpay's own SMS and email notifications are switched off deliberately. The
 * whole point of this system is that the recovery agent decides what to say, on
 * which channel, at which hour, under quiet-hours and opt-out rules — a second
 * uncontrolled message from the gateway would sit outside every one of those
 * gates. For the same reason `reminder_enable` is off: Razorpay must not chase
 * a customer the agent has decided to stop chasing.
 *
 * @returns {Promise<{id:string,shortUrl:string,status:string,referenceId:string,
 *                    amountInr:number,createdAt:string,expiresAt:string|null}>}
 */
export async function createPaymentLink({
  amountInr,
  description,
  customer = {},
  referenceId,
  notes = {},
  /**
   * 0 — no expiry — by default, and that is the considered choice rather than
   * laziness. A recovery case legitimately runs for weeks: the matrix schedules
   * a third invoice reminder on day 30, and the copy quoting this link is
   * written when that attempt is *scheduled*. A 24-hour link would be dead
   * before the message it appears in ever goes out, and the failure mode is the
   * worst kind — a link that looks fine and cannot be paid. A real deployment
   * should set this to outlive the case (45 days, say), not to a day.
   */
  expiryHours = Number(process.env.RAZORPAY_LINK_EXPIRY_HOURS ?? 0),
}) {
  const body = {
    amount: paise(amountInr),
    currency: 'INR',
    accept_partial: false,
    // Razorpay caps this at 2048, and truncating here beats a 400 on stage.
    description: String(description ?? '').slice(0, 2048),
    reference_id: referenceId,
    notify: { sms: false, email: false },
    reminder_enable: false,
    notes,
  };

  /**
   * Razorpay refuses `customer: {}` outright — "faulty key: customer" — so the
   * key is attached only when there is something to put in it. Every field is
   * optional on its own; the phone in particular is, since nothing here messages
   * anybody and it exists only to prefill the checkout.
   */
  const who = {};
  if (customer.name) who.name = customer.name;
  if (customer.email) who.email = customer.email;
  if (customer.phone) who.contact = customer.phone;
  if (Object.keys(who).length) body.customer = who;

  // Razorpay requires at least 15 minutes in the future; 0 means "no expiry".
  if (expiryHours > 0) {
    body.expire_by = Math.floor(Date.now() / 1000) + Math.max(900, Math.round(expiryHours * 3600));
  }
  const callbackUrl = process.env.RAZORPAY_CALLBACK_URL;
  if (callbackUrl) {
    body.callback_url = callbackUrl;
    body.callback_method = 'get';
  }

  return shape(await call('POST', '/payment_links', { body }));
}

/** Ask Razorpay what has happened to a link since it was minted. */
export async function fetchPaymentLink(id) {
  if (!id) throw new RazorpayError('No payment link id to look up.', { code: 'no_link' });
  return shape(await call('GET', `/payment_links/${encodeURIComponent(id)}`));
}

/**
 * Razorpay's payload, reduced to what a case actually records.
 *
 * `paidAt` is the moment Razorpay captured the money, read off the payment it
 * reports — not the moment we asked. Someone can pay at 14:02 and the status be
 * checked at 16:40; the case has to close at 14:02 or the audit trail is fiction.
 */
function shape(p) {
  const payments = Array.isArray(p.payments) ? p.payments : [];
  // 'captured' is money actually taken. An 'authorized' payment is a hold that
  // may still fall through, and must not close a case as recovered.
  const captured = payments.filter((x) => x.status === 'captured');
  const settled = captured.length ? captured[captured.length - 1] : null;

  return {
    id: p.id,
    shortUrl: p.short_url ?? null,
    status: p.status ?? null,
    referenceId: p.reference_id ?? null,
    amountInr: p.amount == null ? null : p.amount / 100,
    amountPaidInr: p.amount_paid == null ? null : p.amount_paid / 100,
    createdAt: p.created_at ? new Date(p.created_at * 1000).toISOString() : null,
    expiresAt: p.expire_by ? new Date(p.expire_by * 1000).toISOString() : null,
    payment: settled
      ? {
        id: settled.payment_id ?? null,
        method: settled.method ?? null,
        amountInr: settled.amount == null ? null : settled.amount / 100,
        // Razorpay stamps this in Unix seconds, UTC.
        paidAt: settled.created_at ? new Date(settled.created_at * 1000).toISOString() : null,
      }
      : null,
    raw: { status: p.status, amount_paid: p.amount_paid },
  };
}

/**
 * The instruments Razorpay accepts on a test key.
 *
 * Kept here beside the client rather than in a README, so the API can hand them
 * to whoever is about to rehearse the flow and they cannot drift out of date
 * relative to the integration that needs them. Verified against Razorpay's own
 * docs (see `docs` below) — these are Razorpay's numbers, which are *not* the
 * Stripe-style test cards people tend to reach for from memory.
 */
export const TEST_INSTRUMENTS = {
  upi: {
    success: 'success@razorpay',
    failure: 'failure@razorpay',
    note: 'Choose UPI on the checkout and type this into the UPI ID box. It settles instantly — '
        + 'no phone, no UPI app, no second device — which makes it the fastest path for a live '
        + 'demo. One caveat from Razorpay: in test mode, cancelling a UPI payment still comes '
        + 'back as a success, so use failure@razorpay to rehearse the unhappy path.',
  },
  cards: {
    success: [
      { network: 'Visa', number: '4100 2800 0000 1007' },
      { network: 'Mastercard', number: '5555 5100 0008 1006' },
      { network: 'RuPay', number: '6527 6589 0000 1005' },
    ],
    failure: [
      { network: 'Visa', number: '4100 2800 0009 0000' },
      { network: 'Mastercard', number: '5305 6200 0006 0000' },
    ],
    rules: 'Any random CVV, and any expiry date in the future. On the OTP page that follows, '
         + 'any OTP of 4 to 10 digits authorises the payment; fewer than 4 digits declines it.',
  },
  docs: 'https://razorpay.com/docs/payments/payments/test-card-details/',
};
