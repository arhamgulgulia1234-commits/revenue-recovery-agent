'use client';

import { useState } from 'react';
import { inr, istDateTime, ROOT_CAUSE_LABELS, STATUS_DISPLAY, type CaseStatus } from '@/lib/api';
import {
  checkPaymentStatus, LINK_STATUS_TONE,
  type LiveCaseResult, type PaymentStatusResult,
} from '@/lib/liveCase';
import { CHANNEL_LABELS } from '@/lib/live';

/**
 * A real case, with a real Razorpay link on it.
 *
 * The counterpart to LiveStages: that panel narrates a throwaway run stage by
 * stage, this one shows a case that exists. The difference worth making visible
 * is that nothing here is modelled — the link is live on Razorpay's side, and
 * the only thing that can close the case is Razorpay saying the money arrived.
 */
export function RealLinkCase({ result }: { result: LiveCaseResult }) {
  const [check, setCheck] = useState<PaymentStatusResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The check is the fresher truth once it has run; before that, the case as opened.
  const status = (check?.case.status ?? result.status) as CaseStatus;
  const link = result.paymentLink;
  const badge = STATUS_DISPLAY[status] ?? STATUS_DISPLAY.open;

  async function runCheck() {
    setChecking(true);
    setError(null);
    try {
      setCheck(await checkPaymentStatus(result.caseId));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="space-y-4 animate-reveal">
      {/* ---- The case ---- */}
      <section className="rounded-lg border border-border bg-card p-5">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <div className="flex items-center gap-2.5">
              <h2 className="font-mono text-sm">{result.caseId}</h2>
              <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${badge.className}`}>
                {badge.label}
              </span>
              <span className="text-xs px-2 py-0.5 rounded-full bg-comms/10 text-comms font-medium">
                Real case · on the book
              </span>
            </div>
            <p className="text-sm text-muted mt-1.5">
              {ROOT_CAUSE_LABELS[result.rootCause] ?? result.rootCause} ·{' '}
              opened {istDateTime(result.openedAt)}
            </p>
          </div>
          <div className="text-right">
            <div className="text-2xl font-semibold tabular-nums">{inr(result.amountInr)}</div>
            <div className="text-xs text-muted mt-0.5">
              {status === 'recovered' ? 'recovered' : 'at risk'}
            </div>
          </div>
        </div>

        <p className="text-xs text-muted mt-4 pt-3 border-t border-border leading-relaxed">
          {result.timing.note}
          {result.timing.expedited && result.timing.matrixWouldHaveSent && (
            <> The matrix had scheduled it for {result.timing.matrixWouldHaveSent.atLabel}
              {' '}({result.timing.matrixWouldHaveSent.delayHours}h out); the override is on the
              audit trail.</>
          )}
        </p>
      </section>

      {/* ---- The link ---- */}
      {link.present ? (
        <section className="rounded-lg border border-border bg-card p-5">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <h3 className="text-sm font-semibold">Razorpay payment link</h3>
            <span className="text-xs text-muted font-mono">test mode</span>
          </div>

          <div className="mt-3 flex gap-2 flex-wrap items-center">
            <a
              href={link.url ?? '#'}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-sm text-comms underline underline-offset-2 break-all hover:opacity-80"
            >
              {link.url}
            </a>
            <CopyButton value={link.url ?? ''} />
          </div>

          <dl className="mt-4 grid sm:grid-cols-2 gap-x-6 gap-y-2 text-xs">
            <Row label="Link id" value={link.id} mono />
            <Row label="Reference" value={link.reference ?? null} mono />
          </dl>

          {/* ---- Ask Razorpay ---- */}
          <div className="mt-4 pt-4 border-t border-border">
            <div className="flex items-center gap-3 flex-wrap">
              <button
                type="button"
                onClick={runCheck}
                disabled={checking}
                className="rounded-md bg-accent text-white text-sm font-medium px-4 py-2 disabled:opacity-40 disabled:cursor-not-allowed hover:opacity-90 transition-opacity"
              >
                {checking ? 'Asking Razorpay…' : 'Check payment status'}
              </button>
              {check && <StatusPill status={check.status} label={check.statusLabel} />}
              {check && (
                <span className="text-xs text-muted">checked {check.checkedAtLabel}</span>
              )}
            </div>

            {error && (
              <p className="text-xs text-alert mt-3 leading-relaxed">{error}</p>
            )}

            {check && (
              <div className="mt-3 text-sm">
                <p className="text-muted leading-relaxed">{check.note}</p>
                {check.payment && (
                  <dl className="mt-3 grid sm:grid-cols-2 gap-x-6 gap-y-2 text-xs">
                    <Row label="Payment id" value={check.payment.id} mono />
                    <Row label="Method" value={check.payment.method} />
                    <Row
                      label="Amount received"
                      value={check.payment.amountInr == null ? null : inr(check.payment.amountInr)}
                    />
                    <Row
                      label="Paid at (Razorpay's clock)"
                      value={check.payment.paidAt ? istDateTime(check.payment.paidAt) : null}
                    />
                  </dl>
                )}
                {check.caseClosedNow && (
                  <p className="mt-3 rounded-md bg-recovered/10 text-recovered text-xs px-3 py-2 leading-relaxed">
                    Case closed as recovered at Razorpay&apos;s payment timestamp, not at the moment
                    it was checked. An audit entry reads &ldquo;Payment confirmed via Razorpay —
                    case closed.&rdquo;
                  </p>
                )}
              </div>
            )}
          </div>
        </section>
      ) : (
        <section className="rounded-lg border border-dashed border-border p-5">
          <h3 className="text-sm font-semibold">No Razorpay link on this case</h3>
          <p className="text-sm text-muted mt-2 leading-relaxed">
            {link.error
              ? <>Razorpay is configured but the call failed: <span className="text-alert">{link.error}</span>{' '}
                The case opened anyway, on the synthetic link text — a payment-link problem does not
                get to block a recovery case.</>
              : <>The agent&apos;s first action here is one that carries no payment link
                {link.skipped ? <> — {link.skipped}</> : null}. Nothing was minted, which is correct:
                a link nobody is sent is a link nobody pays.</>}
          </p>
        </section>
      )}

      {/* ---- What went out ---- */}
      <section className="rounded-lg border border-border bg-card p-5">
        <h3 className="text-sm font-semibold">Timeline</h3>
        <ol className="mt-4 space-y-4">
          {result.interventions.map((iv) => (
            <li key={iv.sequence} className="border-l-2 border-border pl-4 relative">
              <span className="absolute -left-[5px] top-1.5 h-2 w-2 rounded-full bg-border" />
              <div className="flex items-center gap-2 flex-wrap text-xs">
                <span className="font-medium text-foreground">Attempt {iv.sequence}</span>
                <span className="text-muted">
                  {CHANNEL_LABELS[iv.channel] ?? iv.channel}
                  {iv.tone ? ` · ${iv.tone}` : ''}
                </span>
              </div>

              {iv.message_sent && (
                <pre className="mt-2 text-sm whitespace-pre-wrap font-sans bg-background border border-border rounded-md p-3 leading-relaxed">
                  {iv.message_sent}
                </pre>
              )}

              <p className="text-xs text-muted mt-2 leading-relaxed">
                {iv.executed_at
                  ? `Written ${istDateTime(iv.executed_at)}`
                  : `Scheduled for ${istDateTime(iv.scheduled_for)}`}
                {iv.outcome_detail && <> · {iv.outcome_detail}</>}
              </p>
            </li>
          ))}
        </ol>

        <p className="text-xs text-muted mt-4 pt-3 border-t border-border leading-relaxed">
          The channel is the agent&apos;s decision, not a delivery receipt — this build has no
          messaging provider and transmits nothing. What a customer actually acts on is the
          Razorpay link above.
        </p>
      </section>
    </div>
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

function StatusPill({ status, label }: { status: string; label: string }) {
  const tone = LINK_STATUS_TONE[status] ?? 'neutral';
  return (
    <span
      className={`text-xs px-2 py-0.5 rounded-full font-medium ${
        tone === 'good' ? 'bg-recovered/10 text-recovered'
          : tone === 'bad' ? 'bg-alert/10 text-alert'
          : 'bg-pending/10 text-pending'
      }`}
    >
      {label}
    </span>
  );
}

/** Copying the URL matters more than it looks — the demo phone is a second device. */
function CopyButton({ value }: { value: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard?.writeText(value).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1600);
        }).catch(() => {});
      }}
      className="text-xs px-2 py-1 rounded border border-border text-muted hover:text-foreground hover:border-accent/60 transition-colors shrink-0"
    >
      {done ? 'Copied' : 'Copy'}
    </button>
  );
}
