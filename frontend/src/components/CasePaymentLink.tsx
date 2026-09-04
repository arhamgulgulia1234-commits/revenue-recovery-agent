'use client';

import { useState } from 'react';
import { inr, istDateTime } from '@/lib/api';
import { checkPaymentStatus, LINK_STATUS_TONE, type PaymentStatusResult } from '@/lib/liveCase';

/**
 * The Razorpay link on a case, and the button that asks what happened to it.
 *
 * A client island on an otherwise server-rendered page. It exists because the
 * link was previously visible here only as text inside the message the agent
 * wrote — readable, but not actionable, and with no way to settle the case from
 * the page that shows it. A case you can open is a case you should be able to
 * check.
 *
 * The refresh after a successful check is deliberate and blunt: the surrounding
 * page is a server component holding the old status, closure reason and
 * timeline, and re-rendering it is the only honest way to show a case that has
 * just closed.
 */
export function CasePaymentLink({
  caseId, url, linkId, status, paidAt, paymentId, recoveredInr,
}: {
  caseId: string;
  url: string | null;
  linkId: string;
  status: string | null;
  paidAt: string | null;
  paymentId: string | null;
  recoveredInr: number;
}) {
  const [check, setCheck] = useState<PaymentStatusResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const shown = check?.status ?? status;
  const tone = shown ? (LINK_STATUS_TONE[shown] ?? 'neutral') : 'neutral';
  const settledAt = check?.payment?.paidAt ?? paidAt;
  const settledId = check?.payment?.id ?? paymentId;

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const r = await checkPaymentStatus(caseId);
      setCheck(r);
      // The page around this was rendered on the server with the old status.
      if (r.caseClosedNow) setTimeout(() => window.location.reload(), 1200);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-lg border border-brand/35 bg-card p-5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2.5 flex-wrap">
          <h2 className="text-sm font-semibold">Razorpay payment link</h2>
          <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-brand/15 text-brand">
            Live · test mode
          </span>
          {shown && (
            <span
              className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                tone === 'good' ? 'bg-recovered/10 text-recovered'
                  : tone === 'bad' ? 'bg-alert/10 text-alert'
                  : 'bg-pending/10 text-pending'
              }`}
            >
              {shown}
            </span>
          )}
        </div>
        <span className="font-mono text-xs text-muted">{linkId}</span>
      </div>

      {url && (
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="block mt-3 font-mono text-sm text-comms underline break-all hover:opacity-80"
        >
          {url}
        </a>
      )}

      <div className="mt-4 flex items-center gap-3 flex-wrap">
        <button
          type="button"
          onClick={run}
          disabled={busy}
          className="rounded-md bg-brand text-on-brand text-sm font-medium px-4 py-2 disabled:opacity-40 disabled:cursor-not-allowed hover:opacity-90 transition-opacity"
        >
          {busy ? 'Asking Razorpay…' : 'Check payment status'}
        </button>
        {check && <span className="text-xs text-muted">checked {check.checkedAtLabel}</span>}
      </div>

      {error && <p className="text-xs text-alert mt-3 leading-relaxed">{error}</p>}
      {check && <p className="text-sm text-muted mt-3 leading-relaxed">{check.note}</p>}

      {settledAt && (
        <dl className="mt-3 grid sm:grid-cols-2 gap-x-6 gap-y-2 text-xs">
          <Row label="Payment id" value={settledId} mono />
          <Row label="Method" value={check?.payment?.method ?? null} />
          <Row label="Amount received" value={recoveredInr ? inr(recoveredInr) : null} />
          <Row label="Paid at (Razorpay's clock)" value={istDateTime(settledAt)} />
        </dl>
      )}

      {check?.caseClosedNow && (
        <p className="mt-3 rounded-md bg-recovered/10 text-recovered text-xs px-3 py-2 leading-relaxed">
          Payment confirmed — the case closed as recovered at Razorpay&apos;s timestamp. Reloading…
        </p>
      )}
    </section>
  );
}

function Row({ label, value, mono = false }: { label: string; value: string | null; mono?: boolean }) {
  if (!value) return null;
  return (
    <div className="flex gap-2 min-w-0">
      <dt className="text-muted shrink-0">{label}</dt>
      <dd className={`truncate ${mono ? 'font-mono' : ''}`} title={value}>{value}</dd>
    </div>
  );
}
