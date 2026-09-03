'use client';

import { useEffect, useMemo, useState } from 'react';
import { inr } from '@/lib/api';
import {
  fetchLiveConfig, openLiveCase,
  type LiveCaseResult, type LiveConfig,
} from '@/lib/liveCase';
import { RealLinkCase } from '@/components/RealLinkCase';
import { Group, fieldClass } from '@/components/FormBits';

/**
 * The real one.
 *
 * The only component in this app that calls a payment provider. It posts to
 * /api/live/cases, which mints an actual Razorpay test-mode payment link and
 * writes a real case to the book; the simulator in SimulatePanel shares none of
 * this code and reaches no network beyond its own event stream. It lives on its
 * own route, /payment-link, for exactly that reason.
 *
 * Kept deliberately smaller than the simulator's form. That panel exists to
 * exercise the decision engine, so it exposes attempt number and compliance
 * flags. This one exists to produce a payable link, so it asks for the three
 * things that determine one — who owes it, how much, and why — and lets the
 * engine settle everything else.
 *
 * ## Why the reason list is shorter than the simulator's
 *
 * A payment link only exists if the agent decides to send a message that quotes
 * one. Two decline causes — a technical error and a gateway timeout — are
 * correctly retried in silence from beginning to end: nobody is ever asked for
 * anything, so there is no link to mint. Offering them in a section called
 * "generate a real payment link" would be a trap, so they are filtered out and
 * the footnote says where they went. They still work on the simulate page.
 */

const AMOUNT_PRESETS = [499, 2499, 18999, 450000];

/** Its chosen action is literally `payment_link`, which is the least surprising default. */
const DEFAULT_REASON = 'authentication_failed';

export function RealLinkPanel() {
  const [config, setConfig] = useState<LiveConfig | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);

  const [customerName, setCustomerName] = useState('');
  const [amount, setAmount] = useState('2499');
  const [reason, setReason] = useState(DEFAULT_REASON);

  const [result, setResult] = useState<LiveCaseResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchLiveConfig().then(setConfig).catch((e) => setConfigError((e as Error).message));
  }, []);

  /** Only causes that actually produce a link. See the note above. */
  const reasons = useMemo(
    () => (config?.declineCodes ?? []).filter((d) => d.mintsPaymentLink),
    [config],
  );
  const hidden = (config?.declineCodes ?? []).length - reasons.length;
  const chosen = reasons.find((r) => r.code === reason) ?? null;

  const amountInr = Math.round(Number(amount));
  const amountInvalid = !Number.isFinite(amountInr) || amountInr < 1;
  const nameMissing = !customerName.trim();
  const ready = Boolean(config?.razorpay.configured);
  const canRun = Boolean(config) && !busy && !nameMissing && !amountInvalid;

  async function run() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await openLiveCase({
        customerName: customerName.trim(),
        amountInr,
        declineCode: reason,
        // Not exposed. The live path refuses enterprise, and consumer is the
        // right shape for a hand-entered one-off: the segment only steers the
        // channel and the priors, neither of which changes the link.
        segment: 'consumer',
        // Always on here. Left off, the matrix schedules the first outreach an
        // hour out and this panel would hand back a case with nothing to show.
        sendFirstMessageNow: true,
      }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (configError) {
    return (
      <div className="rounded-lg border border-border bg-card p-6">
        <h3 className="font-semibold text-sm">Backend not reachable</h3>
        <p className="text-sm text-muted mt-2">{configError}</p>
      </div>
    );
  }

  return (
    <div className="grid lg:grid-cols-[330px_1fr] gap-6 items-start">
      {/* ---- The form ---- */}
      <form
        className="rounded-lg border border-brand/35 bg-card p-4 space-y-4 lg:sticky lg:top-6"
        onSubmit={(e) => { e.preventDefault(); if (canRun) run(); }}
      >
        <Group label="Customer">
          <input
            type="text"
            value={customerName}
            onChange={(e) => setCustomerName(e.target.value)}
            placeholder="e.g. Meera Iyer"
            className={fieldClass}
          />
        </Group>

        <Group label="Amount">
          <div className="flex gap-2">
            <span className="grid place-items-center px-2 text-sm text-muted border border-border rounded-md bg-background">₹</span>
            <input
              type="number"
              min={1}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className={`${fieldClass} tabular-nums`}
            />
          </div>
          <div className="flex gap-1.5 mt-2 flex-wrap">
            {AMOUNT_PRESETS.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setAmount(String(p))}
                className="text-xs px-2 py-1 rounded border border-border text-muted hover:text-foreground hover:border-brand/60 transition-colors tabular-nums"
              >
                {inr(p)}
              </button>
            ))}
          </div>
        </Group>

        <Group
          label="Reason"
          hint={chosen
            ? (chosen.paymentLinkAttempt === 1
              ? `The agent responds with ${chosen.firstActionLabel?.toLowerCase()}, which carries the link.`
              : `The agent opens with ${chosen.firstActionLabel?.toLowerCase()} and escalates to ${chosen.paymentLinkActionLabel?.toLowerCase()} on attempt ${chosen.paymentLinkAttempt}. The link is minted now and payable immediately either way.`)
            : undefined}
        >
          <select
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className={fieldClass}
          >
            {reasons.map((r) => (
              <option key={r.code} value={r.code}>{r.label}</option>
            ))}
          </select>
        </Group>

        <div className="pt-1">
          <button
            type="submit"
            disabled={!canRun}
            className="w-full rounded-md bg-brand text-on-brand text-sm font-medium py-2 disabled:opacity-40 disabled:cursor-not-allowed hover:opacity-90 transition-opacity"
          >
            {busy ? 'Calling Razorpay…' : result ? 'Generate another link' : 'Generate real payment link'}
          </button>
        </div>

        {nameMissing && <p className="text-xs text-muted">Give the customer a name.</p>}

        {config && (
          <p className="text-xs text-muted pt-3 border-t border-border leading-relaxed">
            {ready
              ? <>Live calls to Razorpay on key{' '}
                <span className="font-mono">{config.razorpay.keyId}</span>{' '}
                <span className="text-brand">test mode</span>. Nothing here can move real money.</>
              : <span className="text-alert">
                {config.razorpay.refusal
                  ?? `Razorpay is not configured — set ${config.razorpay.missing.join(', ')} in .env and restart.`}
              </span>}
            {hidden > 0 && (
              <> {hidden} cause{hidden === 1 ? ' is' : 's are'} not listed here: they are retried
                silently end to end and never quote a link. They still run on the simulate page.</>
            )}
          </p>
        )}
      </form>

      {/* ---- The result ---- */}
      <div className="min-w-0">
        {error && (
          <div className="rounded-lg border border-alert/40 bg-alert/5 p-4 mb-4">
            <p className="text-sm text-alert leading-relaxed">{error}</p>
          </div>
        )}

        {busy && (
          <div className="rounded-lg border border-border bg-card p-6">
            <p className="text-sm text-muted">
              Minting the payment link on Razorpay and opening the case…
            </p>
          </div>
        )}

        {!busy && result && <RealLinkCase key={result.caseId} result={result} />}
        {!busy && !result && <HowToPay config={config} ready={ready} />}
      </div>
    </div>
  );
}

/**
 * What to expect, and — the part worth having on screen during a demo — exactly
 * what to pay the link with.
 *
 * The test instruments come from the API rather than being typed in here, so
 * they are the ones the running integration actually accepts.
 */
function HowToPay({ config, ready }: { config: LiveConfig | null; ready: boolean }) {
  const t = config?.razorpay.testInstruments ?? null;

  return (
    <div className="rounded-lg border border-dashed border-brand/40 p-6">
      <h3 className="text-sm font-semibold">What happens when you press it</h3>
      <ol className="mt-3 space-y-2.5 text-sm text-muted">
        {[
          ['Razorpay is called', 'A real POST to /v1/payment_links on your test key. The URL that comes back is live.'],
          ['A case is written', 'Persisted, with a real id, the link stored against it, and the current timestamp — nothing back-dated.'],
          ['The agent writes the message', 'The same narrator the simulator uses, quoting the real URL rather than a placeholder.'],
          ['Only Razorpay can close it', 'No outcome is modelled here. The case stays open until a payment actually lands.'],
          ['The batch is untouched', 'The case is marked source = live, which portfolio totals, priors and the baseline all filter out.'],
        ].map(([title, body]) => (
          <li key={title} className="flex gap-3">
            <span className="text-muted mt-0.5 shrink-0">·</span>
            <span><span className="font-medium text-foreground">{title}</span> — {body}</span>
          </li>
        ))}
      </ol>

      {ready && t && (
        <div className="mt-5 pt-4 border-t border-border">
          <h4 className="text-sm font-semibold">Paying it, in test mode</h4>
          <p className="text-xs text-muted mt-1 leading-relaxed">
            No real money moves. These are the only instruments Razorpay accepts on a test key.
          </p>

          <div className="mt-3 rounded-md border border-border bg-background p-3">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs font-medium">UPI — fastest</span>
              <code className="text-xs font-mono px-1.5 py-0.5 rounded bg-card border border-border">
                {t.upi.success}
              </code>
              <span className="text-xs text-muted">succeeds</span>
              <code className="text-xs font-mono px-1.5 py-0.5 rounded bg-card border border-border">
                {t.upi.failure}
              </code>
              <span className="text-xs text-muted">fails</span>
            </div>
            <p className="text-xs text-muted mt-2 leading-relaxed">{t.upi.note}</p>
          </div>

          <div className="mt-3 rounded-md border border-border bg-background p-3">
            <span className="text-xs font-medium">Cards</span>
            {([
              ['Succeed', t.cards.success],
              ['Decline', t.cards.failure],
            ] as const).map(([label, list]) => (
              <div key={label} className="mt-2">
                <span className="text-xs text-muted">{label}</span>
                <ul className="mt-1 space-y-1">
                  {list.map((c) => (
                    <li key={c.number} className="text-xs flex gap-2 flex-wrap items-baseline">
                      <code className="font-mono px-1.5 py-0.5 rounded bg-card border border-border">
                        {c.number}
                      </code>
                      <span className="text-muted">{c.network}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            <p className="text-xs text-muted mt-2 leading-relaxed">{t.cards.rules}</p>
          </div>

          <p className="text-xs text-muted mt-3 leading-relaxed">
            These are Razorpay&apos;s own test numbers, not the Stripe-style ones —{' '}
            <a href={t.docs} target="_blank" rel="noreferrer" className="underline hover:text-foreground">
              their reference
            </a>{' '}has the full list, including cards for specific decline reasons.
          </p>
        </div>
      )}

      {!ready && config && (
        <div className="mt-5 pt-4 border-t border-border">
          <h4 className="text-sm font-semibold">Razorpay is not switched on yet</h4>
          <ol className="mt-2 space-y-1.5 text-xs text-muted list-decimal list-inside leading-relaxed">
            {(config.razorpay.setup?.steps ?? []).map((step) => <li key={step}>{step}</li>)}
          </ol>
        </div>
      )}
    </div>
  );
}
