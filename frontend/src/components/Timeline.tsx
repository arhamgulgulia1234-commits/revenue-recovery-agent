import { inr, istDateTime, DECLINE_LABELS, ROOT_CAUSE_LABELS } from '@/lib/api';
import type { TimelineEvent, CaseDetail } from '@/lib/types';

/**
 * Visual grammar for the timeline. Each event type gets one icon and one
 * colour, used consistently so the shape of a case is readable before any of
 * the text is.
 */
const STYLES: Record<string, { icon: string; ring: string; text: string; title: string }> = {
  case_opened:           { icon: '✕', ring: 'border-rose-500/50 bg-rose-500/10',    text: 'text-rose-500',    title: 'Payment failed' },
  root_cause_classified: { icon: '◈', ring: 'border-violet-500/50 bg-violet-500/10', text: 'text-violet-500',  title: 'Root cause diagnosed' },
  intervention_selected: { icon: '→', ring: 'border-sky-500/50 bg-sky-500/10',      text: 'text-sky-500',     title: 'Intervention' },
  quiet_hours_deferred:  { icon: '◷', ring: 'border-amber-500/50 bg-amber-500/10',  text: 'text-amber-500',   title: 'Held — quiet hours' },
  first_action_expedited:{ icon: '⏵', ring: 'border-amber-500/50 bg-amber-500/10',  text: 'text-amber-500',   title: 'Expedited by operator' },
  response_window_opened:{ icon: '◷', ring: 'border-violet-500/50 bg-violet-500/10', text: 'text-violet-500',  title: 'Awaiting response' },
  message_delivered:     { icon: '✉', ring: 'border-emerald-500/50 bg-emerald-500/10', text: 'text-emerald-500', title: 'WhatsApp delivered' },
  outcome_recorded:      { icon: '·', ring: 'border-border bg-card',                text: 'text-muted',       title: 'Outcome' },
  promise_recorded:      { icon: '◑', ring: 'border-sky-500/50 bg-sky-500/10',      text: 'text-sky-500',     title: 'Promise to pay' },
  promise_kept:          { icon: '✓', ring: 'border-emerald-500/50 bg-emerald-500/10', text: 'text-emerald-500', title: 'Promise honoured' },
  promise_broken:        { icon: '✕', ring: 'border-amber-500/50 bg-amber-500/10',  text: 'text-amber-500',   title: 'Promise broken' },
  case_recovered:        { icon: '✓', ring: 'border-emerald-500/50 bg-emerald-500/10', text: 'text-emerald-500', title: 'Recovered' },
  case_stopped:          { icon: '■', ring: 'border-red-500/50 bg-red-500/10',      text: 'text-red-500',     title: 'Stopped by policy' },
};

const ACTION_LABELS: Record<string, string> = {
  silent_retry: 'Silent auto-retry', timed_retry: 'Timed retry',
  payment_link: 'Payment link', update_card_link: 'Update payment method link',
  alt_method_link: 'Alternate payment method (UPI)', nudge: 'Checkout nudge',
  nudge_with_incentive: 'Checkout nudge + incentive',
  reminder_polite: 'Polite payment reminder', reminder_firm: 'Firm payment reminder',
  escalation_flag: 'Escalated to account manager',
};

export function Timeline({
  events, caseRow, narrator,
}: {
  events: TimelineEvent[];
  caseRow: CaseDetail['case'];
  narrator: CaseDetail['narrator'];
}) {
  // Name the model that actually wrote it — the provider is swappable, so a
  // hardcoded vendor name goes stale the moment someone changes LLM_PROVIDER.
  const modelLabel = narrator.model.split('/').pop() ?? narrator.model;
  return (
    <ol className="relative">
      {events.map((e, i) => {
        const s = STYLES[e.event_type] ?? STYLES.outcome_recorded;
        const last = i === events.length - 1;
        const recovered = e.intervention?.outcome === 'recovered';
        const isOutcome = e.event_type === 'outcome_recorded';

        return (
          <li key={e.id} className="relative pl-11 pb-7 last:pb-0">
            {!last && <span className="absolute left-[13px] top-7 bottom-0 w-px bg-border" aria-hidden />}
            <span
              className={`absolute left-0 top-0 grid h-[27px] w-[27px] place-items-center rounded-full border text-xs ${
                isOutcome && recovered ? STYLES.case_recovered.ring : s.ring
              } ${isOutcome && recovered ? STYLES.case_recovered.text : s.text}`}
              aria-hidden
            >
              {isOutcome ? (recovered ? '✓' : '✕') : s.icon}
            </span>

            <div className="flex items-baseline gap-2 flex-wrap">
              <h3 className="text-sm font-semibold">
                {e.event_type === 'intervention_selected' && e.intervention
                  ? `Attempt ${e.attemptNumber} of 3 — ${ACTION_LABELS[e.intervention.action_type] ?? e.intervention.action_type}`
                  : isOutcome
                    ? outcomeTitle(e.intervention?.outcome)
                    : s.title}
              </h3>
              <time className="text-xs text-muted">{istDateTime(e.created_at)} IST</time>
              {e.reasoning_source === 'llm' && (
                <span
                  title={`Written by ${narrator.provider} · ${narrator.model}`}
                  className="text-[10px] uppercase tracking-wide rounded px-1.5 py-0.5 bg-violet-500/10 text-violet-500 font-medium"
                >
                  {modelLabel}
                </span>
              )}
            </div>

            {/* Hard facts of the failure, only on the opening event */}
            {e.event_type === 'case_opened' && (
              <p className="text-sm mt-1">
                <span className="font-medium">{inr(caseRow.amount_at_risk_inr)}</span>
                {' · '}
                {DECLINE_LABELS[caseRow.decline_code] ?? caseRow.decline_code}
                <span className="text-muted"> · &ldquo;{caseRow.gateway_message}&rdquo;</span>
              </p>
            )}

            {e.event_type === 'root_cause_classified' && (
              <p className="text-sm mt-1">
                <span className="font-medium">{ROOT_CAUSE_LABELS[caseRow.root_cause] ?? caseRow.root_cause}</span>
                <span className="text-muted">
                  {' '}· {Math.round(caseRow.root_cause_confidence * 100)}% confidence
                </span>
              </p>
            )}

            {e.intervention && e.event_type === 'intervention_selected' && (
              <p className="text-xs text-muted mt-1">
                {e.intervention.channel === 'none'
                  ? 'No message — silent retry'
                  : `${e.intervention.channel} · ${e.intervention.tone} tone`}
                {!e.intervention.executed_at && ' · scheduled, not yet due'}
              </p>
            )}

            <p className="text-sm text-muted mt-2 leading-relaxed max-w-3xl">{e.reasoning_text}</p>

            {/* The message exactly as the customer would receive it */}
            {e.event_type === 'intervention_selected' && e.intervention?.message_sent && (
              <div className="mt-3 max-w-3xl rounded-lg border border-border bg-card overflow-hidden">
                <div className="px-3 py-1.5 border-b border-border text-[11px] uppercase tracking-wide text-muted">
                  {e.intervention.channel} message
                </div>
                <pre className="px-3 py-2.5 text-xs whitespace-pre-wrap font-sans leading-relaxed">
                  {e.intervention.message_sent}
                </pre>
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}

function outcomeTitle(outcome: string | null | undefined) {
  switch (outcome) {
    case 'recovered': return 'Payment recovered';
    case 'no_response': return 'No response';
    case 'promise_to_pay': return 'Promise to pay';
    case 'suppressed': return 'Suppressed';
    default: return 'Attempt failed';
  }
}
