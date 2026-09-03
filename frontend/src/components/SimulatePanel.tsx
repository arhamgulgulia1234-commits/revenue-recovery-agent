'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { inr, SEGMENT_LABELS } from '@/lib/api';
import {
  fetchOptions, streamRun,
  type HardStop, type LiveEvent, type MetaEvent, type Segment,
  type SimInput, type SimOptions,
} from '@/lib/live';
import { LiveStages } from '@/components/LiveStages';
import { Group, Segmented, fieldClass } from '@/components/FormBits';

/**
 * The simulator.
 *
 * Type one failed payment, watch the agent work it. Every stage on screen comes
 * off the same engine the 80-case batch runs on — this panel holds no copy of
 * the classifier, the matrix, the scorer or the outcome tables, and it cannot:
 * it only reads an event stream.
 *
 * Entirely simulated, and that is the whole of its contract. It runs against a
 * throwaway in-memory database, back-dates the failure so a full sequence can
 * resolve in one pass, and rolls outcomes off the probability tables. It calls
 * no payment provider and never has — the real Razorpay path is a separate
 * route, /payment-link, on a separate endpoint, deliberately not merged with
 * this one, so what is modelled and what is real cannot be confused.
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

export function SimulatePanel() {
  const [options, setOptions] = useState<SimOptions | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

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
  const nameMissing = !customerId && !customerName.trim();
  const amountInvalid = !Number.isFinite(amountInr) || amountInr < 1;
  const canRun = Boolean(options) && !running && !nameMissing && !amountInvalid;

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
    <div className="grid lg:grid-cols-[330px_1fr] gap-6 items-start">
        {/* ---- The panel ---- */}
        <form
          className="rounded-lg border border-border bg-card p-4 space-y-4 lg:sticky lg:top-6"
          onSubmit={(e) => { e.preventDefault(); if (canRun) run(); }}
        >
          <Group label="Customer">
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
                Already {picked.disputed_at ? 'disputed' : 'opted out'} on file. The agent will stop
                on sight whatever the flag below says.
              </p>
            )}
          </Group>

          <Group label="Segment">
            <Segmented
              options={(options?.segments ?? []).map((s) => ({
                value: s, label: SEGMENT_LABELS[s] ?? s,
              }))}
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

          <Group label="Decline code">
            <select
              value={declineCode}
              onChange={(e) => setDeclineCode(e.target.value)}
              className={fieldClass}
            >
              {options?.declineCodes.map((d) => (
                <option key={d.code} value={d.code}>{d.label}</option>
              ))}
            </select>
          </Group>

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

          <div className="pt-1 flex gap-2">
            <button
              type="submit"
              disabled={!canRun}
              className="flex-1 rounded-md bg-accent text-white text-sm font-medium py-2 disabled:opacity-40 disabled:cursor-not-allowed hover:opacity-90 transition-opacity"
            >
              {running ? 'Running…' : events.length ? 'Run again' : 'Run through the agent'}
            </button>
            {running && (
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
            <p className="text-xs text-muted">Give a name, or pick an existing customer.</p>
          )}

          {options && (
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
          {!meta && !running && !error && <EmptyState />}
          <LiveStages meta={meta} events={events} working={working} error={error} />
        <div ref={tailRef} />
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
