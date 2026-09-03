'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { inr, SEGMENT_LABELS } from '@/lib/api';
import {
  fetchOptions, streamRun,
  type HardStop, type LiveEvent, type MetaEvent, type Segment,
  type SimInput, type SimOptions,
} from '@/lib/live';
import {
  fetchLiveConfig, openLiveCase,
  type LiveCaseResult, type LiveConfig, type LiveSegment,
} from '@/lib/liveCase';
import { LiveStages } from '@/components/LiveStages';
import { RealLinkCase } from '@/components/RealLinkCase';

/**
 * The live control panel.
 *
 * Type one failed payment, watch the agent work it. Every stage on screen comes
 * off the same engine the 80-case batch runs on — this page holds no copy of
 * the classifier, the matrix, the scorer or the outcome tables, and it cannot:
 * it only reads an event stream.
 *
 * ## Two modes, and the difference between them is real
 *
 * `Simulated` is the original panel and is unchanged: a throwaway in-memory
 * database, a failure back-dated far enough for the whole sequence to resolve in
 * one pass, and outcomes rolled off the probability tables. Nothing it does can
 * move the dashboard's numbers, because nothing it does is persisted.
 *
 * `Real payment link` is the opposite in every one of those respects. The case
 * is written to the book, the failure carries the actual current timestamp, a
 * real Razorpay test-mode link is minted for the amount, and no outcome is ever
 * invented — the case can only close when Razorpay says the money arrived. It
 * runs on a different endpoint (`/api/live/cases`) for that reason, and it is
 * marked `source = 'live'`, which is what keeps the 80-case book out of its way.
 *
 * Neither mode transmits anything. There is no messaging provider in this build:
 * the agent decides a channel and writes the copy, and the payment link is the
 * one artefact a customer could actually act on.
 */

const AMOUNT_PRESETS = [499, 2499, 18999, 450000];

const ATTEMPT_CHOICES = [
  { value: 0, label: '1st', hint: 'Nothing tried yet — the agent opens the case fresh.' },
  { value: 1, label: '2nd', hint: 'One intervention already failed; the agent escalates from step two.' },
  { value: 2, label: '3rd', hint: 'Two already failed. This is the last attempt the cap allows.' },
  { value: 3, label: 'Cap reached', hint: 'All three already spent — the agent is stopped before it acts.' },
];

const HARD_STOP_CHOICES: { value: HardStop; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'opted_out', label: 'Opted out' },
  { value: 'disputed', label: 'Disputed' },
];

export default function SimulatePage() {
  const [options, setOptions] = useState<SimOptions | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  /**
   * Off is the original panel, byte for byte. On switches to the persisted live
   * path — a real case, a real Razorpay link, and a status you can come back and
   * check. Kept as an explicit mode rather than an inferred one: which of these
   * two things happened when you pressed the button should never be a surprise.
   */
  const [realLink, setRealLink] = useState(false);
  const [liveConfig, setLiveConfig] = useState<LiveConfig | null>(null);
  const [phone, setPhone] = useState('');
  // Default on. Left off, an expired-card case sends its first message in an
  // hour, which is right for a real recovery and useless for a rehearsal. The
  // override is audited on the case either way.
  const [sendNow, setSendNow] = useState(true);
  const [liveResult, setLiveResult] = useState<LiveCaseResult | null>(null);
  const [liveBusy, setLiveBusy] = useState(false);

  const [customerId, setCustomerId] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [segment, setSegment] = useState<Segment>('consumer');
  const [amount, setAmount] = useState('2499');
  const [declineCode, setDeclineCode] = useState('expired_card');
  const [attemptsUsed, setAttemptsUsed] = useState(0);
  const [hardStop, setHardStop] = useState<HardStop>('none');

  const [running, setRunning] = useState(false);
  const [meta, setMeta] = useState<MetaEvent | null>(null);
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const [working, setWorking] = useState<{ stage: string; label: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const tailRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    fetchOptions().then(setOptions).catch((e) => setLoadError(e.message));
    // Non-fatal: without it the real-link mode simply reports itself unavailable,
    // and the simulated panel carries on exactly as it always has.
    fetchLiveConfig().then(setLiveConfig).catch(() => setLiveConfig(null));
    return () => abortRef.current?.abort();
  }, []);

  // Follow the run as it grows, but never fight a user who has scrolled away.
  useEffect(() => {
    if (!running) return;
    tailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [events.length, working, running]);

  const picked = useMemo(
    () => options?.customers.find((c) => c.id === customerId) ?? null,
    [options, customerId],
  );

  /** Picking someone real fills in what we know about them; it stays editable. */
  const choose = (id: string) => {
    setCustomerId(id);
    const c = options?.customers.find((x) => x.id === id);
    if (c) setSegment(c.segment as Segment);
  };

  const amountInr = Math.round(Number(amount));
  const amountInvalid = !Number.isFinite(amountInr) || amountInr < 1;

  // The live path takes a typed name rather than a picked customer: it opens a
  // case against a real person, not against a row in the synthetic roster.
  const nameMissing = realLink ? !customerName.trim() : (!customerId && !customerName.trim());

  const razorpayReady = Boolean(liveConfig?.razorpay.configured);
  const declineMeta = liveConfig?.declineCodes.find((d) => d.code === declineCode) ?? null;

  const canRun = Boolean(options) && !running && !liveBusy
    && !nameMissing && !amountInvalid
    && (!realLink || Boolean(liveConfig));

  /**
   * Open a real case: one POST, no stream.
   *
   * Deliberately not streamed. The simulated panel streams because watching the
   * engine think is its whole point; here the interesting object is the case
   * that now exists on the book and the link that now exists on Razorpay's side,
   * and neither is improved by being revealed a stage at a time.
   */
  async function runReal() {
    setLiveBusy(true);
    setError(null);
    setLiveResult(null);
    try {
      setLiveResult(await openLiveCase({
        customerName: customerName.trim(),
        phone: phone.trim() || undefined,
        segment: segment as LiveSegment,
        amountInr,
        declineCode,
        sendFirstMessageNow: sendNow,
      }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLiveBusy(false);
    }
  }

  async function run() {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setRunning(true);
    setMeta(null);
    setEvents([]);
    setWorking(null);
    setError(null);

    const input: SimInput = {
      customerId: customerId || null,
      customerName: customerName.trim(),
      segment,
      amountInr,
      declineCode,
      attemptsUsed,
      hardStop,
    };

    try {
      for await (const e of streamRun(input, controller.signal)) {
        if (e.type === 'meta') setMeta(e);
        else if (e.type === 'working') setWorking({ stage: e.stage, label: e.label });
        else if (e.type === 'error') { setError(e.message); setWorking(null); }
        else if (e.type === 'done') setWorking(null);
        else { setWorking(null); setEvents((prev) => [...prev, e]); }
      }
    } catch (e) {
      // Aborting is how "run again" and leaving the page both work — not an error.
      if (!controller.signal.aborted) setError((e as Error).message);
    } finally {
      if (!controller.signal.aborted) { setRunning(false); setWorking(null); }
    }
  }

  function stop() {
    abortRef.current?.abort();
    setRunning(false);
    setWorking(null);
  }

  if (loadError) {
    return (
      <div className="rounded-lg border border-border bg-card p-6">
        <h1 className="font-semibold">Backend not reachable</h1>
        <p className="text-sm text-muted mt-2">{loadError}</p>
        <pre className="mt-3 text-xs bg-background border border-border rounded p-3 overflow-x-auto">
{`npm run demo   # reset + seed + simulate + verify
npm run dev    # backend :4000 + frontend :3000`}
        </pre>
      </div>
    );
  }

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

      <div className="grid lg:grid-cols-[330px_1fr] gap-6 items-start">
        {/* ---- The panel ---- */}
        <form
          className="rounded-lg border border-border bg-card p-4 space-y-4 lg:sticky lg:top-6"
          onSubmit={(e) => {
            e.preventDefault();
            if (!canRun) return;
            if (realLink) runReal(); else run();
          }}
        >
          <ModeToggle
            realLink={realLink}
            onChange={(v) => {
              setRealLink(v);
              setError(null);
              // The live path refuses enterprise outright, so carrying that
              // selection across the toggle would only earn a 400 on submit.
              if (v && segment === 'enterprise') setSegment('consumer');
            }}
            razorpay={liveConfig?.razorpay ?? null}
          />

          <Group label="Customer">
            {realLink ? (
              <input
                type="text"
                value={customerName}
                onChange={(e) => setCustomerName(e.target.value)}
                placeholder="e.g. Meera Iyer"
                className={fieldClass}
              />
            ) : (
              <>
                <select
                  value={customerId}
                  onChange={(e) => choose(e.target.value)}
                  className={fieldClass}
                >
                  <option value="">Someone new — type a name</option>
                  {options?.customers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} · {SEGMENT_LABELS[c.segment] ?? c.segment}
                      {c.opted_out_at ? ' · opted out' : c.disputed_at ? ' · disputed' : ''}
                    </option>
                  ))}
                </select>
                {!customerId && (
                  <input
                    type="text"
                    value={customerName}
                    onChange={(e) => setCustomerName(e.target.value)}
                    placeholder="e.g. Meera Iyer"
                    className={`${fieldClass} mt-2`}
                  />
                )}
                {picked && (picked.opted_out_at || picked.disputed_at) && (
                  <p className="text-xs text-red-500 mt-1.5 leading-relaxed">
                    Already {picked.disputed_at ? 'disputed' : 'opted out'} on file. The agent will
                    stop on sight whatever the flag below says.
                  </p>
                )}
              </>
            )}
          </Group>

          {realLink && (
            <Group
              label="Phone (optional)"
              hint="Handed to Razorpay so the checkout prefills the contact box. Nothing is messaged or dialled — leave it blank and the link works the same."
            >
              <input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+91 98765 43210"
                className={fieldClass}
              />
            </Group>
          )}

          <Group
            label="Segment"
            hint={realLink
              ? 'Enterprise is not offered here: the matrix routes enterprise contact to email, and this build only delivers over WhatsApp.'
              : undefined}
          >
            <Segmented
              options={(realLink
                ? (liveConfig?.segments ?? ['consumer', 'prosumer', 'smb'])
                : (options?.segments ?? [])
              ).map((s) => ({ value: s, label: SEGMENT_LABELS[s] ?? s }))}
              value={segment}
              onChange={(v) => setSegment(v as Segment)}
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
                  className="text-xs px-2 py-1 rounded border border-border text-muted hover:text-foreground hover:border-accent/60 transition-colors tabular-nums"
                >
                  {inr(p)}
                </button>
              ))}
            </div>
          </Group>

          <Group
            label="Decline code"
            hint={realLink && declineMeta
              ? (declineMeta.mintsPaymentLinkFirst
                ? `First action: ${declineMeta.firstActionLabel} — carries a real payment link.`
                : `First action: ${declineMeta.firstActionLabel} — no message, so no link is minted. Pick a code marked "link" to rehearse a payment.`)
              : undefined}
          >
            <select
              value={declineCode}
              onChange={(e) => setDeclineCode(e.target.value)}
              className={fieldClass}
            >
              {options?.declineCodes.map((d) => {
                const meta = liveConfig?.declineCodes.find((x) => x.code === d.code);
                return (
                  <option key={d.code} value={d.code}>
                    {d.label}
                    {realLink && meta ? (meta.mintsPaymentLinkFirst ? ' · link' : ' · silent retry') : ''}
                  </option>
                );
              })}
            </select>
          </Group>

          {!realLink && (
          <Group
            label="Attempt"
            hint={ATTEMPT_CHOICES.find((a) => a.value === attemptsUsed)?.hint}
          >
            <Segmented
              options={ATTEMPT_CHOICES.map((a) => ({ value: String(a.value), label: a.label }))}
              value={String(attemptsUsed)}
              onChange={(v) => setAttemptsUsed(Number(v))}
            />
          </Group>
          )}

          {!realLink && (
          <Group
            label="On file for this customer"
            hint={
              hardStop === 'none'
                ? undefined
                : 'A permanent bar. The agent stops before it chooses an action, and never writes a message.'
            }
          >
            <Segmented
              options={HARD_STOP_CHOICES.map((h) => ({ value: h.value, label: h.label }))}
              value={hardStop}
              onChange={(v) => setHardStop(v as HardStop)}
              danger={hardStop !== 'none'}
            />
          </Group>
          )}

          {realLink && (
            <Group
              label="Send the first message now"
              hint={sendNow
                ? 'The matrix would schedule this outreach for later — an hour after an expired card, day 7 of an invoice. This pulls only that one message forward, keeps every later attempt on its real schedule, still obeys quiet hours, and is recorded on the audit trail as an operator override.'
                : 'The first message goes out when the matrix scheduled it. Realistic, and nothing will arrive during this demo.'}
            >
              <Segmented
                options={[{ value: 'yes', label: 'Now' }, { value: 'no', label: 'When scheduled' }]}
                value={sendNow ? 'yes' : 'no'}
                onChange={(v) => setSendNow(v === 'yes')}
              />
            </Group>
          )}

          <div className="pt-1 flex gap-2">
            <button
              type="submit"
              disabled={!canRun}
              className="flex-1 rounded-md bg-accent text-white text-sm font-medium py-2 disabled:opacity-40 disabled:cursor-not-allowed hover:opacity-90 transition-opacity"
            >
              {realLink
                ? (liveBusy ? 'Opening the case…' : liveResult ? 'Open another case' : 'Open a real case')
                : (running ? 'Running…' : events.length ? 'Run again' : 'Run through the agent')}
            </button>
            {running && !realLink && (
              <button
                type="button"
                onClick={stop}
                className="rounded-md border border-border text-sm px-3 py-2 text-muted hover:text-foreground transition-colors"
              >
                Stop
              </button>
            )}
          </div>

          {nameMissing && (
            <p className="text-xs text-muted">
              {realLink ? 'Give the customer a name.' : 'Give a name, or pick an existing customer.'}
            </p>
          )}

          {realLink ? (
            <p className="text-xs text-muted pt-3 border-t border-border leading-relaxed">
              This writes a real case to the book with{' '}
              <span className="font-mono">source = &lsquo;live&rsquo;</span>, which portfolio totals,
              priors and the naive-baseline comparison all filter out — the 80-case demo batch
              cannot move. Quiet hours {options?.policy.QUIET_HOURS_LABEL}; cap{' '}
              {options?.policy.MAX_ATTEMPTS_PER_CASE} interventions.
            </p>
          ) : options && (
            <p className="text-xs text-muted pt-3 border-t border-border leading-relaxed">
              {options.narrator.configured
                ? <>Stage 4 calls <span className="font-mono">{options.narrator.model.split('/').pop()}</span> live.</>
                : <>No <span className="font-mono">{options.narrator.provider}</span> key set — stage 4 falls back to the deterministic template narrator, exactly as the batch does.</>}
              {' '}Quiet hours {options.policy.QUIET_HOURS_LABEL}; cap{' '}
              {options.policy.MAX_ATTEMPTS_PER_CASE} interventions.
            </p>
          )}
        </form>

        {/* ---- The run ---- */}
        <div className="min-w-0">
          {realLink ? (
            <>
              {error && (
                <div className="rounded-lg border border-alert/40 bg-alert/5 p-4 mb-4">
                  <p className="text-sm text-alert leading-relaxed">{error}</p>
                </div>
              )}
              {liveResult
                ? <RealLinkCase key={liveResult.caseId} result={liveResult} />
                : !liveBusy && <RealLinkEmptyState config={liveConfig} ready={razorpayReady} />}
              {liveBusy && (
                <div className="rounded-lg border border-border bg-card p-6">
                  <p className="text-sm text-muted">
                    Minting the payment link on Razorpay and opening the case…
                  </p>
                </div>
              )}
            </>
          ) : (
            <>
              {!meta && !running && !error && <EmptyState />}
              <LiveStages meta={meta} events={events} working={working} error={error} />
            </>
          )}
          <div ref={tailRef} />
        </div>
      </div>
    </div>
  );
}

/**
 * Said up front, because it is the thing worth noticing while the stages land:
 * the decision is made before the model is ever called.
 */
function EmptyState() {
  return (
    <div className="rounded-lg border border-dashed border-border p-6">
      <h2 className="text-sm font-semibold">What you will see</h2>
      <ol className="mt-3 space-y-2.5 text-sm text-muted">
        {[
          ['1', 'Root cause', 'A lookup from the decline code. No model — a decision that debits an account has to be reproducible.'],
          ['2', 'Recovery likelihood', 'A weighted blend of rates counted off the batch, with the arithmetic shown.'],
          ['3', 'Recovery action', 'The decision matrix picks what, when and over which channel. Compliance gates run here — and can stop the case outright.'],
          ['4', 'Response', 'The only stage that calls a model. By this point the decision is already recorded; it can describe it, never change it.'],
          ['5', 'Outcome', 'Rolled against the same probability tables the batch uses.'],
        ].map(([n, title, body]) => (
          <li key={n} className="flex gap-3">
            <span className="font-mono text-xs text-muted mt-0.5 shrink-0">{n}</span>
            <span>
              <span className="font-medium text-foreground">{title}</span> — {body}
            </span>
          </li>
        ))}
      </ol>
      <p className="text-xs text-muted mt-4 pt-3 border-t border-border leading-relaxed">
        Set the flag on the left to <span className="text-foreground">Opted out</span> or{' '}
        <span className="text-foreground">Disputed</span>, or the attempt to{' '}
        <span className="text-foreground">Cap reached</span>, to watch the agent stop at stage 3 —
        no action chosen, no message written.
      </p>
    </div>
  );
}

/**
 * Choosing between a rehearsal and a real case.
 *
 * Given its own block at the top of the form rather than folded in as a
 * checkbox, because it changes what pressing the button *does*: one throws the
 * case away, the other writes it to the book and mints a link on Razorpay.
 */
function ModeToggle({
  realLink, onChange, razorpay,
}: {
  realLink: boolean;
  onChange: (v: boolean) => void;
  razorpay: LiveConfig['razorpay'] | null;
}) {
  return (
    <div className="rounded-md border border-border overflow-hidden">
      <div className="flex">
        {[
          { value: false, label: 'Simulated' },
          { value: true, label: 'Real payment link' },
        ].map((o) => (
          <button
            key={String(o.value)}
            type="button"
            onClick={() => onChange(o.value)}
            aria-pressed={realLink === o.value}
            className={`flex-1 text-xs py-2 px-1 transition-colors border-r border-border last:border-r-0 ${
              realLink === o.value
                ? 'bg-accent/15 text-accent font-medium'
                : 'text-muted hover:text-foreground hover:bg-background'
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>
      <p className="text-xs text-muted px-2.5 py-2 border-t border-border leading-relaxed">
        {realLink
          ? 'Writes a real case and mints a real Razorpay test-mode link for the amount. Only Razorpay can close it.'
          : 'A throwaway run on a scratch database. Outcomes are modelled; nothing is persisted.'}
      </p>
      {realLink && razorpay && !razorpay.configured && (
        <p className="text-xs text-alert px-2.5 pb-2 leading-relaxed">
          {razorpay.refusal
            ?? `Razorpay is not configured — set ${razorpay.missing.join(', ')} in .env and restart. `
              + 'The case will still open; it just falls back to the synthetic link text.'}
        </p>
      )}
    </div>
  );
}

/**
 * What to expect, and — the part worth having on screen — exactly what to pay
 * the link with.
 *
 * The test instruments come from the API rather than being typed in here, so
 * they are the ones the running integration actually accepts.
 */
function RealLinkEmptyState({ config, ready }: { config: LiveConfig | null; ready: boolean }) {
  const t = config?.razorpay.testInstruments ?? null;

  return (
    <div className="rounded-lg border border-dashed border-border p-6">
      <h2 className="text-sm font-semibold">What this does differently</h2>
      <ul className="mt-3 space-y-2.5 text-sm text-muted">
        {[
          ['Persists', 'The case is written to the book with a real id, not thrown away. You can come back to it.'],
          ['Real time', 'The failure carries the current timestamp. Nothing is back-dated to make a sequence resolve.'],
          ['Real link', 'Razorpay mints a test-mode payment link for the amount, and the agent quotes that URL in the message it writes.'],
          ['No invented outcome', 'Nothing is rolled off a probability table. The case closes only when Razorpay says the money arrived.'],
          ['Batch untouched', 'The case is marked source = live, which portfolio totals, priors and the baseline comparison all filter out.'],
        ].map(([title, body]) => (
          <li key={title} className="flex gap-3">
            <span className="text-muted mt-0.5 shrink-0">·</span>
            <span><span className="font-medium text-foreground">{title}</span> — {body}</span>
          </li>
        ))}
      </ul>

      {ready && t && (
        <div className="mt-5 pt-4 border-t border-border">
          <h3 className="text-sm font-semibold">Paying it, in test mode</h3>
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
          <h3 className="text-sm font-semibold">Razorpay is not switched on yet</h3>
          <ol className="mt-2 space-y-1.5 text-xs text-muted list-decimal list-inside leading-relaxed">
            {(config.razorpay.setup?.steps ?? []).map((step) => <li key={step}>{step}</li>)}
          </ol>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small form pieces
// ---------------------------------------------------------------------------

const fieldClass =
  'w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm outline-none ' +
  'focus-visible:ring-2 focus-visible:ring-accent/60';

function Group({
  label, hint, children,
}: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-medium text-muted mb-1.5">{label}</label>
      {children}
      {hint && <p className="text-xs text-muted mt-1.5 leading-relaxed">{hint}</p>}
    </div>
  );
}

function Segmented({
  options, value, onChange, danger = false,
}: {
  options: { value: string; label: string }[];
  value: string;
  onChange: (v: string) => void;
  danger?: boolean;
}) {
  return (
    <div className="flex rounded-md border border-border overflow-hidden">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            aria-pressed={active}
            className={`flex-1 text-xs py-1.5 px-1 transition-colors border-r border-border last:border-r-0 ${
              active
                ? danger
                  ? 'bg-red-500/15 text-red-500 font-medium'
                  : 'bg-accent/15 text-accent font-medium'
                : 'text-muted hover:text-foreground hover:bg-background'
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
