import {
  api, inr, istDateTime,
  DECLINE_LABELS, ROOT_CAUSE_LABELS, CLOSURE_LABELS, STATUS_DISPLAY, STATUS_BORDER, SEGMENT_LABELS,
  type CaseStatus, type Insights, type AttentionCase,
} from '@/lib/api';
import { RateBars, ScoreBadge } from '@/components/RateBars';
import { ClickableRow } from '@/components/ClickableRow';
import { Comparison, type ComparisonData } from '@/components/Comparison';
import { CountUp } from '@/components/CountUp';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

type Stats = {
  totals: { failed_attempts: number; at_risk_inr: number; customers_affected: number };
  byDeclineCode: { decline_code: string; n: number; at_risk_inr: number }[];
  bySegment: { segment: string; n: number; at_risk_inr: number }[];
  hardStops: { opted_out: number; disputed: number };
  recovery: {
    cases: number; recovered_inr: number; at_risk_inr: number;
    n_recovered: number; n_retrying: number; n_stopped: number;
    avg_days_to_recovery: number | null;
  };
  stopReasons: { closure_reason: string; n: number; at_risk_inr: number }[];
  byRootCause: {
    root_cause: string; n: number; recovered: number; retrying: number;
    stopped: number; recovered_inr: number;
  }[];
};

type Failure = {
  id: string; customer_name: string; segment: string; decline_code: string;
  amount_inr: number; attempt_number: number; created_at: string;
  plan_name: string | null; invoice_number: string | null;
  opted_out_at: string | null; disputed_at: string | null;
  case_id: string | null; case_status: CaseStatus | null; root_cause: string | null;
  attempts_used: number | null; closure_reason: string | null;
  recovery_score?: number; score_band?: string; score_explanation?: string;
};

export default async function Page() {
  let stats: Stats, failures: Failure[], insights: Insights, attention: AttentionCase[];
  let comparison: ComparisonData;
  try {
    [stats, { failures }, insights, { cases: attention }, comparison] = await Promise.all([
      api<Stats>('/api/portfolio/stats'),
      api<{ failures: Failure[] }>('/api/portfolio/failures?limit=100'),
      api<Insights>('/api/insights'),
      api<{ cases: AttentionCase[] }>('/api/insights/needs-attention?limit=8'),
      api<ComparisonData>('/api/comparison'),
    ]);
  } catch {
    return <Offline />;
  }

  const rec = stats.recovery;
  const hasRun = rec.cases > 0;
  const caseRate = hasRun ? rec.n_recovered / rec.cases : 0;
  const valueRate = hasRun ? rec.recovered_inr / rec.at_risk_inr : 0;

  return (
    <div className="space-y-10">
      <section>
        <div className="flex items-baseline justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Recovery performance</h1>
            <p className="text-sm text-muted mt-1.5 max-w-2xl leading-relaxed">
              {hasRun
                ? `${rec.cases} cases run through the agent — detected, diagnosed, actioned and closed.`
                : 'No engine run yet. Run `npm run simulate` to process the failure book.'}
            </p>
          </div>
        </div>

        {/* The three numbers that matter most, given real size and weight so
            everything else on the page visibly recedes behind them. */}
        <div className="grid sm:grid-cols-3 gap-3.5 mt-6">
          <HeroStat
            label="Revenue at risk"
            value={stats.totals.at_risk_inr}
            sub={`${stats.totals.failed_attempts} failed payments`}
            tone="pending"
          />
          <HeroStat
            label="Recovery rate"
            value={hasRun ? caseRate * 100 : 0}
            variant="percent1"
            sub={hasRun ? `${(valueRate * 100).toFixed(1)}% by value` : 'No cases run yet'}
            tone="brand"
          />
          <HeroStat
            label="Revenue recovered"
            value={rec.recovered_inr}
            sub={`${rec.n_recovered} of ${rec.cases} cases`}
            tone="recovered"
          />
        </div>

        {/* Supporting detail: smaller type, quieter card, one shared legend
            for the three status colors that recur everywhere below. */}
        {hasRun && (
          <div className="grid sm:grid-cols-[1fr_auto] gap-3.5 mt-3.5">
            <div className="rounded-xl border border-border bg-card-2/60 px-4 py-3.5">
              <div className="flex items-center justify-between gap-3 text-xs text-muted mb-2">
                <span>Case outcomes</span>
                <span className="tabular-nums">{rec.cases} total</span>
              </div>
              <div className="flex h-2 rounded-full overflow-hidden bg-border">
                <div
                  className="h-full bg-recovered transition-[width] duration-700 ease-out"
                  style={{ width: `${(rec.n_recovered / rec.cases) * 100}%` }}
                />
                <div
                  className="h-full bg-pending transition-[width] duration-700 ease-out"
                  style={{ width: `${(rec.n_retrying / rec.cases) * 100}%` }}
                />
                <div
                  className="h-full bg-stopped transition-[width] duration-700 ease-out"
                  style={{ width: `${(rec.n_stopped / rec.cases) * 100}%` }}
                />
              </div>
              <div className="flex items-center gap-4 mt-2.5 text-xs flex-wrap">
                <Legend swatch="bg-recovered" label="Recovered" n={rec.n_recovered} />
                <Legend swatch="bg-pending" label="Still retrying" n={rec.n_retrying} />
                <Legend swatch="bg-stopped" label="Stopped" n={rec.n_stopped} />
              </div>
            </div>
            <div className="rounded-xl border border-border bg-card-2/60 px-4 py-3.5 flex flex-col justify-center sm:min-w-[9rem]">
              <div className="text-xs text-muted">Avg days to recovery</div>
              <div className="text-lg font-semibold tabular-nums mt-0.5">
                {rec.avg_days_to_recovery != null ? rec.avg_days_to_recovery : '—'}
              </div>
              <div className="text-xs text-muted mt-0.5">failure to payment</div>
            </div>
          </div>
        )}
      </section>

      {hasRun && <Comparison data={comparison} />}

      {hasRun && attention.length > 0 && (
        <section>
          <h2 className="text-base font-semibold tracking-tight">
            Needs attention
            <span className="font-normal text-muted"> — a human should probably step in</span>
          </h2>
          <p className="text-xs text-muted mt-1 mb-3">
            Unrecovered cases ranked by expected loss (amount at risk × chance we lose it).
            Includes cases the agent stopped at the attempt cap — that hand-off is the point
            of the cap. Opted-out and disputed customers are excluded, because a human may
            not contact them either.
          </p>
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-muted text-left bg-card-2/60 border-b border-border">
                  <th className="py-2 px-3 text-[11px] uppercase tracking-wide font-medium">Case</th>
                  <th className="py-2 px-3 text-[11px] uppercase tracking-wide font-medium">Customer</th>
                  <th className="py-2 px-3 text-[11px] uppercase tracking-wide font-medium text-right">At risk</th>
                  <th className="py-2 px-3 text-[11px] uppercase tracking-wide font-medium text-center">Likelihood</th>
                  <th className="py-2 px-3 text-[11px] uppercase tracking-wide font-medium text-right">Expected loss</th>
                  <th className="py-2 px-3 text-[11px] uppercase tracking-wide font-medium">Why it is here</th>
                </tr>
              </thead>
              <tbody>
                {attention.map((c) => (
                  <ClickableRow
                    key={c.id}
                    href={`/cases/${c.id}`}
                    className="border-b border-border/60 last:border-0 align-top hover:bg-card-2/70 transition-colors"
                  >
                    <td className="py-2 px-3 font-mono text-xs">
                      <Link href={`/cases/${c.id}`} className="text-muted hover:text-foreground hover:underline">
                        {c.id}
                      </Link>
                    </td>
                    <td className="py-2 px-3">
                      <span className="font-medium">{c.customer_name}</span>
                      <span className="block text-xs text-muted">
                        {SEGMENT_LABELS[c.segment] ?? c.segment} ·{' '}
                        {ROOT_CAUSE_LABELS[c.root_cause] ?? c.root_cause}
                      </span>
                    </td>
                    <td className="py-2 px-3 text-right tabular-nums">{inr(c.amount_at_risk_inr)}</td>
                    <td className="py-2 px-3 text-center">
                      <ScoreBadge score={c.recovery_score} band={c.score_band} />
                    </td>
                    <td className="py-2 px-3 text-right tabular-nums font-medium">
                      {inr(c.expectedLoss)}
                    </td>
                    <td className="py-2 px-3 text-xs text-muted max-w-xs">
                      {c.status === 'stopped'
                        ? CLOSURE_LABELS[c.closure_reason ?? ''] ?? c.closure_reason
                        : `Still running, ${c.attempts_used}/3 attempts used`}
                    </td>
                  </ClickableRow>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {hasRun && (
        <section>
          <h2 className="text-base font-semibold tracking-tight">Patterns behind the score</h2>
          <p className="text-xs text-muted mt-1 mb-4">
            Recovery rates counted off {insights.sampleSize} actionable cases
            ({insights.excluded} excluded — the agent was never allowed to act on them).
            Rates are smoothed toward the {(insights.globalRate * 100).toFixed(0)}% global
            average with {insights.smoothing} pseudo-observations, so a small bucket cannot
            swing a score. The blend is {insights.weights.rootCause} root cause ·{' '}
            {insights.weights.attempt} attempts · {insights.weights.segment} segment.
          </p>
          <div className="grid md:grid-cols-3 gap-8 rounded-xl border border-border bg-card p-5">
            <RateBars
              title="By root cause"
              rows={insights.byRootCause.map((r) => ({
                label: ROOT_CAUSE_LABELS[r.key] ?? r.key, rate: r.rate, n: r.n,
              }))}
            />
            <RateBars
              title="By customer segment"
              rows={insights.bySegment.map((r) => ({
                label: SEGMENT_LABELS[r.key] ?? r.key, rate: r.rate, n: r.n,
              }))}
            />
            <RateBars
              title="By attempts already failed"
              note="Each failed try is real evidence the case is hard."
              rows={insights.byAttempt.map((r) => ({
                label: r.failedAttempts === 0
                  ? 'Nothing tried yet'
                  : `${r.failedAttempts} attempt${r.failedAttempts === 1 ? '' : 's'} failed`,
                rate: r.rate, n: r.n,
              }))}
            />
          </div>
        </section>
      )}

      {hasRun && (
        <section className="grid md:grid-cols-2 gap-8">
          <div>
            <h2 className="text-base font-semibold tracking-tight mb-3">Outcome by root cause</h2>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-muted text-left border-b border-border">
                  <th className="py-2 text-[11px] uppercase tracking-wide font-medium">Root cause</th>
                  <th className="py-2 text-[11px] uppercase tracking-wide font-medium text-right">Cases</th>
                  <th className="py-2 text-[11px] uppercase tracking-wide font-medium text-right">Recovered</th>
                  <th className="py-2 text-[11px] uppercase tracking-wide font-medium text-right">Rate</th>
                </tr>
              </thead>
              <tbody>
                {stats.byRootCause.map((r) => (
                  <tr key={r.root_cause} className="border-b border-border/60">
                    <td className="py-2">{ROOT_CAUSE_LABELS[r.root_cause] ?? r.root_cause}</td>
                    <td className="py-2 text-right tabular-nums">{r.n}</td>
                    <td className="py-2 text-right tabular-nums">{r.recovered}</td>
                    <td className="py-2 text-right tabular-nums">
                      {((r.recovered / r.n) * 100).toFixed(0)}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div>
            <h2 className="text-base font-semibold tracking-tight mb-3">
              Why the agent stopped
              <span className="font-normal text-muted"> — every stop carries a logged reason</span>
            </h2>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-muted text-left border-b border-border">
                  <th className="py-2 text-[11px] uppercase tracking-wide font-medium">Reason</th>
                  <th className="py-2 text-[11px] uppercase tracking-wide font-medium text-right">Cases</th>
                  <th className="py-2 text-[11px] uppercase tracking-wide font-medium text-right">Left on table</th>
                </tr>
              </thead>
              <tbody>
                {stats.stopReasons.map((r) => (
                  <tr key={r.closure_reason} className="border-b border-border/60">
                    <td className="py-2">{CLOSURE_LABELS[r.closure_reason] ?? r.closure_reason}</td>
                    <td className="py-2 text-right tabular-nums">{r.n}</td>
                    <td className="py-2 text-right tabular-nums">{inr(r.at_risk_inr)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="text-xs text-muted mt-3">
              Hard stops on file: {stats.hardStops.opted_out} opted out ·{' '}
              {stats.hardStops.disputed} disputed. The agent takes no action on these,
              on this case or any future one.
            </p>
          </div>
        </section>
      )}

      <section>
        <h2 className="text-base font-semibold tracking-tight mb-3">
          Failure feed <span className="font-normal text-muted">({failures.length})</span>
        </h2>
        {failures.length === 0 ? (
          <EmptyState
            title="No failures recorded yet"
            body="Once payments, mandates or invoices start failing, they will show up here as they come in."
          />
        ) : (
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-muted text-left bg-card-2/60 border-b border-border">
                <th className="py-2 px-3 text-[11px] uppercase tracking-wide font-medium">Customer</th>
                <th className="py-2 px-3 text-[11px] uppercase tracking-wide font-medium">Item</th>
                <th className="py-2 px-3 text-[11px] uppercase tracking-wide font-medium">Decline</th>
                <th className="py-2 px-3 text-[11px] uppercase tracking-wide font-medium">Diagnosis</th>
                <th className="py-2 px-3 text-[11px] uppercase tracking-wide font-medium text-right">Amount</th>
                <th className="py-2 px-3 text-[11px] uppercase tracking-wide font-medium text-center">Likelihood</th>
                <th className="py-2 px-3 text-[11px] uppercase tracking-wide font-medium">Status</th>
                <th className="py-2 px-3 text-[11px] uppercase tracking-wide font-medium">Failed at (IST)</th>
              </tr>
            </thead>
            <tbody>
              {failures.map((f) => (
                <ClickableRow
                  key={f.id}
                  href={f.case_id ? `/cases/${f.case_id}` : '#'}
                  className="border-b border-border/60 last:border-0 hover:bg-card-2/70 transition-colors"
                >
                  <td
                    className={`py-2 px-3 border-l-[3px] ${
                      f.case_status ? STATUS_BORDER[f.case_status] : 'border-l-transparent'
                    }`}
                  >
                    {f.case_id ? (
                      <Link href={`/cases/${f.case_id}`} className="font-medium hover:underline">
                        {f.customer_name}
                      </Link>
                    ) : (
                      <span className="font-medium">{f.customer_name}</span>
                    )}
                    {(f.opted_out_at || f.disputed_at) && (
                      <span className="ml-2 text-[10px] uppercase tracking-wide rounded-full px-1.5 py-0.5 bg-alert/10 text-alert font-medium">
                        {f.disputed_at ? 'disputed' : 'opted out'}
                      </span>
                    )}
                    <span className="block text-xs text-muted capitalize">{f.segment}</span>
                  </td>
                  <td className="py-2 px-3 text-muted">{f.plan_name ?? f.invoice_number}</td>
                  <td className="py-2 px-3">{DECLINE_LABELS[f.decline_code] ?? f.decline_code}</td>
                  <td className="py-2 px-3 text-muted">
                    {f.root_cause ? ROOT_CAUSE_LABELS[f.root_cause] : '—'}
                  </td>
                  <td className="py-2 px-3 text-right tabular-nums">{inr(f.amount_inr)}</td>
                  <td className="py-2 px-3 text-center whitespace-nowrap">
                    {f.recovery_score != null && f.score_band ? (
                      <span title={f.score_explanation}>
                        <ScoreBadge score={f.recovery_score} band={f.score_band} />
                      </span>
                    ) : (
                      <span className="text-muted text-xs">—</span>
                    )}
                  </td>
                  <td className="py-2 px-3 whitespace-nowrap">
                    <StatusBadge status={f.case_status} />
                    {f.case_status && (
                      <span className="block text-xs text-muted mt-0.5">
                        {f.case_status === 'stopped' && f.closure_reason
                          ? CLOSURE_LABELS[f.closure_reason] ?? f.closure_reason
                          : `${f.attempts_used ?? 0}/3 attempts`}
                      </span>
                    )}
                  </td>
                  <td className="py-2 px-3 text-muted whitespace-nowrap">
                    {istDateTime(f.created_at)}
                  </td>
                </ClickableRow>
              ))}
            </tbody>
          </table>
        </div>
        )}
      </section>
    </div>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-xl border border-dashed border-border bg-card-2/40 px-6 py-10 text-center">
      <div className="mx-auto grid h-10 w-10 place-items-center rounded-full bg-card border border-border text-muted">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
          <path d="M4 6h16M4 12h16M4 18h10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      </div>
      <h3 className="text-sm font-semibold mt-3">{title}</h3>
      <p className="text-xs text-muted mt-1 max-w-sm mx-auto leading-relaxed">{body}</p>
    </div>
  );
}

function StatusBadge({ status }: { status: CaseStatus | null }) {
  if (!status) return <span className="text-muted text-xs">not processed</span>;
  // Falls back rather than indexing blind: a status the API knows about and this
  // map does not should render plainly, not take the whole dashboard down with
  // `undefined.className`.
  const d = STATUS_DISPLAY[status] ?? {
    label: String(status).replace(/_/g, ' '),
    className: 'bg-stopped/10 text-stopped',
  };
  return (
    <span className={`text-xs rounded px-2 py-0.5 font-medium ${d.className}`}>{d.label}</span>
  );
}

const HERO_TONE = {
  pending: { ring: 'border-t-pending', text: 'text-foreground' },
  brand: { ring: 'border-t-brand', text: 'text-foreground' },
  recovered: { ring: 'border-t-recovered', text: 'text-recovered' },
} as const;

function HeroStat({
  label, value, sub, tone, variant = 'inrCompact',
}: {
  label: string; value: number; sub: string;
  tone: keyof typeof HERO_TONE; variant?: 'inrCompact' | 'percent1';
}) {
  const t = HERO_TONE[tone];
  return (
    <div className={`rounded-xl border border-border border-t-[3px] ${t.ring} bg-card p-5`}>
      <div className="text-xs text-muted font-medium">{label}</div>
      <div className={`text-4xl font-semibold tracking-tight mt-2 ${t.text}`}>
        <CountUp value={value} variant={variant} />
      </div>
      <div className="text-xs text-muted mt-2">{sub}</div>
    </div>
  );
}

function Legend({ swatch, label, n }: { swatch: string; label: string; n: number }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-muted">
      <span className={`h-2 w-2 rounded-full ${swatch}`} aria-hidden />
      {label} <span className="tabular-nums text-foreground font-medium">{n}</span>
    </span>
  );
}

function Offline() {
  return (
    <div className="rounded-xl border border-border bg-card p-6">
      <h1 className="font-semibold">Backend not reachable</h1>
      <p className="text-sm text-muted mt-2">Start it and run the agent:</p>
      <pre className="mt-3 text-xs bg-background border border-border rounded p-3 overflow-x-auto">
{`npm run demo   # reset + seed + simulate + verify
npm run dev    # backend :4000 + frontend :3000`}
      </pre>
    </div>
  );
}
