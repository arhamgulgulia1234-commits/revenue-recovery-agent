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
