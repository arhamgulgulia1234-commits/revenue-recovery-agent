/**
 * Shared domain vocabulary: decline codes, root causes, and policy constants.
 * The generator emits these codes; the classifier maps them to root causes;
 * the intervention matrix keys off the root cause. One source of truth.
 */

/** Raw gateway decline codes, as they would arrive on a webhook. */
export const DECLINE_CODES = {
  insufficient_funds: {
    rootCause: 'insufficient_funds',
    label: 'Insufficient funds',
    gatewayMessages: [
      'Insufficient balance in account',
      'Transaction declined — low balance',
      'NACH mandate debit failed: insufficient funds',
    ],
    // Base likelihood the money is recoverable at all, before intervention quality.
    recoverability: 0.62,
    customerFault: true,
  },
  expired_card: {
    rootCause: 'expired_card',
    label: 'Expired card',
    gatewayMessages: ['Card has expired', 'Expired card — please update credentials'],
    recoverability: 0.55,
    customerFault: true,
  },
  do_not_honor: {
    rootCause: 'do_not_honor',
    label: 'Do not honour (issuer block)',
    gatewayMessages: ['Do not honour', 'Issuer declined the transaction'],
    recoverability: 0.4,
    customerFault: false,
  },
  card_declined: {
    rootCause: 'do_not_honor',
    label: 'Card declined by issuer',
    gatewayMessages: ['Card declined by issuing bank', 'Transaction not permitted to cardholder'],
    recoverability: 0.42,
    customerFault: false,
  },
  technical_error: {
    rootCause: 'technical_error',
    label: 'Technical error',
    gatewayMessages: ['Internal processing error', 'Acquirer returned an unexpected response'],
    recoverability: 0.88,
    customerFault: false,
  },
  gateway_timeout: {
    rootCause: 'technical_error',
    label: 'Gateway timeout',
    gatewayMessages: ['Gateway timeout — no response from issuer', 'Upstream request timed out'],
    recoverability: 0.85,
    customerFault: false,
  },
  invalid_cvv: {
    rootCause: 'authentication_failed',
    label: 'Invalid CVV',
    gatewayMessages: ['Invalid CVV', 'Security code mismatch'],
    recoverability: 0.6,
    customerFault: true,
  },
  authentication_failed: {
    rootCause: 'authentication_failed',
    label: 'Authentication failed',
    gatewayMessages: ['3DS authentication failed', 'OTP not entered within time limit'],
    recoverability: 0.58,
    customerFault: true,
  },
  abandoned_checkout: {
    rootCause: 'abandoned_checkout',
    label: 'Abandoned checkout',
    gatewayMessages: ['Customer left the checkout page', 'Payment page closed before submission'],
    recoverability: 0.3,
    customerFault: true,
  },
  invoice_overdue: {
    rootCause: 'invoice_overdue',
    label: 'B2B invoice overdue',
    gatewayMessages: ['Invoice past due date — no payment received'],
    recoverability: 0.65,
    customerFault: true,
  },
};

/** Distinct root causes the intervention matrix is keyed on. */
export const ROOT_CAUSES = [
  'insufficient_funds',
  'expired_card',
  'do_not_honor',
  'technical_error',
  'authentication_failed',
  'abandoned_checkout',
  'invoice_overdue',
];

export const SEGMENTS = ['consumer', 'prosumer', 'smb', 'enterprise'];

/** Compliance policy. Enforced by the engine, surfaced on the dashboard. */
export const POLICY = {
  MAX_ATTEMPTS_PER_CASE: 3,
  QUIET_HOURS: { startHour: 21, endHour: 8 }, // 21:00\u201308:00 local, no outreach
  QUIET_HOURS_LABEL: '9:00 PM \u2013 8:00 AM IST',
  // Hard stops that can never be reversed by the agent.
  PERMANENT_STOP_REASONS: ['customer_opted_out', 'customer_disputed'],

  /**
   * How long the agent waits for the customer to respond to an outreach before
   * it concludes there was no response and decides what to do next.
   *
   * This is the difference between an agent and a loop. Sending three messages
   * in the same instant and declaring failure is not three attempts \u2014 it is one
   * attempt reported three times. A real recovery sequence sends, waits a real
   * number of days, and only then escalates.
   *
   * Silent retries have no window: nobody is being asked to respond, and the
   * gateway answers immediately.
   */
  RESPONSE_WINDOW_DAYS: Number(process.env.RESPONSE_WINDOW_DAYS) || 3,
};

POLICY.RESPONSE_WINDOW_MS = POLICY.RESPONSE_WINDOW_DAYS * 86400000;

/**
 * When a positive response lands inside the window.
 *
 * The window is the deadline, not the expected arrival: someone who pays a
 * WhatsApp link pays soon after reading it, not three days later. A third of the
 * way in is a deliberate, deterministic stand-in for the real timestamp \u2014 which
 * the live path (Stage 4) reads off the payment webhook instead of guessing.
 * Deterministic on purpose: drawing it would consume a random number and shift
 * every downstream outcome in the seeded batch.
 */
POLICY.SIMULATED_RESPONSE_FRACTION = 1 / 3;

export function isQuietHour(hour) {
  const { startHour, endHour } = POLICY.QUIET_HOURS;
  return hour >= startHour || hour < endHour;
}
