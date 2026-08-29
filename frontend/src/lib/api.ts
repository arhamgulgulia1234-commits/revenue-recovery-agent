export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export async function api<T>(path: string): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

export const inr = (n: number) => '₹' + Math.round(n).toLocaleString('en-IN');

/** ₹81.9L / ₹1.2Cr — Indian short form, for metric tiles. */
export const inrCompact = (n: number) => {
  if (n >= 1e7) return `₹${(n / 1e7).toFixed(2)}Cr`;
  if (n >= 1e5) return `₹${(n / 1e5).toFixed(1)}L`;
  if (n >= 1e3) return `₹${(n / 1e3).toFixed(1)}K`;
  return '₹' + n;
};

export const DECLINE_LABELS: Record<string, string> = {
  insufficient_funds: 'Insufficient funds',
  expired_card: 'Expired card',
  do_not_honor: 'Do not honour',
  card_declined: 'Card declined',
  technical_error: 'Technical error',
  gateway_timeout: 'Gateway timeout',
  invalid_cvv: 'Invalid CVV',
  authentication_failed: 'Auth failed',
  abandoned_checkout: 'Abandoned checkout',
  invoice_overdue: 'Invoice overdue',
};

export const istDateTime = (iso: string) =>
  new Date(iso).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit', month: 'short',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });

export const ROOT_CAUSE_LABELS: Record<string, string> = {
  timing_issue: 'Timing issue',
  instrument_issue: 'Instrument issue',
  bank_side_block: 'Bank-side block',
  transient: 'Transient',
  user_input_error: 'User input error',
  drop_off: 'Drop-off',
  receivable: 'Receivable',
};

export const CLOSURE_LABELS: Record<string, string> = {
  payment_recovered: 'Payment recovered',
  promise_kept: 'Promise to pay honoured',
  max_attempts_reached: 'Hit the 3-attempt cap',
  customer_opted_out: 'Customer had opted out',
  customer_disputed: 'Customer had disputed',
  opted_out_mid_recovery: 'Opted out mid-recovery',
  disputed_mid_recovery: 'Disputed mid-recovery',
  sequence_exhausted: 'No interventions left',
};

/** The three buckets the dashboard shows. promise_to_pay is still in flight. */
export type CaseStatus = 'recovered' | 'in_progress' | 'promise_to_pay' | 'stopped';

export const STATUS_DISPLAY: Record<CaseStatus, { label: string; className: string }> = {
  recovered:      { label: 'Recovered', className: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' },
  in_progress:    { label: 'Retrying',  className: 'bg-amber-500/10 text-amber-600 dark:text-amber-400' },
  promise_to_pay: { label: 'Promised',  className: 'bg-sky-500/10 text-sky-600 dark:text-sky-400' },
  stopped:        { label: 'Stopped',   className: 'bg-stone-500/10 text-stone-600 dark:text-stone-400' },
};
