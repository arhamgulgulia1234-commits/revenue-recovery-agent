import {
  api, inr, inrCompact, istDateTime,
  DECLINE_LABELS, ROOT_CAUSE_LABELS, CLOSURE_LABELS, STATUS_DISPLAY, type CaseStatus,
} from '@/lib/api';

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
};

export default async function Page() {
  let stats: Stats, failures: Failure[];
  try {
    [stats, { failures }] = await Promise.all([
      api<Stats>('/api/portfolio/stats'),
      api<{ failures: Failure[] }>('/api/portfolio/failures?limit=100'),
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
                <th className="py-2 px-3 font-medium">Status</th>
                <th className="py-2 px-3 font-medium">Failed at (IST)</th>
              </tr>
            </thead>
            <tbody>
              {failures.map((f) => (
                <tr key={f.id} className="border-b border-border/60 last:border-0">
                  <td className="py-2 px-3">
                    <span className="font-medium">{f.customer_name}</span>
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
                </tr>
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
