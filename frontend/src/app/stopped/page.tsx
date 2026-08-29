import Link from 'next/link';
import { ClickableRow } from '@/components/ClickableRow';
import {
  api, inr, inrCompact, istDateTime,
  ROOT_CAUSE_LABELS, CLOSURE_LABELS, SEGMENT_LABELS,
} from '@/lib/api';

export const dynamic = 'force-dynamic';

type StoppedCase = {
  id: string; customer_name: string; segment: string; root_cause: string;
  amount_at_risk_inr: number; attempts_used: number; closure_reason: string;
  closed_at: string; plan_name: string | null; invoice_number: string | null;
};

type Group = { cases: StoppedCase[]; count: number; totalInr: number };
type StoppedData = { total: { count: number; totalInr: number }; respected: Group; capped: Group };

export default async function StoppedPage() {
  let data: StoppedData;
  try {
    data = await api<StoppedData>('/api/cases/stopped');
  } catch {
    return <Offline />;
  }

  const { respected, capped, total } = data;

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Where the agent stopped</h1>
        <p className="text-sm text-muted mt-2 max-w-3xl leading-relaxed">
          The agent respects hard limits — <strong className="text-foreground">{total.count} cases</strong>{' '}
          were stopped rather than pursued further, leaving{' '}
          <strong className="text-foreground">{inr(total.totalInr)}</strong> deliberately
          unrecovered to protect customers from over-contact and stay inside compliance limits.
        </p>
      </header>

      <div className="grid sm:grid-cols-2 gap-3">
        <Summary
          label="Respecting the customer"
          count={respected.count}
          amount={respected.totalInr}
          tone="border-red-500/40 bg-red-500/[0.06]"
          note="opted out or disputed"
        />
        <Summary
          label="Policy limit"
          count={capped.count}
          amount={capped.totalInr}
          tone="border-amber-500/40 bg-amber-500/[0.06]"
          note="reached the 3-attempt cap"
        />
      </div>

      <Section
        title="Stopped — customer opted out or disputed"
        accent="text-red-500"
        blurb="These customers told us to stop, so the agent stopped — permanently, on this case
               and on every future one. Some had opted out before the payment ever failed, so the
               agent never contacted them at all. The money here is not lost to a failed
               collection; it is money we chose not to chase."
        group={respected}
      />

      <Section
        title="Stopped — maximum retry attempts reached"
        accent="text-amber-500"
        blurb="The agent tried three times, each with a different approach, and stopped. The cap
               exists so it cannot pressure someone indefinitely. These cases are handed to a
               human rather than retried a fourth time — the hand-off is the point of the limit,
               not a dead end."
        group={capped}
      />
    </div>
  );
}

function Section({
  title, blurb, group, accent,
}: { title: string; blurb: string; group: Group; accent: string }) {
  if (!group.count) return null;
  return (
    <section>
      <h2 className={`text-sm font-semibold ${accent}`}>{title}</h2>
      <p className="text-xs text-muted mt-1 mb-1 max-w-3xl leading-relaxed">{blurb}</p>
      <p className="text-xs text-muted mb-3">
        <strong className="text-foreground">{inr(group.totalInr)}</strong> across{' '}
        {group.count} case{group.count === 1 ? '' : 's'}
      </p>

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-muted text-left bg-card border-b border-border">
              <th className="py-2 px-3 font-medium">Customer</th>
              <th className="py-2 px-3 font-medium">Item</th>
              <th className="py-2 px-3 font-medium">Root cause</th>
              <th className="py-2 px-3 font-medium text-right">Amount</th>
              <th className="py-2 px-3 font-medium text-center">Attempts</th>
              <th className="py-2 px-3 font-medium">Why it stopped</th>
            </tr>
          </thead>
          <tbody>
            {group.cases.map((c) => (
              <ClickableRow
                key={c.id}
                href={`/cases/${c.id}`}
                className="border-b border-border/60 last:border-0 hover:bg-card/70 transition-colors"
              >
                <td className="py-2 px-3">
                  <Link href={`/cases/${c.id}`} className="font-medium hover:underline">
                    {c.customer_name}
                  </Link>
                  <span className="block text-xs text-muted">
                    {SEGMENT_LABELS[c.segment] ?? c.segment} · <span className="font-mono">{c.id}</span>
                  </span>
                </td>
                <td className="py-2 px-3 text-muted">{c.plan_name ?? c.invoice_number}</td>
                <td className="py-2 px-3">{ROOT_CAUSE_LABELS[c.root_cause] ?? c.root_cause}</td>
                <td className="py-2 px-3 text-right tabular-nums">{inr(c.amount_at_risk_inr)}</td>
                <td className="py-2 px-3 text-center tabular-nums text-muted">
                  {c.attempts_used}/3
                </td>
                <td className="py-2 px-3">
                  {CLOSURE_LABELS[c.closure_reason] ?? c.closure_reason}
                  <span className="block text-xs text-muted">{nuance(c)}</span>
                </td>
              </ClickableRow>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/**
 * Whether the customer was already off-limits or asked us to stop partway
 * through matters: one means we never touched them, the other means we listened
 * the moment they said so.
 */
function nuance(c: StoppedCase): string {
  switch (c.closure_reason) {
    case 'customer_opted_out':
    case 'customer_disputed':
      return c.attempts_used === 0
        ? 'Already off-limits — no retry, no message ever sent'
        : 'Flagged before this failure; agent took no further action';
    case 'opted_out_mid_recovery':
      return `Opted out after attempt ${c.attempts_used} — contact ended immediately`;
    case 'disputed_mid_recovery':
      return `Disputed after attempt ${c.attempts_used} — all collection ended`;
    case 'max_attempts_reached':
      return `Closed ${istDateTime(c.closed_at)} · handed to a human`;
    case 'sequence_exhausted':
      return 'Every intervention this root cause supports was tried';
    default:
      return '';
  }
}

function Summary({
  label, count, amount, tone, note,
}: { label: string; count: number; amount: number; tone: string; note: string }) {
  return (
    <div className={`rounded-lg border p-4 ${tone}`}>
      <div className="text-xs text-muted">{label}</div>
      <div className="text-2xl font-semibold tracking-tight mt-1 tabular-nums">
        {inrCompact(amount)}
      </div>
      <div className="text-xs text-muted mt-1">
        {count} case{count === 1 ? '' : 's'} · {note}
      </div>
    </div>
  );
}

function Offline() {
  return (
    <div className="rounded-lg border border-border bg-card p-6">
      <h1 className="font-semibold">Backend not reachable</h1>
      <pre className="mt-3 text-xs bg-background border border-border rounded p-3 overflow-x-auto">
{`npm run demo   # reset + seed + simulate + verify
npm run dev    # backend :4000 + frontend :3000`}
      </pre>
    </div>
  );
}
