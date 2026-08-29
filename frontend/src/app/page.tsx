import { api, inr, inrCompact, istDateTime, DECLINE_LABELS } from '@/lib/api';

export const dynamic = 'force-dynamic';

type Stats = {
  totals: { failed_attempts: number; at_risk_inr: number; customers_affected: number };
  byDeclineCode: { decline_code: string; n: number; at_risk_inr: number }[];
  bySegment: { segment: string; n: number; at_risk_inr: number }[];
  hardStops: { opted_out: number; disputed: number };
};

type Failure = {
  id: string; customer_name: string; segment: string; decline_code: string;
  amount_inr: number; attempt_number: number; created_at: string; channel: string;
  plan_name: string | null; invoice_number: string | null;
  opted_out_at: string | null; disputed_at: string | null;
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

  const maxCount = Math.max(...stats.byDeclineCode.map((d) => d.n));

  return (
    <div className="space-y-10">
      <section>
        <h1 className="text-xl font-semibold tracking-tight">Revenue at risk</h1>
        <p className="text-sm text-muted mt-1">
          Synthetic book of failed payments, mandates and overdue invoices, waiting for the
          recovery agent.
        </p>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-5">
          <Metric label="Revenue at risk" value={inrCompact(stats.totals.at_risk_inr)} sub={inr(stats.totals.at_risk_inr)} />
          <Metric label="Failed payments" value={String(stats.totals.failed_attempts)} sub="across all decline codes" />
          <Metric label="Customers affected" value={String(stats.totals.customers_affected)} sub="unique payers" />
          <Metric
            label="Hard stops on file"
            value={String(stats.hardStops.opted_out + stats.hardStops.disputed)}
            sub={`${stats.hardStops.opted_out} opted out · ${stats.hardStops.disputed} disputed`}
          />
        </div>
      </section>

      <section className="grid md:grid-cols-2 gap-8">
        <div>
          <h2 className="text-sm font-semibold mb-3">Failure mix by decline code</h2>
          <ul className="space-y-1.5">
            {stats.byDeclineCode.map((d) => (
              <li key={d.decline_code} className="flex items-center gap-3 text-sm">
                <span className="w-40 shrink-0 text-muted">
                  {DECLINE_LABELS[d.decline_code] ?? d.decline_code}
                </span>
                <span className="flex-1 h-2 rounded-full bg-border overflow-hidden">
                  <span
                    className="block h-full rounded-full bg-accent"
                    style={{ width: `${(d.n / maxCount) * 100}%` }}
                  />
                </span>
                <span className="w-8 text-right tabular-nums">{d.n}</span>
              </li>
            ))}
          </ul>
        </div>

        <div>
          <h2 className="text-sm font-semibold mb-3">At-risk revenue by segment</h2>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-muted text-left border-b border-border">
                <th className="py-2 font-medium">Segment</th>
                <th className="py-2 font-medium text-right">Failures</th>
                <th className="py-2 font-medium text-right">At risk</th>
              </tr>
            </thead>
            <tbody>
              {stats.bySegment.map((s) => (
                <tr key={s.segment} className="border-b border-border/60">
                  <td className="py-2 capitalize">{s.segment}</td>
                  <td className="py-2 text-right tabular-nums">{s.n}</td>
                  <td className="py-2 text-right tabular-nums">{inr(s.at_risk_inr)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

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
                <th className="py-2 px-3 font-medium text-right">Amount</th>
                <th className="py-2 px-3 font-medium text-right">Try</th>
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
                        {f.opted_out_at ? 'opted out' : 'disputed'}
                      </span>
                    )}
                    <span className="block text-xs text-muted capitalize">{f.segment}</span>
                  </td>
                  <td className="py-2 px-3 text-muted">{f.plan_name ?? f.invoice_number}</td>
                  <td className="py-2 px-3">{DECLINE_LABELS[f.decline_code] ?? f.decline_code}</td>
                  <td className="py-2 px-3 text-right tabular-nums">{inr(f.amount_inr)}</td>
                  <td className="py-2 px-3 text-right tabular-nums text-muted">{f.attempt_number}</td>
                  <td className="py-2 px-3 text-muted whitespace-nowrap">{istDateTime(f.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function Metric({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="text-xs text-muted">{label}</div>
      <div className="text-2xl font-semibold tracking-tight mt-1 tabular-nums">{value}</div>
      <div className="text-xs text-muted mt-1">{sub}</div>
    </div>
  );
}

function Offline() {
  return (
    <div className="rounded-lg border border-border bg-card p-6">
      <h1 className="font-semibold">Backend not reachable</h1>
      <p className="text-sm text-muted mt-2">
        Start it and seed the database:
      </p>
      <pre className="mt-3 text-xs bg-background border border-border rounded p-3 overflow-x-auto">
{`npm run reset && npm run seed   # generate the synthetic book
npm run dev                     # backend :4000 + frontend :3000`}
      </pre>
    </div>
  );
}
