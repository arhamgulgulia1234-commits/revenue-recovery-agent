import Link from 'next/link';
import { SimulatePanel } from '@/components/SimulatePanel';
import { RealLinkPanel } from '@/components/RealLinkPanel';

/**
 * Two sections, and the distinction between them is the point of the page.
 *
 * They were briefly one panel with a mode toggle, which was a mistake: a toggle
 * makes "is this real?" a piece of state a viewer has to notice and remember,
 * and the honest answer differs in almost every respect — which database is
 * written, whose clock the case runs on, whether an outcome is invented, and
 * whether anything is minted on a payment provider. Two headed sections say it
 * once, permanently, without anyone having to check.
 *
 * The separation is structural, not cosmetic. SimulatePanel talks only to
 * /api/simulate/stream, which runs on a throwaway in-memory database and cannot
 * reach a payment provider. RealLinkPanel talks only to /api/live/cases, which
 * is the sole path in this app that calls Razorpay. They share form styling and
 * nothing else — no state, no client, no engine code.
 */
export default function SimulatePage() {
  return (
    <div className="space-y-10">
      <section>
        <h1 className="text-xl font-semibold tracking-tight">Run a case</h1>
        <p className="text-sm text-muted mt-1 max-w-3xl leading-relaxed">
          Two ways to put one failed payment through the agent. The first models the whole recovery
          on a throwaway database and invents its outcome; the second mints a real Razorpay
          payment link and can only be closed by a real payment. Same engine underneath — the same{' '}
          <Link href="/" className="underline hover:text-foreground">classifier, matrix and
          compliance gates</Link> the 80-case batch runs on.
        </p>
      </section>

      {/* ================= Section 1 — simulated ================= */}
      <section aria-labelledby="sec-simulate">
        <SectionHeader
          id="sec-simulate"
          eyebrow="Section 1"
          badge={{ label: 'Simulated', className: 'bg-pending/10 text-pending' }}
          title="Simulate a failure"
          blurb={
            <>
              Enter one failure and watch the agent work it, stage by stage. Runs on a throwaway
              in-memory database, back-dates the failure so a full sequence resolves in one pass,
              and rolls the outcome off the same probability tables as the batch.{' '}
              <span className="text-foreground">Nothing is persisted and no payment provider is
              called.</span>
            </>
          }
        />
        <SimulatePanel />
      </section>

      {/* ================= Section 2 — real ================= */}
      <section aria-labelledby="sec-real">
        <SectionHeader
          id="sec-real"
          eyebrow="Section 2"
          badge={{ label: 'Live · Razorpay test mode', className: 'bg-brand/15 text-brand' }}
          title="Generate a real payment link"
          accent
          blurb={
            <>
              Enter a customer, an amount and a reason. This calls Razorpay&apos;s Payment Links API
              on your test key and writes a real, persisted case carrying the URL it returns.{' '}
              <span className="text-foreground">No outcome is ever modelled here — the case closes
              only when Razorpay confirms the money arrived.</span>
            </>
          }
        />
        <RealLinkPanel />
      </section>
    </div>
  );
}

/** The header that makes which-section-is-which readable at a glance. */
function SectionHeader({
  id, eyebrow, badge, title, blurb, accent = false,
}: {
  id: string;
  eyebrow: string;
  badge: { label: string; className: string };
  title: string;
  blurb: React.ReactNode;
  accent?: boolean;
}) {
  return (
    <div className={`mb-5 pl-4 border-l-2 ${accent ? 'border-brand' : 'border-border'}`}>
      <div className="flex items-center gap-2.5 flex-wrap">
        <span className="text-[11px] font-mono uppercase tracking-wider text-muted-2">
          {eyebrow}
        </span>
        <h2 id={id} className="text-lg font-semibold tracking-tight">{title}</h2>
        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${badge.className}`}>
          {badge.label}
        </span>
      </div>
      <p className="text-sm text-muted mt-1.5 max-w-3xl leading-relaxed">{blurb}</p>
    </div>
  );
}
