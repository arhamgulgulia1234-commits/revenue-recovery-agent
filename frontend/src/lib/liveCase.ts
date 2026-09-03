/**
 * Client for the real path: a persisted case carrying a real Razorpay link.
 *
 * The throwaway simulator in `live.ts` streams stages over SSE because its whole
 * point is watching the engine think. This one is a plain request/response,
 * because its point is the opposite — the case is committed to the book, the
 * link exists on Razorpay's side, and there is a case id afterwards you can come
 * back to and ask about. Nothing here is streamed because nothing here is a
 * performance.
 */

import { API_URL } from './api';

export type LiveSegment = 'consumer' | 'prosumer' | 'smb';

export type LiveCaseInput = {
  customerName: string;
  /** Optional — prefills the contact box on the Razorpay checkout, nothing more. */
  phone?: string;
  segment: LiveSegment;
  amountInr: number;
  declineCode: string;
  sendFirstMessageNow: boolean;
  daysOverdue?: number;
};

/** What Razorpay said, or why there is nothing to say. */
export type PaymentLink = {
  present: boolean;
  /** An innocent reason there is no link — a silent retry, or no key configured. */
  skipped: string | null;
  /** Razorpay was configured and the call failed. This one is worth showing. */
  error: string | null;
  id: string | null;
  url: string | null;
  reference?: string | null;
  status: string | null;
  createdAt?: string | null;
  checkedAt?: string | null;
  paymentId?: string | null;
  paidAt?: string | null;
  paidAtLabel?: string | null;
};

export type LiveIntervention = {
  sequence: number;
  action_type: string;
  /**
   * The channel the agent *chose*. Nothing is transmitted — this build has no
   * messaging provider — so it is a record of the decision, not of a delivery.
   */
  channel: string;
  tone: string | null;
  message_sent: string | null;
  scheduled_for: string;
  executed_at: string | null;
  response_deadline_at: string | null;
  outcome: string | null;
  outcome_detail: string | null;
};

export type LiveCaseResult = {
  caseId: string;
  status: string;
  rootCause: string;
  amountInr: number;
  contactPhone: string;
  openedAt: string;
  paymentLink: PaymentLink;
  timing: {
    realTime: boolean;
    expedited: boolean;
    matrixWouldHaveSent: {
      actionType: string; at: string; atLabel: string; delayHours: number;
    } | null;
    note: string;
  };
  nextActionAt: string | null;
  nextActionAtLabel: string | null;
  responseWindowDays: number;
  interventions: LiveIntervention[];
  closureReason: string | null;
};

export type PaymentStatusResult = {
  caseId: string;
  paymentLinkId: string;
  paymentLinkUrl: string | null;
  status: string;
  statusLabel: string;
  paid: boolean;
  checkedAt: string;
  checkedAtLabel: string;
  amountInr: number | null;
  amountPaidInr: number | null;
  payment: { id: string | null; method: string | null; amountInr: number | null; paidAt: string | null } | null;
  /** True only on the call that actually closed the case, never on a re-check. */
  caseClosedNow: boolean;
  case: {
    id: string; status: string; recovered_amount_inr: number;
    closed_at: string | null; paid_at: string | null; payment_id: string | null;
  };
  note: string;
};

export type RazorpayTestInstruments = {
  upi: { success: string; failure: string; note: string };
  cards: {
    success: { network: string; number: string }[];
    failure: { network: string; number: string }[];
    rules: string;
  };
  docs: string;
};

export type LiveConfig = {
  razorpay: {
    configured: boolean; missing: string[]; mode: 'test' | 'live' | null;
    keyId: string | null; refusal: string | null;
    testInstruments: RazorpayTestInstruments | null;
    setup: { missing: string[]; steps: string[] } | null;
  };
  segments: LiveSegment[];
  responseWindowDays: number;
  declineCodes: {
    code: string; label: string; bucket: string;
    sendsMessageFirst: boolean;
    firstAction: string | null;
    firstActionLabel: string | null;
    /**
     * Whether this case ever quotes a payment link, and on which attempt. Not
     * always the first: an insufficient-funds case opens on a silent retry and
     * escalates to a link on attempt two.
     */
    mintsPaymentLink: boolean;
    paymentLinkAttempt: number | null;
    paymentLinkActionLabel: string | null;
  }[];
};

/** Turn a non-2xx into the message the API actually gave, not just a status code. */
async function fail(res: Response, fallback: string): Promise<never> {
  const body = await res.json().catch(() => null);
  throw new Error(body?.message ?? `${fallback} (${res.status})`);
}

export async function fetchLiveConfig(): Promise<LiveConfig> {
  const res = await fetch(`${API_URL}/api/live/config`, { cache: 'no-store' });
  if (!res.ok) await fail(res, 'Could not load the live configuration');
  return res.json();
}

/** Open a real case, minting its Razorpay payment link. */
export async function openLiveCase(input: LiveCaseInput): Promise<LiveCaseResult> {
  const res = await fetch(`${API_URL}/api/live/cases`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) await fail(res, 'The case could not be opened');
  return res.json();
}

/**
 * Ask Razorpay what has happened to this case's link.
 *
 * Safe to call repeatedly — a paid link closes the case once, and every call
 * after that reports the same settled state without rewriting it.
 */
export async function checkPaymentStatus(caseId: string): Promise<PaymentStatusResult> {
  const res = await fetch(`${API_URL}/api/live/cases/${caseId}/payment-status`, { method: 'POST' });
  if (!res.ok) await fail(res, 'Could not reach Razorpay');
  return res.json();
}

export const LINK_STATUS_TONE: Record<string, 'good' | 'bad' | 'neutral'> = {
  paid: 'good',
  created: 'neutral',
  partially_paid: 'neutral',
  expired: 'bad',
  cancelled: 'bad',
};
