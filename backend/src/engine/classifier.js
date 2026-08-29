/**
 * Root-cause classification.
 *
 * Deliberately rule-based, not an LLM call. A decision that leads to debiting
 * someone's account has to be reproducible and explainable without re-running a
 * model — so the mapping is a lookup table, and the LLM only narrates it.
 */

/** Decline code → root-cause bucket. */
export const BUCKET_BY_CODE = {
  insufficient_funds: 'timing_issue',
  expired_card: 'instrument_issue',
  do_not_honor: 'bank_side_block',
  card_declined: 'bank_side_block',
  technical_error: 'transient',
  gateway_timeout: 'transient',
  invalid_cvv: 'user_input_error',
  authentication_failed: 'user_input_error',
  abandoned_checkout: 'drop_off',
  invoice_overdue: 'receivable',
};

export const BUCKETS = {
  timing_issue: {
    label: 'Timing issue',
    // The money isn't there *yet*. Nothing is broken; we picked the wrong day.
    summary: 'the account was short of funds at the moment of debit',
    fixableByCustomer: false,
    needsContact: false,
  },
  instrument_issue: {
    label: 'Instrument issue',
    summary: 'the saved payment instrument is no longer usable',
    fixableByCustomer: true,
    needsContact: true,
  },
  bank_side_block: {
    label: 'Bank-side block',
    summary: 'the issuing bank refused the transaction without giving a reason',
    fixableByCustomer: true,
    needsContact: true,
  },
  transient: {
    label: 'Transient',
    summary: 'a temporary fault on the payment rails, not the customer',
    fixableByCustomer: false,
    needsContact: false,
  },
  user_input_error: {
    label: 'User input error',
    summary: 'the customer mis-entered or failed to complete authentication',
    fixableByCustomer: true,
    needsContact: true,
  },
  drop_off: {
    label: 'Drop-off',
    summary: 'the customer left checkout before submitting payment',
    fixableByCustomer: true,
    needsContact: true,
  },
  receivable: {
    label: 'Receivable',
    summary: 'a B2B invoice is past its due date with no payment received',
    fixableByCustomer: true,
    needsContact: true,
  },
};

/**
 * Classify a failed payment attempt.
 * Confidence reflects how much the decline code actually tells us: an
 * `insufficient_funds` code is unambiguous, `do_not_honor` is the issuer
 * declining to say why.
 */
export function classify(attempt) {
  const bucket = BUCKET_BY_CODE[attempt.decline_code];
  if (!bucket) {
    return { bucket: 'transient', confidence: 0.3, unknownCode: attempt.decline_code };
  }
  const confidence = {
    insufficient_funds: 0.95,
    expired_card: 0.98,
    do_not_honor: 0.55, // issuer gives no reason — this is a guess by construction
    card_declined: 0.6,
    technical_error: 0.85,
    gateway_timeout: 0.9,
    invalid_cvv: 0.95,
    authentication_failed: 0.88,
    abandoned_checkout: 0.92,
    invoice_overdue: 0.99,
  }[attempt.decline_code];

  return { bucket, confidence, ...BUCKETS[bucket] };
}
