'use client';

import { inr, DECLINE_LABELS, SEGMENT_LABELS } from '@/lib/api';
import {
  CHANNEL_LABELS, NOTE_LABELS, OUTCOME_DISPLAY, STOP_COPY,
  type LiveEvent, type MetaEvent, type ScoreFactor,
} from '@/lib/live';

/**
 * The reveal.
 *
 * Everything is rendered from the events as they land — nothing is held back
 * and shown at the end — so the rail grows downward while the run is still
 * going. The visual grammar deliberately matches the case timeline: same rail,
 * same circles, so a live run and a batch case read as the same thing, because
 * they are.
 */

const STAGE_META: Record<string, { n: number; title: string; icon: string; ring: string; text: string }> = {
  diagnose: { n: 1, title: 'Root cause', icon: '◈', ring: 'border-violet-500/50 bg-violet-500/10', text: 'text-violet-500' },
  score:    { n: 2, title: 'Recovery likelihood', icon: '◎', ring: 'border-indigo-500/50 bg-indigo-500/10', text: 'text-indigo-500' },
  decide:   { n: 3, title: 'Recovery action', icon: '→', ring: 'border-sky-500/50 bg-sky-500/10', text: 'text-sky-500' },
  respond:  { n: 4, title: 'Response', icon: '✎', ring: 'border-fuchsia-500/50 bg-fuchsia-500/10', text: 'text-fuchsia-500' },
  outcome:  { n: 5, title: 'Outcome', icon: '·', ring: 'border-border bg-card', text: 'text-muted' },
};

/** Where the text came from. The whole design rests on this being visible. */
const SOURCE_BADGE = {
  rules:     { label: 'Rules engine', className: 'bg-sky-500/10 text-sky-600 dark:text-sky-400' },
  llm:       { label: 'Written by the model', className: 'bg-fuchsia-500/10 text-fuchsia-600 dark:text-fuchsia-400' },
  simulated: { label: 'Simulated outcome', className: 'bg-stone-500/10 text-stone-600 dark:text-stone-400' },
} as const;

export function LiveStages({
  meta, events, working, error,
}: {
  meta: MetaEvent | null;
  events: LiveEvent[];
  working: { stage: string; label: string } | null;
  error: string | null;
}) {
  return (
    <div className="space-y-5">
      {meta && <FailureCard meta={meta} />}

      <ol className="relative">
        {events.map((e, i) => (
          <Row key={i} event={e} last={i === events.length - 1 && !working} />
        ))}
        {working && <WorkingRow stage={working.stage} label={working.label} />}
      </ol>

      {error && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/[0.06] p-4">
          <h3 className="text-sm font-semibold text-red-500">The run did not finish</h3>
          <p className="text-sm text-muted mt-1">{error}</p>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The failure being fed in
// ---------------------------------------------------------------------------

function FailureCard({ meta }: { meta: MetaEvent }) {
  const c = meta.customer;
  const f = meta.failure;
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-base font-semibold tracking-tight">{c.name}</h2>
            <span className="text-xs text-muted">{SEGMENT_LABELS[c.segment] ?? c.segment}</span>
            {c.existing && (
              <span className="text-[10px] uppercase tracking-wide rounded px-1.5 py-0.5 bg-sky-500/10 text-sky-500 font-medium">
                from our data
              </span>
            )}
            {(c.opted_out_at || c.disputed_at) && (
              <span className="text-[10px] uppercase tracking-wide rounded px-1.5 py-0.5 bg-red-500/10 text-red-500 font-medium">
                {c.disputed_at ? 'disputed' : 'opted out'}
              </span>
            )}
          </div>
          <p className="text-sm mt-1.5">
            <span className="font-medium">{inr(f.amountInr)}</span>
            <span className="text-muted"> · {f.item} · </span>
            {DECLINE_LABELS[f.declineCode] ?? f.declineLabel}
          </p>
          <p className="text-xs text-muted mt-1">&ldquo;{f.gatewayMessage}&rdquo;</p>
        </div>
        <dl className="text-xs text-muted space-y-1 shrink-0">
          <Field label="Failed at" value={f.failedAtLabel} />
          <Field label="Reliability" value={c.reliability_score.toFixed(2)} />
          <Field label="Preferred channel" value={CHANNEL_LABELS[c.preferred_channel] ?? c.preferred_channel} />
          {c.salary_day != null && <Field label="Salary lands" value={`day ${c.salary_day}`} />}
        </dl>
      </div>

      <p className="text-xs text-muted mt-3 pt-3 border-t border-border leading-relaxed">
        {meta.detection}{' '}
        {/* Nobody should have to wonder why a "live" failure is dated weeks ago. */}
        The failure is placed {f.backdatedDays} days in the past on purpose: the agent schedules
        real interventions days apart — up to day 30 for an invoice — so a failure stamped
        &ldquo;just now&rdquo; would stop at &ldquo;scheduled, not yet due&rdquo; and never reach
        an outcome.
        {meta.startingAttemptsUsed > 0 && (
          <>
            {' '}This case opens with {meta.startingAttemptsUsed} of {meta.maxAttempts} interventions
            already spent.
          </>
        )}
      </p>
    </div>
  );
}

const Field = ({ label, value }: { label: string; value: string }) => (
  <div className="flex gap-2 justify-between">
    <dt>{label}</dt>
    <dd className="text-foreground tabular-nums">{value}</dd>
  </div>
);

// ---------------------------------------------------------------------------
// The rail
// ---------------------------------------------------------------------------

function Rail({
  stage, last, children, muted = false,
}: { stage: string; last: boolean; children: React.ReactNode; muted?: boolean }) {
  const s = STAGE_META[stage] ?? STAGE_META.outcome;
  return (
    <li className="relative pl-11 pb-7 last:pb-0">
      {!last && <span className="absolute left-[13px] top-7 bottom-0 w-px bg-border" aria-hidden />}
      <span
        className={`absolute left-0 top-0 grid h-[27px] w-[27px] place-items-center rounded-full border text-xs ${
          muted ? 'border-border bg-card text-muted' : `${s.ring} ${s.text}`
        }`}
        aria-hidden
      >
        {s.icon}
      </span>
      {children}
    </li>
  );
}

function Header({
  stage, heading, trailing, source,
}: {
  stage: string; heading: React.ReactNode; trailing?: React.ReactNode;
  source?: keyof typeof SOURCE_BADGE;
}) {
  const s = STAGE_META[stage] ?? STAGE_META.outcome;
  return (
    <div className="flex items-baseline gap-2 flex-wrap">
      <span className="text-[10px] font-mono text-muted">{s.n}</span>
      <h3 className="text-sm font-semibold">{heading}</h3>
      {trailing}
      {source && (
        <span className={`text-[10px] uppercase tracking-wide rounded px-1.5 py-0.5 font-medium ml-auto ${SOURCE_BADGE[source].className}`}>
          {SOURCE_BADGE[source].label}
        </span>
      )}
    </div>
  );
}

const Reason = ({ children }: { children: React.ReactNode }) => (
  <p className="text-sm text-muted mt-2 leading-relaxed">{children}</p>
);

function WorkingRow({ stage, label }: { stage: string; label: string }) {
  return (
    <li className="relative pl-11 pb-0">
      <span
        className="absolute left-0 top-0 grid h-[27px] w-[27px] place-items-center rounded-full border border-border bg-card text-xs text-muted animate-pulse"
        aria-hidden
      >
        {(STAGE_META[stage] ?? STAGE_META.outcome).icon}
      </span>
      <p className="text-sm font-medium text-muted animate-pulse" role="status" aria-live="polite">
        {label}
      </p>
    </li>
  );
}

// ---------------------------------------------------------------------------
// One event
// ---------------------------------------------------------------------------

function Row({ event: e, last }: { event: LiveEvent; last: boolean }) {
  if (e.type === 'stage' && e.stage === 'diagnose') {
    return (
      <Rail stage="diagnose" last={last}>
        <Header
          stage="diagnose"
          heading={e.label}
          trailing={<span className="text-xs text-muted tabular-nums">{Math.round(e.confidence * 100)}% confidence</span>}
          source="rules"
        />
        {e.summary && <p className="text-sm mt-1">{e.summary}</p>}
        <Reason>{e.reasoning}</Reason>
      </Rail>
    );
  }

  if (e.type === 'stage' && e.stage === 'score') {
    const bandClass = e.band === 'High'
      ? 'text-emerald-600 dark:text-emerald-400'
      : e.band === 'Medium' ? 'text-amber-600 dark:text-amber-400' : 'text-rose-600 dark:text-rose-400';
    return (
      <Rail stage="score" last={last}>
        <Header
          stage="score"
          heading={
            <span className="flex items-baseline gap-2">
              <span className={`text-lg font-semibold tabular-nums ${bandClass}`}>
                {Math.round(e.score * 100)}%
              </span>
              <span className="text-muted font-normal">{e.band}</span>
            </span>
          }
          source="rules"
        />
        <Reason>{e.explanation}</Reason>
        {e.isOverride ? (
          <p className="text-xs text-muted mt-2 leading-relaxed">
            This is an override, not arithmetic — a barred customer scores zero because the agent
            may not act, not because the money is unrecoverable.
          </p>
        ) : (
          <ScoreWorking factors={e.factors} />
        )}
      </Rail>
    );
  }

  if (e.type === 'stage' && e.stage === 'decide') {
    return (
      <Rail stage="decide" last={last}>
        <Header
          stage="decide"
          heading={
            <>
              <span className="text-muted font-normal">
                Attempt {e.attemptNumber} of {e.maxAttempts} —{' '}
              </span>
              {e.actionLabel}
            </>
          }
          source="rules"
        />
        <p className="text-xs text-muted mt-1">
          {e.silent
            ? 'No message — the customer is never contacted'
            : `${CHANNEL_LABELS[e.channel ?? ''] ?? e.channel} · ${e.tone} tone`}
          {e.scheduledForLabel && ` · scheduled ${e.scheduledForLabel}`}
        </p>
        <Reason>{e.reasoning}</Reason>
        {e.deferral && (
          <div className="mt-3 rounded-lg border border-amber-500/40 bg-amber-500/[0.06] px-3 py-2">
            <p className="text-xs font-semibold text-amber-600 dark:text-amber-400">Held — quiet hours</p>
            <p className="text-sm text-muted mt-1 leading-relaxed">{e.deferral.reasoning}</p>
          </div>
        )}
      </Rail>
    );
  }

  if (e.type === 'stage' && e.stage === 'respond') {
    const model = e.narrator.model.split('/').pop() ?? e.narrator.model;
    return (
      <Rail stage="respond" last={last}>
        <Header
          stage="respond"
          heading="Response drafted"
          trailing={
            <span
              title={`${e.narrator.provider} · ${e.narrator.model}`}
              className={`text-[10px] uppercase tracking-wide rounded px-1.5 py-0.5 font-medium ${
                e.reasoningSource === 'llm'
                  ? 'bg-fuchsia-500/10 text-fuchsia-500'
                  : 'bg-stone-500/10 text-stone-500'
              }`}
            >
              {e.reasoningSource === 'llm' ? model : 'template fallback'}
            </span>
          }
          source="llm"
        />
        {e.narrator.note && (
          <p className="text-xs text-amber-600 dark:text-amber-400 mt-1.5">{e.narrator.note}</p>
        )}
        <Reason>{e.reasoning}</Reason>

        {e.silent ? (
          <p className="text-xs text-muted mt-3">
            Nothing was sent. A silent retry notifies nobody, so there is no copy to write — the
            model only explained the decision.
          </p>
        ) : e.message ? (
          <div className="mt-3 rounded-lg border border-border bg-card overflow-hidden">
            <div className="px-3 py-1.5 border-b border-border text-[11px] uppercase tracking-wide text-muted">
              {CHANNEL_LABELS[e.channel ?? ''] ?? e.channel} message, as the customer receives it
            </div>
            <pre className="px-3 py-2.5 text-xs whitespace-pre-wrap font-sans leading-relaxed">
              {e.message}
            </pre>
          </div>
        ) : null}
      </Rail>
    );
  }

  if (e.type === 'stage' && e.stage === 'outcome') {
    const d = OUTCOME_DISPLAY[e.outcome ?? ''] ?? { label: e.outcome ?? 'Outcome', tone: 'neutral' as const };
    const toneClass = d.tone === 'good'
      ? 'text-emerald-600 dark:text-emerald-400'
      : d.tone === 'bad' ? 'text-rose-600 dark:text-rose-400' : 'text-sky-600 dark:text-sky-400';
    return (
      <Rail stage="outcome" last={last} muted>
        <Header
          stage="outcome"
          heading={<span className={toneClass}>{d.label}</span>}
          trailing={e.atLabel ? <span className="text-xs text-muted">{e.atLabel}</span> : undefined}
          source="simulated"
        />
        {e.detail && <p className="text-sm mt-1">{e.detail}</p>}
        <Reason>{e.reasoning}</Reason>
      </Rail>
    );
  }

  if (e.type === 'note') {
    return (
      <Rail stage="outcome" last={last} muted>
        <h3 className="text-sm font-semibold">{NOTE_LABELS[e.event] ?? e.event}</h3>
        <Reason>{e.reasoning}</Reason>
      </Rail>
    );
  }

  if (e.type === 'stopped') return <StoppedRow event={e} last={last} />;
  // The final card always closes the rail, so it never draws a connector.
  if (e.type === 'final') return <FinalRow event={e} />;
  return null;
}

// ---------------------------------------------------------------------------
// The stop — the one thing that must be impossible to miss
// ---------------------------------------------------------------------------

function StoppedRow({
  event: e, last,
}: { event: Extract<LiveEvent, { type: 'stopped' }>; last: boolean }) {
  const hard = e.kind === 'hard_stop';
  return (
    <li className="relative pl-11 pb-7 last:pb-0">
      {!last && <span className="absolute left-[13px] top-7 bottom-0 w-px bg-border" aria-hidden />}
      <span
        className={`absolute left-0 top-0 grid h-[27px] w-[27px] place-items-center rounded-full border text-xs ${
          hard ? 'border-red-500/60 bg-red-500/15 text-red-500' : 'border-amber-500/60 bg-amber-500/15 text-amber-500'
        }`}
        aria-hidden
      >
        ■
      </span>
      <div
        className={`rounded-lg border p-4 ${
          hard ? 'border-red-500/50 bg-red-500/[0.07]' : 'border-amber-500/50 bg-amber-500/[0.07]'
        }`}
      >
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="text-[10px] font-mono text-muted">{e.atStage === 'decide' ? '3' : '—'}</span>
          <h3 className={`text-sm font-semibold ${hard ? 'text-red-500' : 'text-amber-600 dark:text-amber-500'}`}>
            Stopped by policy — {e.label}
          </h3>
          <span
            className={`text-[10px] uppercase tracking-wide rounded px-1.5 py-0.5 font-medium ml-auto ${
              hard ? 'bg-red-500/15 text-red-500' : 'bg-amber-500/15 text-amber-600 dark:text-amber-500'
            }`}
          >
            {hard ? 'Hard stop' : e.kind === 'attempt_cap' ? 'Attempt cap' : 'Sequence exhausted'}
          </span>
        </div>

        <p className="text-sm mt-2 leading-relaxed">{STOP_COPY[e.reason] ?? e.reason}</p>
        {e.reasoning && <Reason>{e.reasoning}</Reason>}

        {e.skipped.length > 0 && (
          <div className="mt-3 pt-3 border-t border-border/60">
            <p className="text-xs font-medium">
              Stages {e.skipped.map((s) => (s === 'respond' ? '4' : '5')).join(' and ')} never ran.
            </p>
            <p className="text-xs text-muted mt-1 leading-relaxed">
              No intervention was chosen, no message was written, no outcome was rolled. The stop is
              checked before the agent is allowed to do anything at all — which is why there is
              nothing below this to show.
            </p>
          </div>
        )}
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Where it ended up
// ---------------------------------------------------------------------------

function FinalRow({ event: e }: { event: Extract<LiveEvent, { type: 'final' }> }) {
  const recovered = e.status === 'recovered';
  const stopped = e.status === 'stopped';
  const hard = e.closureKind === 'hard_stop';

  const tone = recovered
    ? 'border-emerald-500/50 bg-emerald-500/[0.07]'
    : stopped
      ? hard ? 'border-red-500/50 bg-red-500/[0.07]' : 'border-amber-500/50 bg-amber-500/[0.07]'
      : 'border-border bg-card';

  return (
    <li className="relative pl-11 pb-0">
      <span
        className={`absolute left-0 top-0 grid h-[27px] w-[27px] place-items-center rounded-full border text-xs ${
          recovered ? 'border-emerald-500/60 bg-emerald-500/15 text-emerald-500'
            : stopped ? (hard ? 'border-red-500/60 bg-red-500/15 text-red-500' : 'border-amber-500/60 bg-amber-500/15 text-amber-500')
              : 'border-border bg-card text-muted'
        }`}
        aria-hidden
      >
        {recovered ? '✓' : stopped ? '■' : '⋯'}
      </span>

      <div className={`rounded-lg border p-4 ${tone}`}>
        <h3 className="text-sm font-semibold">
          {recovered && `Case closed — recovered ${inr(e.recoveredInr)}`}
          {stopped && `Case closed — stopped, ${inr(e.amountAtRiskInr)} left on the table`}
          {!recovered && !stopped && 'Case still in flight'}
        </h3>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-3 text-xs">
          <Cell label="Final status" value={e.status.replace(/_/g, ' ')} />
          <Cell label="Interventions run" value={`${e.interventionsRun}`} />
          <Cell label="Attempts used" value={`${e.attemptsUsed} of 3`} />
          <Cell label="Closed" value={e.closedAtLabel ?? '—'} />
        </div>

        {e.promises.length > 0 && (
          <p className="text-xs text-muted mt-3">
            Promise to pay captured for {e.promises[0].promisedDateLabel} —{' '}
            {e.promises[0].fulfilled ? 'honoured.' : 'not honoured.'}
          </p>
        )}

        <p className="text-xs text-muted mt-3 pt-3 border-t border-border/60 leading-relaxed">
          The outcome is a draw from the same probability tables the batch uses, seeded with{' '}
          <span className="font-mono">{e.seed}</span>. Run the same inputs again and the dice land
          differently — that is the point, not a bug.
        </p>
      </div>
    </li>
  );
}

const Cell = ({ label, value }: { label: string; value: string }) => (
  <div>
    <div className="text-muted">{label}</div>
    <div className="font-medium capitalize mt-0.5">{value}</div>
  </div>
);

// ---------------------------------------------------------------------------
// The arithmetic behind the score, on demand
// ---------------------------------------------------------------------------

function ScoreWorking({ factors }: { factors: ScoreFactor[] }) {
  const base = factors.filter((f) => f.kind === 'base');
  const mods = factors.filter((f) => f.kind === 'modifier');
  if (!base.length) return null;

  return (
    <details className="mt-3 group">
      <summary className="text-xs text-muted cursor-pointer hover:text-foreground select-none">
        How this number was built
      </summary>
      <ul className="mt-2 space-y-1.5 text-xs">
        {base.map((f) => (
          <li key={f.name} className="flex gap-3 justify-between">
            <span className="text-muted">{f.detail}</span>
            <span className="tabular-nums shrink-0">
              {Math.round((f.weight ?? 0) * 100)}% × {Math.round((f.rate ?? 0) * 100)}%
            </span>
          </li>
        ))}
        {mods.map((f) => (
          <li key={f.name} className="flex gap-3 justify-between border-t border-border/60 pt-1.5">
            <span className="text-muted">Adjusted because {f.detail}</span>
            <span className={`tabular-nums shrink-0 ${(f.delta ?? 0) > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
              {(f.delta ?? 0) > 0 ? '+' : ''}{Math.round((f.delta ?? 0) * 100)} pts
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}
