import Link from 'next/link';
import { RealLinkPanel } from '@/components/RealLinkPanel';

/**
 * The only route in this app that reaches a payment provider.
 *
 * Kept apart from /simulate on purpose, and not as a matter of taste: the two
 * differ in which database is written, whose clock the case runs on, whether an
 * outcome may be invented, and whether anything is minted on Razorpay. Sharing
 * a page would make "is this real?" something a viewer has to work out. Its own
 * tab answers that before anyone reads a field label.
 */
export default function PaymentLinkPage() {
  return (
    <div className="space-y-6">
      <section>
        <div className="flex items-center gap-2.5 flex-wrap">
          <h1 className="text-xl font-semibold tracking-tight">Generate a real payment link</h1>
          <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-brand/15 text-brand">
            Live · Razorpay test mode
          </span>
        </div>
        <p className="text-sm text-muted mt-1.5 max-w-3xl leading-relaxed">
          Enter a customer, an amount and a reason. This calls Razorpay&apos;s Payment Links API on
          your test key and writes a real, persisted case carrying the URL it returns. No outcome is
          ever modelled here — the case closes only when Razorpay confirms the money arrived, at
          Razorpay&apos;s own payment timestamp. Nothing on this page touches the numbers on the{' '}
          <Link href="/" className="underline hover:text-foreground">dashboard</Link>, and nothing
          on{' '}
          <Link href="/simulate" className="underline hover:text-foreground">Simulate a failure</Link>{' '}
          can reach Razorpay.
        </p>
      </section>

      <RealLinkPanel />
    </div>
  );
}
