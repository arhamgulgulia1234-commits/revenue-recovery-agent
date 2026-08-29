import { inr, inrCompact } from '@/lib/api';

export type ComparisonData = {
  atRiskInr: number;
  caseCount: number;
  engine: Side;
  baseline: Side;
  config: { retryIntervalHours: number; maxAttempts: number; channel: string; honoursHardStops: boolean };
  genericMessage: string;
};

type Side = {
  recoveredCases: number; recoveredInr: number; caseRate: number; valueRate: number;
  totalContacts: number; heavilyContacted: number; contactedAtAll: number;
  avgAttemptsToRecovery: number | null; avgDaysToRecovery: number | null;
};

const n1 = (v: number | null) => (v == null ? '—' : (Math.round(v * 10) / 10).toString());

export function Comparison({ data }: { data: ComparisonData }) {
  const { engine, baseline, config } = data;
  const lift = baseline.caseRate ? engine.caseRate / baseline.caseRate : 0;
  const fewer = baseline.totalContacts - engine.totalContacts;

  const rows: { label: string; a: string; b: string; win: 'engine' | 'baseline' | 'tie'; note?: string }[] = [
    { label: 'Cases recovered', a: `${engine.recoveredCases} of ${data.caseCount}`,
      b: `${baseline.recoveredCases} of ${data.caseCount}`, win: 'engine' },
    { label: 'Revenue recovered', a: inr(engine.recoveredInr), b: inr(baseline.recoveredInr), win: 'engine' },
    { label: 'Recovery rate (by value)', a: `${(engine.valueRate * 100).toFixed(1)}%`,
      b: `${(baseline.valueRate * 100).toFixed(1)}%`, win: 'engine' },
    { label: 'Messages sent to customers', a: String(engine.totalContacts),
      b: String(baseline.totalContacts), win: 'engine', note: 'lower is better' },
    { label: 'Customers contacted at all', a: String(engine.contactedAtAll),
      b: String(baseline.contactedAtAll), win: 'engine', note: 'lower is better' },
    { label: 'Cases with 3+ messages', a: String(engine.heavilyContacted),
      b: String(baseline.heavilyContacted), win: 'engine', note: 'lower is better' },
    { label: 'Avg attempts to recovery', a: n1(engine.avgAttemptsToRecovery),
      b: n1(baseline.avgAttemptsToRecovery), win: 'engine', note: 'lower is better' },
    { label: 'Avg days to recovery', a: n1(engine.avgDaysToRecovery),
      b: n1(baseline.avgDaysToRecovery), win: 'baseline', note: 'lower is better' },
  ];

  return (
    <section>
      <h2 className="text-sm font-semibold">Is the intelligence worth it?</h2>
      <p className="text-sm text-muted mt-2 max-w-4xl leading-relaxed">
        The same {data.caseCount} failures, run twice. Once through the decision engine, and once
        through what most systems actually do — retry blindly every{' '}
        {config.retryIntervalHours} hours, up to {config.maxAttempts} times, sending the same
        generic message to everyone.{' '}
        <strong className="text-foreground">
          Our approach recovered {(engine.caseRate * 100).toFixed(1)}% of cases against{' '}
          {(baseline.caseRate * 100).toFixed(1)}% for the naive baseline — {lift.toFixed(2)}× the
          recovery — while sending {fewer} fewer messages.
        </strong>
      </p>

      <div className="grid sm:grid-cols-3 gap-3 mt-5">
        <Headline label="Recovery rate" a={`${(engine.caseRate * 100).toFixed(1)}%`}
          b={`${(baseline.caseRate * 100).toFixed(1)}%`} tone="emerald" />
        <Headline label="Revenue recovered" a={inrCompact(engine.recoveredInr)}
          b={inrCompact(baseline.recoveredInr)} tone="emerald" />
        <Headline label="Messages sent" a={String(engine.totalContacts)}
          b={String(baseline.totalContacts)} tone="sky" invert />
      </div>

      <div className="overflow-x-auto rounded-lg border border-border mt-4">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-muted text-left bg-card border-b border-border">
              <th className="py-2 px-3 font-medium">Metric</th>
              <th className="py-2 px-3 font-medium text-right">Decision engine</th>
              <th className="py-2 px-3 font-medium text-right">Blind retry baseline</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label} className="border-b border-border/60 last:border-0">
                <td className="py-2 px-3">
                  {r.label}
                  {r.note && <span className="text-xs text-muted"> · {r.note}</span>}
                </td>
                <td className={`py-2 px-3 text-right tabular-nums ${
                  r.win === 'engine' ? 'font-semibold text-emerald-600 dark:text-emerald-400' : ''}`}>
                  {r.a}
                </td>
                <td className={`py-2 px-3 text-right tabular-nums ${
                  r.win === 'baseline' ? 'font-semibold text-amber-600 dark:text-amber-400' : 'text-muted'}`}>
                  {r.b}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* The one metric we lose, stated plainly rather than left out. */}
      <div className="mt-4 rounded-lg border border-amber-500/40 bg-amber-500/[0.06] p-4">
        <h3 className="text-sm font-semibold">Where the baseline wins, and why</h3>
        <p className="text-sm text-muted mt-1.5 leading-relaxed max-w-4xl">
          The baseline recovers faster — {n1(baseline.avgDaysToRecovery)} days against our{' '}
          {n1(engine.avgDaysToRecovery)}. That is not a flaw we are hiding; it is two real effects.
          It retries every {config.retryIntervalHours} hours where we deliberately wait — for a
          salary to land, or for an invoice to reach day 7 of its reminder sequence. And it is
          selection bias: the baseline only ever wins the cases that were going to resolve quickly
          anyway, so its average is measured over an easier set of wins.
        </p>
      </div>

      <details className="mt-4 text-sm">
        <summary className="cursor-pointer text-muted hover:text-foreground">
          How the baseline is kept honest
        </summary>
        <div className="mt-3 text-muted leading-relaxed space-y-2 max-w-4xl">
          <p>
            <strong className="text-foreground">Same machinery.</strong> Engagement rates, attempt
            decay, reliability weighting and amount friction all come from the same outcome model.
            Only the inputs the engine derives from diagnosis are removed.
          </p>
          <p>
            <strong className="text-foreground">Anchored numbers.</strong> Every baseline
            probability is taken from the engine&rsquo;s own table or derived from it. On transient
            failures a blind retry scores exactly what ours does — we claim no credit for winning
            a case anyone would win.
          </p>
          <p>
            <strong className="text-foreground">The baseline is compliant.</strong> It gets the same
            3-attempt cap and honours opt-outs and disputes exactly as we do. This is not a
            strawman that spams customers who asked to be left alone — the comparison is about
            intelligence alone.
          </p>
          <p>
            <strong className="text-foreground">It is flattered, if anything.</strong> Its generic
            message converts at 0.30, the floor of our own tailored-message table. A message that
            never names the problem or the fix would plausibly do worse, which would widen the gap
            rather than narrow it.
          </p>
          <p className="pt-1">
            Baseline message, sent identically to everyone:{' '}
            <span className="italic">&ldquo;{data.genericMessage}&rdquo;</span>
          </p>
        </div>
      </details>
    </section>
  );
}

function Headline({
  label, a, b, tone, invert,
}: { label: string; a: string; b: string; tone: string; invert?: boolean }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="text-xs text-muted">{label}</div>
      <div className="flex items-baseline gap-2 mt-1">
        <span className={`text-2xl font-semibold tabular-nums ${
          tone === 'emerald' ? 'text-emerald-600 dark:text-emerald-400' : 'text-sky-600 dark:text-sky-400'}`}>
          {a}
        </span>
        <span className="text-sm text-muted tabular-nums">vs {b}</span>
      </div>
      <div className="text-xs text-muted mt-1">
        engine vs baseline{invert ? ' · fewer is better' : ''}
      </div>
    </div>
  );
}
