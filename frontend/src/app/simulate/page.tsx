import Link from 'next/link';
import { SimulatePanel } from '@/components/SimulatePanel';

/**
 * The simulator, and nothing else.
 *
 * Everything on this page is modelled: a throwaway in-memory database, a
 * back-dated failure so a whole sequence resolves in one pass, and an outcome
 * rolled off the probability tables. No payment provider is reachable from
 * here — the real Razorpay integration is its own nav tab and its own route, so
 * that what is simulated and what is real are never the same page.
 */
export default function SimulatePage() {
  return (
    <div className="space-y-6">
      <section>
        <h1 className="text-xl font-semibold tracking-tight">Simulate a failed payment</h1>
        <p className="text-sm text-muted mt-1 max-w-3xl leading-relaxed">
          Enter one failure and watch the agent work it, stage by stage. This runs the same engine
          as the batch on the{' '}
          <Link href="/" className="underline hover:text-foreground">dashboard</Link> — the same
          classifier, decision matrix, compliance gates, scorer and outcome tables — on a throwaway
          database, so nothing here moves the real numbers.
        </p>
      </section>

      <SimulatePanel />
    </div>
  );
}
