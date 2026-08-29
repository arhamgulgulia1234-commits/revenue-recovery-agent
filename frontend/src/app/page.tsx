import {
  api, inr, inrCompact, istDateTime,
  DECLINE_LABELS, ROOT_CAUSE_LABELS, CLOSURE_LABELS, STATUS_DISPLAY, SEGMENT_LABELS,
  type CaseStatus, type Insights, type AttentionCase,
} from '@/lib/api';
import { RateBars, ScoreBadge } from '@/components/RateBars';
import { ClickableRow } from '@/components/ClickableRow';
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
  try {
    [stats, { failures }, insights, { cases: attention }] = await Promise.all([
      api<Stats>('/api/portfolio/stats'),
      api<{ failures: Failure[] }>('/api/portfolio/failures?limit=100'),
      api<Insights>('/api/insights'),
      api<{ cases: AttentionCase[] }>('/api/insights/needs-attention?limit=8'),
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
        <h1 className="text-xl font-semibold tracking-tight">Recovery performance</h1>
        <p className="text-sm text-muted mt-1">
          {hasRun
            ? `${rec.cases} cases run through the agent — detected, diagnosed, actioned and closed.`
            : 'No engine run yet. Run `npm run simulate` to process the failure book.'}
        </p>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-5">
          <Metric
            label="Revenue at risk"
            value={inrCompact(stats.totals.at_risk_inr)}
            sub={`${stats.totals.failed_attempts} failed payments`}
          />
          <Metric
            label="Revenue recovered"
            value={inrCompact(rec.recovered_inr)}
            sub={`${rec.n_recovered} of ${rec.cases} cases`}
            accent="positive"
          />
          <Metric
            label="Recovery rate"
            value={hasRun ? `${(caseRate * 100).toFixed(1)}%` : '—'}
            sub={hasRun ? `${(valueRate * 100).toFixed(1)}% by value` : 'of cases'}
          />
          <Metric
            label="Avg days to recovery"
            value={rec.avg_days_to_recovery != null ? String(rec.avg_days_to_recovery) : '—'}
            sub="failure to payment"
          />
        </div>

        {hasRun && (
          <div className="mt-3 grid grid-cols-3 gap-3">
            <Split label="Recovered" n={rec.n_recovered} total={rec.cases} tone="bg-emerald-500" />
            <Split label="Still retrying" n={rec.n_retrying} total={rec.cases} tone="bg-amber-500" />
            <Split label="Stopped" n={rec.n_stopped} total={rec.cases} tone="bg-stone-500" />
          </div>
        )}
      </section>

      {hasRun && attention.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold">
            Needs attention
            <span className="font-normal text-muted"> — a human should probably step in</span>
          </h2>
          <p className="text-xs text-muted mt-1 mb-3">
            Unrecovered cases ranked by expected loss (amount at risk × chance we lose it).
            Includes cases the agent stopped at the attempt cap — that hand-off is the point
            of the cap. Opted-out and disputed customers are excluded, because a human may
            not contact them either.
          </p>
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-muted text-left bg-card border-b border-border">
                  <th className="py-2 px-3 font-medium">Case</th>
                  <th className="py-2 px-3 font-medium">Customer</th>
                  <th className="py-2 px-3 font-medium text-right">At risk</th>
                  <th className="py-2 px-3 font-medium text-center">Likelihood</th>
                  <th className="py-2 px-3 font-medium text-right">Expected loss</th>
                  <th className="py-2 px-3 font-medium">Why it is here</th>
                </tr>
              </thead>
              <tbody>
                {attention.map((c) => (
                  <ClickableRow
                    key={c.id}
                    href={`/cases/${c.id}`}
                    className="border-b border-border/60 last:border-0 align-top hover:bg-card/70 transition-colors"
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
          <h2 className="text-sm font-semibold">Patterns behind the score</h2>
          <p className="text-xs text-muted mt-1 mb-4">
            Recovery rates counted off {insights.sampleSize} actionable cases
            ({insights.excluded} excluded — the agent was never allowed to act on them).
            Rates are smoothed toward the {(insights.globalRate * 100).toFixed(0)}% global
            average with {insights.smoothing} pseudo-observations, so a small bucket cannot
            swing a score. The blend is {insights.weights.rootCause} root cause ·{' '}
            {insights.weights.attempt} attempts · {insights.weights.segment} segment.
          </p>
          <div className="grid md:grid-cols-3 gap-8 rounded-lg border border-border bg-card p-5">
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
            <h2 className="text-sm font-semibold mb-3">Outcome by root cause</h2>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-muted text-left border-b border-border">
                  <th className="py-2 font-medium">Root cause</th>
                  <th className="py-2 font-medium text-right">Cases</th>
                  <th className="py-2 font-medium text-right">Recovered</th>
                  <th className="py-2 font-medium text-right">Rate</th>
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
            <h2 className="text-sm font-semibold mb-3">
              Why the agent stopped
              <span className="font-normal text-muted"> — every stop carries a logged reason</span>
            </h2>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-muted text-left border-b border-border">
                  <th className="py-2 font-medium">Reason</th>
                  <th className="py-2 font-medium text-right">Cases</th>
                  <th className="py-2 font-medium text-right">Left on table</th>
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
        <h2 className="text-sm font-semibold mb-3">
          Failure feed <span className="font-normal text-muted">({failures.length})</span>
        </h2>
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-muted text-left bg-card border-b border-border">
                <th className="py-2 px-3 font-medium">Customer</th>
                <th className="py-2 px-3 font-medium">Item</th>
                <th className="py-2 px-3 font-medium">Decline</th>
                <th className="py-2 px-3 font-medium">Diagnosis</th>
                <th className="py-2 px-3 font-medium text-right">Amount</th>
                <th className="py-2 px-3 font-medium text-center">Likelihood</th>
                <th className="py-2 px-3 font-medium">Status</th>
                <th className="py-2 px-3 font-medium">Failed at (IST)</th>
              </tr>
            </thead>
            <tbody>
              {failures.map((f) => (
                <ClickableRow
                  key={f.id}
                  href={f.case_id ? `/cases/${f.case_id}` : '#'}
                  className="border-b border-border/60 last:border-0 hover:bg-card/70 transition-colors"
                >
                  <td className="py-2 px-3">
                    {f.case_id ? (
                      <Link href={`/cases/${f.case_id}`} className="font-medium hover:underline">
                        {f.customer_name}
                      </Link>
                    ) : (
                      <span className="font-medium">{f.customer_name}</span>
                    )}
                    {(f.opted_out_at || f.disputed_at) && (
                      <span className="ml-2 text-[10px] uppercase tracking-wide rounded px-1.5 py-0.5 bg-red-500/10 text-red-500">
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
      </section>
    </div>
  );
}

function StatusBadge({ status }: { status: CaseStatus | null }) {
  if (!status) return <span className="text-muted text-xs">not processed</span>;
  const d = STATUS_DISPLAY[status];
  return (
    <span className={`text-xs rounded px-2 py-0.5 font-medium ${d.className}`}>{d.label}</span>
  );
}

function Metric({
  label, value, sub, accent,
}: { label: string; value: string; sub: string; accent?: 'positive' }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="text-xs text-muted">{label}</div>
      <div
        className={`text-2xl font-semibold tracking-tight mt-1 tabular-nums ${
          accent === 'positive' ? 'text-emerald-600 dark:text-emerald-400' : ''
        }`}
      >
        {value}
      </div>
      <div className="text-xs text-muted mt-1">{sub}</div>
    </div>
  );
}

function Split({ label, n, total, tone }: { label: string; n: number; total: number; tone: string }) {
  return (
    <div className="rounded-lg border border-border bg-card px-4 py-3">
      <div className="flex items-baseline justify-between">
        <span className="text-xs text-muted">{label}</span>
        <span className="text-sm font-semibold tabular-nums">{n}</span>
      </div>
      <div className="mt-2 h-1.5 rounded-full bg-border overflow-hidden">
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${(n / total) * 100}%` }} />
      </div>
    </div>
  );
}

function Offline() {
  return (
    <div className="rounded-lg border border-border bg-card p-6">
      <h1 className="font-semibold">Backend not reachable</h1>
      <p className="text-sm text-muted mt-2">Start it and run the agent:</p>
      <pre className="mt-3 text-xs bg-background border border-border rounded p-3 overflow-x-auto">
{`npm run demo   # reset + seed + simulate + verify
npm run dev    # backend :4000 + frontend :3000`}
      </pre>
    </div>
  );
}
