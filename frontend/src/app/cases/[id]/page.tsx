import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  api, inr, istDateTime, DECLINE_LABELS, ROOT_CAUSE_LABELS, CLOSURE_LABELS,
  STATUS_DISPLAY, SEGMENT_LABELS, type CaseStatus,
} from '@/lib/api';
import { Timeline } from '@/components/Timeline';
import type { CaseDetail } from '@/lib/types';

export const dynamic = 'force-dynamic';

export default async function CasePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let data: CaseDetail;
  try {
    data = await api<CaseDetail>(`/api/cases/${id}`);
  } catch {
    notFound();
  }

  const c = data.case;
  const status = STATUS_DISPLAY[c.status as CaseStatus];
  const stopped = c.status === 'stopped';
  const hardStop = c.closure_reason?.includes('opted_out') || c.closure_reason?.includes('disputed');

  return (
    <div className="space-y-8">
      <Link href="/" className="text-sm text-muted hover:text-foreground inline-flex items-center gap-1">
        ← All cases
      </Link>

      {/* ---- Header: who, how much, where it stands ---- */}
      <header className="rounded-lg border border-border bg-card p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2.5 flex-wrap">
              <h1 className="text-lg font-semibold tracking-tight">{c.customer_name}</h1>
              <span className={`text-xs rounded px-2 py-0.5 font-medium ${status.className}`}>
                {status.label}
              </span>
              {(c.opted_out_at || c.disputed_at) && (
                <span className="text-[10px] uppercase tracking-wide rounded px-1.5 py-0.5 bg-red-500/10 text-red-500 font-medium">
                  {c.disputed_at ? 'disputed' : 'opted out'}
                </span>
              )}
            </div>
            <p className="text-sm text-muted mt-1">
              {SEGMENT_LABELS[c.segment] ?? c.segment} · {c.plan_name ?? c.invoice_number} ·{' '}
              <span className="font-mono text-xs">{c.id}</span>
            </p>
          </div>

          <div className="flex gap-8">
            <Stat label="Amount at risk" value={inr(c.amount_at_risk_inr)} />
            <Stat
              label="Recovery likelihood"
              value={`${Math.round(c.recovery_score * 100)}%`}
              hint={c.score_band}
            />
            <Stat label="Attempts used" value={`${c.attempts_used} of 3`} />
          </div>
        </div>

        <p className="text-xs text-muted mt-4 pt-4 border-t border-border leading-relaxed">
          {c.score_explanation}
        </p>
      </header>

      {/* ---- The story ---- */}
      <section>
        <h2 className="text-sm font-semibold mb-5">Decision timeline</h2>
        <Timeline events={data.timeline} caseRow={c} />
      </section>

      {/* ---- Final status, stated deliberately ---- */}
      <section
        className={`rounded-lg border p-5 ${
          stopped
            ? hardStop
              ? 'border-red-500/40 bg-red-500/[0.06]'
              : 'border-amber-500/40 bg-amber-500/[0.06]'
            : c.status === 'recovered'
              ? 'border-emerald-500/40 bg-emerald-500/[0.06]'
              : 'border-border bg-card'
        }`}
      >
        <div className="flex items-start gap-3">
          <span className="text-lg leading-none mt-0.5">
            {c.status === 'recovered' ? '✓' : stopped ? '■' : '⋯'}
          </span>
          <div>
            <h3 className="font-semibold text-sm">
              {c.status === 'recovered' && `Recovered — ${inr(c.recovered_amount_inr)}`}
              {stopped && `Stopped by policy — ${CLOSURE_LABELS[c.closure_reason ?? ''] ?? c.closure_reason}`}
              {(c.status === 'in_progress' || c.status === 'promise_to_pay') && 'Still retrying'}
            </h3>
            <p className="text-sm text-muted mt-1.5 leading-relaxed max-w-3xl">
              {stopped ? stopCopy(c.closure_reason) : c.status === 'recovered'
                ? `Closed ${istDateTime(c.closed_at!)} after ${c.attempts_used} intervention${c.attempts_used === 1 ? '' : 's'}.`
                : `The next intervention is scheduled and has not come due yet. ${c.attempts_used} of 3 attempts used.`}
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}

/** Stopping is a decision the agent made, not a failure it suffered. Say so. */
function stopCopy(reason: string | null): string {
  switch (reason) {
    case 'max_attempts_reached':
      return 'The agent reached its 3-attempt cap and stopped. The cap exists so it cannot pressure a customer indefinitely — the case is handed to a human rather than retried a fourth time.';
    case 'customer_opted_out':
      return 'This customer opted out of contact before the failure occurred. The agent took no action at all: no retry, no message. The opt-out is permanent and covers the customer, not just this case.';
    case 'customer_disputed':
      return 'This customer had an open dispute. Any further debit or collection message would be improper while a dispute stands, so the agent stopped and handed the case to a human.';
    case 'opted_out_mid_recovery':
      return 'The customer opted out in response to an intervention. Contact ended immediately and permanently, on this case and every future one.';
    case 'disputed_mid_recovery':
      return 'The customer raised a dispute in response to an intervention. All collection activity ended immediately.';
    case 'sequence_exhausted':
      return 'Every intervention this root cause supports has been tried without recovery.';
    default:
      return 'The agent stopped and logged its reason.';
  }
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div>
      <div className="text-xs text-muted">{label}</div>
      <div className="text-lg font-semibold tabular-nums mt-0.5">{value}</div>
      {hint && <div className="text-xs text-muted">{hint}</div>}
    </div>
  );
}
