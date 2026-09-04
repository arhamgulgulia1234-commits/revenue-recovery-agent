import Link from 'next/link';
import { inr } from '@/lib/api';

/**
 * Real money, reported next to the modelled book but never mixed into it.
 *
 * The dashboard's headline numbers are scoped to `source = 'seed'` precisely so
 * a live case cannot move them, and that guarantee is worth more than the
 * convenience of one combined total. But the consequence, before this existed,
 * was that paying a real Razorpay link changed nothing visible anywhere: the
 * case flipped to recovered on its own page and the dashboard carried on as if
 * nothing had happened.
 *
 * So this is a second set of books, shown as a second set of books. Rendered
 * only when live cases exist, so a fresh clone of the repo looks exactly as it
 * did before.
 */
export type LiveStats = {
  real: boolean;
  cases: { total: number; recovered: number; inFlight: number; linksMinted: number };
  recoveredInr: number;
  atRiskInr: number;
  lastPaidAt: string | null;
  lastPaidAtLabel: string | null;
  razorpay: { configured: boolean; mode: string | null; keyId: string | null };
};

export function LiveStrip({ stats }: { stats: LiveStats | null }) {
  if (!stats || stats.cases.total === 0) return null;

  return (
    <section className="rounded-lg border border-brand/35 bg-brand/[0.04] p-5">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-2.5 flex-wrap">
            <h2 className="text-sm font-semibold">Real recoveries</h2>
            <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-brand/15 text-brand">
              Live · Razorpay test mode
            </span>
          </div>
          <p className="text-xs text-muted mt-1.5 max-w-2xl leading-relaxed">
            Counted separately from everything else on this page. The figures above describe the
            modelled book and are filtered so a live case cannot move them — these are real
            Razorpay payment links, and money that actually arrived.{' '}
            <Link href="/payment-link" className="underline hover:text-foreground">
              Generate one
            </Link>.
          </p>
        </div>
        {stats.lastPaidAtLabel && (
          <p className="text-xs text-muted">last payment {stats.lastPaidAtLabel}</p>
        )}
      </div>

      <dl className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-4">
        <Stat label="Recovered" value={inr(stats.recoveredInr)} accent />
        <Stat label="Cases recovered" value={`${stats.cases.recovered} of ${stats.cases.total}`} />
        <Stat label="Still in flight" value={String(stats.cases.inFlight)} />
        <Stat label="Links minted" value={String(stats.cases.linksMinted)} />
      </dl>
    </section>
  );
}

function Stat({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <div>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className={`mt-0.5 text-xl font-semibold tabular-nums ${accent ? 'text-brand' : ''}`}>
        {value}
      </dd>
    </div>
  );
}
