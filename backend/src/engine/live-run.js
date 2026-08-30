/**
 * The live simulator.
 *
 * One hand-entered failed payment, pushed through the same engine the 80-case
 * batch runs on, revealed a stage at a time so the agent can be watched working
 * rather than read about afterwards.
 *
 * Two rules shape everything here:
 *
 *   1. Nothing is re-implemented. The classifier, the intervention matrix, the
 *      compliance gates, the outcome simulator, the scorer and the LLM narrator
 *      are all imported and called exactly as `npm run simulate` and
 *      `npm run narrate` call them. This module only assembles the inputs and
 *      reads the results back out.
 *
 *   2. Nothing is persisted. The runner writes as it goes, so it is handed a
 *      throwaway in-memory database. The real book is read — for the priors the
 *      score is measured against and for the customer roster — and never
 *      written. A demo run cannot move the dashboard's numbers.
 *
 * The stage order is not cosmetic. Stages 1–3 are pure rules: a lookup table, a
 * weighted blend of counted rates, and a decision matrix. No model is consulted.
 * Stage 4 is the only point at which the LLM runs, and by then the decision it
 * is describing is already a row in a database. That separation is the whole
 * design, and running it live is the clearest way to show it.
 */

import { createScratchDb } from '../db/index.js';
import { makeRandom } from '../lib/rng.js';
import { iso, formatIst } from '../lib/time.js';
import { DECLINE_CODES, POLICY } from '../lib/taxonomy.js';
import { PLANS, INVOICE_ITEMS } from '../data/catalog.js';
import { createRunner } from './runner.js';
import { BUCKETS } from './classifier.js';
import { ACTION_LABELS } from './matrix.js';
import { STOP_REASONS } from './policy.js';
import { buildPriors, buildCustomerHistory } from './priors.js';
import { scoreCase } from './scorer.js';
import { buildTimeline } from './timeline.js';
import {
  makeClient, buildCasePayload, narrateCase, credentialsPresent, PROVIDER, MODEL,
} from './llm-narrator.js';

const DAY = 86400000;

/**
 * How far back the simulated failure is placed.
 *
 * The engine schedules real interventions into the future — a card-update
 * reminder on day 3, an invoice escalation on day 30 — and stops at the first
 * one that has not come due, reporting the case as still in flight. A failure
 * stamped "just now" would therefore always end at "scheduled, not yet due" and
 * never reach an outcome, which is the one thing this panel exists to show. So
 * the failure is back-dated far enough for the entire sequence to have run,
 * including a promise-to-pay date up to 12 days after the last action.
 */
const LEAD_DAYS = { invoice: 50, subscription: 24 };

/** Reliability priors per segment, for a customer typed in rather than picked. */
const DEFAULT_RELIABILITY = { consumer: 0.62, prosumer: 0.7, smb: 0.72, enterprise: 0.78 };
const DEFAULT_CHANNEL = { consumer: 'whatsapp', prosumer: 'whatsapp', smb: 'email', enterprise: 'email' };
const DEFAULT_LTV = { consumer: 4200, prosumer: 22000, smb: 145000, enterprise: 1850000 };

export const SEGMENTS = ['consumer', 'prosumer', 'smb', 'enterprise'];
export const HARD_STOP_FLAGS = ['none', 'opted_out', 'disputed'];

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export class InvalidInput extends Error {}

/**
 * Validate and normalise what the form sent. Everything the engine touches is
 * derived here, so an out-of-range value is rejected once rather than producing
 * a plausible-looking case built on nonsense.
 */
export function parseInput(body = {}) {
  const bad = (msg) => { throw new InvalidInput(msg); };

  const declineCode = String(body.declineCode ?? '');
  if (!DECLINE_CODES[declineCode]) bad(`Unknown decline code: ${declineCode || '(none)'}`);

  const segment = String(body.segment ?? '');
  if (!SEGMENTS.includes(segment)) bad(`Unknown segment: ${segment || '(none)'}`);

  const amountInr = Math.round(Number(body.amountInr));
  if (!Number.isFinite(amountInr) || amountInr < 1 || amountInr > 100_000_000) {
    bad('Amount must be between ₹1 and ₹10,00,00,000.');
  }

  // 0 through 3. Three is the cap itself: a case that opens with all three
  // interventions already spent is stopped before the agent does anything.
  const attemptsUsed = Number(body.attemptsUsed);
  if (!Number.isInteger(attemptsUsed) || attemptsUsed < 0 || attemptsUsed > POLICY.MAX_ATTEMPTS_PER_CASE) {
    bad(`attemptsUsed must be 0–${POLICY.MAX_ATTEMPTS_PER_CASE}.`);
  }

  const hardStop = body.hardStop == null || body.hardStop === 'none' ? null : String(body.hardStop);
  if (hardStop && !['opted_out', 'disputed'].includes(hardStop)) bad(`Unknown hard stop: ${hardStop}`);

  const customerId = body.customerId ? String(body.customerId) : null;
  const customerName = String(body.customerName ?? '').trim().slice(0, 80);
  if (!customerId && !customerName) bad('Give a customer name, or pick an existing customer.');

  return {
    customerId, customerName, segment, amountInr, declineCode, attemptsUsed, hardStop,
    seed: Number.isFinite(Number(body.seed)) && Number(body.seed) > 0
      ? Math.floor(Number(body.seed))
      : Date.now() % 2147483647,
  };
}

// ---------------------------------------------------------------------------
// Building the world this case lives in
// ---------------------------------------------------------------------------

/** Stable-ish pick so the same customer keeps the same plan between runs. */
const hash = (s) => [...s].reduce((n, ch) => (n * 31 + ch.charCodeAt(0)) >>> 0, 7);

function buildCustomer(realDb, input, now) {
  const existing = input.customerId
    ? realDb.prepare('SELECT * FROM customers WHERE id = ?').get(input.customerId)
    : null;
  if (input.customerId && !existing) throw new InvalidInput(`No such customer: ${input.customerId}`);

  const segment = input.segment;
  const name = existing?.name ?? input.customerName;
  const first = name.split(' ')[0].toLowerCase();

  const customer = existing
    // The segment is whatever the form says even for a real customer: being
    // able to ask "what would the agent do if this were an enterprise account?"
    // is the point of a control panel.
    ? { ...existing, segment }
    : {
        id: `cust_live_${hash(name).toString(36)}`,
        name,
        segment,
        phone: `+9198${String(hash(name) % 90000000 + 10000000)}`,
        email: segment === 'enterprise' ? `ap@${first}.co.in` : `${first}@example.com`,
        reliability_score: DEFAULT_RELIABILITY[segment],
        lifetime_value_inr: DEFAULT_LTV[segment],
        timezone: 'Asia/Kolkata',
        salary_day: segment === 'enterprise' ? null : 1,
        preferred_channel: DEFAULT_CHANNEL[segment],
        opted_out_at: null,
        disputed_at: null,
        created_at: iso(now - 400 * DAY),
      };

  // The flag adds a hard stop; it never clears one already on the real record.
  // A customer who genuinely opted out stays opted out whatever the form says.
  if (input.hardStop === 'opted_out' && !customer.opted_out_at) {
    customer.opted_out_at = iso(now - 30 * DAY);
  }
  if (input.hardStop === 'disputed' && !customer.disputed_at) {
    customer.disputed_at = iso(now - 30 * DAY);
  }

  return { customer, existing: Boolean(existing) };
}

/**
 * The failure itself, plus whatever it was a payment for.
 *
 * An overdue invoice is anchored on its due date rather than on the moment AP
 * noticed, because the reminder sequence counts days past due — the matrix reads
 * `invoice.due_at`, so getting this wrong would silently shift every reminder.
 */
function buildFailure(customer, input, now) {
  const meta = DECLINE_CODES[input.declineCode];
  const isInvoice = input.declineCode === 'invoice_overdue';
  const isCheckout = input.declineCode === 'abandoned_checkout';
  const h = hash(customer.name + input.declineCode);

  if (isInvoice) {
    const dueAt = now - LEAD_DAYS.invoice * DAY;
    const failedAt = dueAt + 3 * DAY; // AP flags it a few days after the due date
    const daysOverdue = Math.floor((now - dueAt) / DAY);
    const invoice = {
      id: 'inv_live_0001',
      customer_id: customer.id,
      invoice_number: `RZP/2026/${String(9000 + (h % 900))}`,
      amount_inr: input.amountInr,
      issued_at: iso(dueAt - 30 * DAY),
      due_at: iso(dueAt),
      status: 'overdue',
      po_number: `PO-${100000 + (h % 900000)}`,
    };
    return {
      invoice,
      subscription: null,
      item: `${invoice.invoice_number} · ${INVOICE_ITEMS[h % INVOICE_ITEMS.length]}`,
      attempt: {
        id: 'pay_live_0001',
        customer_id: customer.id,
        subscription_id: null,
        invoice_id: invoice.id,
        amount_inr: input.amountInr,
        status: 'failed',
        decline_code: input.declineCode,
        gateway_message: `Invoice ${invoice.invoice_number} is ${daysOverdue} days past due — no payment received`,
        attempt_number: 1,
        channel: 'invoice_link',
        created_at: iso(failedAt),
      },
    };
  }

  const failedAt = now - LEAD_DAYS.subscription * DAY;
  // Enterprises have no consumer plan list; give them something plausible to
  // be billed for so the outreach copy has a subject other than "your payment".
  const plans = PLANS[customer.segment] ?? [{ name: 'Platform subscription' }];
  const subscription = {
    id: 'sub_live_0001',
    customer_id: customer.id,
    plan_name: plans[h % plans.length].name,
    amount_inr: input.amountInr,
    frequency: 'monthly',
    status: isCheckout ? 'pending' : 'past_due',
    mandate_type: 'card',
    started_at: iso(failedAt - 200 * DAY),
    next_billing_at: iso(now + 10 * DAY),
  };

  return {
    subscription,
    invoice: null,
    item: subscription.plan_name,
    attempt: {
      id: 'pay_live_0001',
      customer_id: customer.id,
      subscription_id: subscription.id,
      invoice_id: null,
      amount_inr: input.amountInr,
      status: 'failed',
      decline_code: input.declineCode,
      gateway_message: meta.gatewayMessages[h % meta.gatewayMessages.length],
      // The gateway's own retries, not the agent's. Left at one so the form's
      // attempt selector means only what it says: the agent's own escalation.
      attempt_number: 1,
      channel: isCheckout ? 'checkout' : 'autopay',
      created_at: iso(failedAt),
    },
  };
}

const insert = (db, table, row) => {
  const cols = Object.keys(row);
  db.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map((c) => '@' + c).join(',')})`)
    .run(row);
};

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

const HARD_STOP_REASONS = new Set([
  'customer_opted_out', 'customer_disputed', 'opted_out_mid_recovery', 'disputed_mid_recovery',
]);

/** Which of the three stopping rules ended this case, if any. */
function stopKind(reason) {
  if (!reason) return null;
  if (HARD_STOP_REASONS.has(reason)) return 'hard_stop';
  if (reason === 'max_attempts_reached') return 'attempt_cap';
  if (reason === 'sequence_exhausted') return 'sequence_exhausted';
  return null;
}

/**
 * Run one case and yield it back a stage at a time.
 *
 * An async generator rather than a callback: the route only has to forward what
 * it is given, and the one genuinely slow step — the model call at stage 4 —
 * simply awaits in the middle of the sequence, so the pause the viewer sees is
 * the real one.
 *
 * @param {object} realDb  the live book. Read for priors and customers, never written.
 * @param {object} input   from parseInput()
 * @param {(ms:number)=>Promise<void>} pause  the beat between stages
 */
export async function* runLive(realDb, input, { pause = () => Promise.resolve(), now = Date.now() } = {}) {
  const { customer, existing } = buildCustomer(realDb, input, now);
  const { attempt, subscription, invoice, item } = buildFailure(customer, input, now);

  // -- Run the real engine, on a database that gets thrown away --------------
  const scratch = createScratchDb();
  insert(scratch, 'customers', customer);
  if (subscription) insert(scratch, 'subscriptions', subscription);
  if (invoice) insert(scratch, 'invoices', invoice);
  insert(scratch, 'payment_attempts', attempt);

  const rand = makeRandom(input.seed);
  const runner = createRunner({ db: scratch, rand, now });
  const caseRow = runner.runCase({
    attempt, customer, subscription, invoice, attemptsUsed: input.attemptsUsed,
  });

  const auditRows = scratch.prepare(
    'SELECT * FROM audit_entries WHERE case_id = ? ORDER BY sequence').all(caseRow.id);
  const interventions = scratch.prepare(
    'SELECT * FROM intervention_logs WHERE case_id = ? ORDER BY sequence').all(caseRow.id);
  const promises = scratch.prepare(
    'SELECT * FROM promises_to_pay WHERE case_id = ? ORDER BY created_at').all(caseRow.id);
  const timeline = buildTimeline(auditRows, interventions);

  const opened = timeline.find((e) => e.event_type === 'case_opened');
  const classified = timeline.find((e) => e.event_type === 'root_cause_classified');

  yield {
    type: 'meta',
    seed: input.seed,
    now: iso(now),
    customer: {
      id: customer.id, name: customer.name, segment: customer.segment,
      existing,
      reliability_score: customer.reliability_score,
      preferred_channel: customer.preferred_channel,
      salary_day: customer.salary_day,
      opted_out_at: customer.opted_out_at,
      disputed_at: customer.disputed_at,
    },
    failure: {
      amountInr: attempt.amount_inr,
      declineCode: attempt.decline_code,
      declineLabel: DECLINE_CODES[attempt.decline_code].label,
      gatewayMessage: attempt.gateway_message,
      failedAt: attempt.created_at,
      failedAtLabel: formatIst(attempt.created_at),
      channel: attempt.channel,
      item,
      invoiceDueAt: invoice?.due_at ?? null,
      // Say plainly why the failure is dated in the past, so nobody has to
      // wonder whether the panel is showing them stale data.
      backdatedDays: Math.round((now - new Date(attempt.created_at).getTime()) / DAY),
    },
    startingAttemptsUsed: input.attemptsUsed,
    maxAttempts: POLICY.MAX_ATTEMPTS_PER_CASE,
    detection: opened?.reasoning_text ?? null,
  };

  // -- 1. Diagnose ----------------------------------------------------------
  yield { type: 'working', stage: 'diagnose', label: 'Diagnosing…' };
  await pause(750);
  const bucket = BUCKETS[caseRow.root_cause];
  yield {
    type: 'stage',
    stage: 'diagnose',
    rootCause: caseRow.root_cause,
    label: bucket?.label ?? caseRow.root_cause,
    summary: bucket?.summary ?? null,
    confidence: caseRow.root_cause_confidence,
    reasoning: classified?.reasoning_text ?? null,
    source: 'rules',
  };

  // -- 2. Score -------------------------------------------------------------
  yield { type: 'working', stage: 'score', label: 'Calculating recovery likelihood…' };
  await pause(750);
  const priors = buildPriors(realDb);
  const history = buildCustomerHistory(realDb).get(customer.id);
  const scored = scoreCase({
    // A distinct id keeps this case out of its own customer's history, which is
    // matched on id — and cannot collide with a real case in the book.
    caseRow: { ...caseRow, id: `live_${input.seed}` },
    customer,
    priors,
    history,
    // Score the case as it stands *now*, before the agent acts: with k
    // interventions already spent, not with the count it ended on.
    attemptIndex: input.attemptsUsed,
  });
  yield {
    type: 'stage',
    stage: 'score',
    score: Number(scored.score.toFixed(4)),
    band: scored.band.label,
    explanation: scored.explanation,
    factors: scored.factors,
    isOverride: scored.factors.some((f) => f.kind === 'override'),
    priors: {
      globalRate: priors.globalRate,
      sampleSize: priors.sampleSize,
      rootCause: priors.byRootCause[caseRow.root_cause] ?? null,
      segment: priors.bySegment[customer.segment] ?? null,
      attempt: priors.byAttempt[Math.min(input.attemptsUsed, 2)] ?? null,
    },
    source: 'rules',
  };

  // -- The stop that happens before any action ------------------------------
  // Nothing after this point runs: no intervention is chosen, no message is
  // written, no outcome is rolled. Saying so is the whole demonstration.
  const preStop = timeline.find((e) => e.event_type === 'case_stopped');
  const stoppedBeforeActing = preStop && interventions.length === 0;

  if (stoppedBeforeActing) {
    yield { type: 'working', stage: 'decide', label: 'Deciding recovery action…' };
    await pause(750);
    yield {
      type: 'stopped',
      atStage: 'decide',
      reason: caseRow.closure_reason,
      kind: stopKind(caseRow.closure_reason),
      label: STOP_REASONS[caseRow.closure_reason] ?? caseRow.closure_reason,
      reasoning: preStop.reasoning_text,
      skipped: ['respond', 'outcome'],
    };
  } else {
    // -- 3/4/5, once per intervention the agent actually ran ----------------
    let narration = null;
    let narrator = { provider: PROVIDER, model: MODEL, used: 'template', note: null };

    for (const round of rounds(timeline)) {
      // 3. Decide
      yield { type: 'working', stage: 'decide', label: 'Deciding recovery action…' };
      await pause(700);
      const iv = round.selected.intervention;
      yield {
        type: 'stage',
        stage: 'decide',
        attemptNumber: round.selected.attemptNumber,
        maxAttempts: POLICY.MAX_ATTEMPTS_PER_CASE,
        actionType: iv?.action_type ?? null,
        actionLabel: ACTION_LABELS[iv?.action_type] ?? iv?.action_type ?? null,
        channel: iv?.channel ?? null,
        tone: iv?.tone ?? null,
        silent: iv?.channel === 'none',
        scheduledFor: iv?.scheduled_for ?? null,
        scheduledForLabel: iv?.scheduled_for ? formatIst(iv.scheduled_for) : null,
        reasoning: round.selected.reasoning_text,
        deferral: round.deferred
          ? { reasoning: round.deferred.reasoning_text, at: round.deferred.created_at }
          : null,
        source: 'rules',
      };

      // 4. Narrate. The first round pays the real model latency; the call
      //    covers the whole case, so later rounds already have their text.
      yield {
        type: 'working',
        stage: 'respond',
        label: narration === null ? 'Generating response…' : 'Drafting the message…',
      };
      if (narration === null) {
        const out = await narrateLive({ caseRow, customer, attempt, subscription, invoice,
          audit: auditRows, interventions });
        narration = out.narration;
        narrator = { ...narrator, ...out.narrator };
      } else {
        await pause(600);
      }

      const llmReasoning = narration.audit.get(round.selected.sequence) ?? null;
      const llmMessage = iv ? narration.messages.get(iv.sequence) ?? null : null;
      yield {
        type: 'stage',
        stage: 'respond',
        attemptNumber: round.selected.attemptNumber,
        narrator,
        // The template text is the factual record the model was handed; showing
        // both makes it checkable that the model described the decision rather
        // than making one.
        reasoning: llmReasoning ?? round.selected.reasoning_text,
        reasoningSource: llmReasoning ? 'llm' : 'template',
        templateReasoning: round.selected.reasoning_text,
        channel: iv?.channel ?? null,
        silent: iv?.channel === 'none',
        message: iv?.channel === 'none' ? null : llmMessage ?? iv?.message_sent ?? null,
        source: 'llm',
      };

      // 5. Outcome
      if (!round.outcome) continue;
      yield { type: 'working', stage: 'outcome', label: 'Waiting on the customer…' };
      await pause(800);
      const oiv = round.outcome.intervention;
      yield {
        type: 'stage',
        stage: 'outcome',
        attemptNumber: round.outcome.attemptNumber,
        outcome: oiv?.outcome ?? null,
        detail: oiv?.outcome_detail ?? null,
        reasoning: narration.audit.get(round.outcome.sequence) ?? round.outcome.reasoning_text,
        at: oiv?.executed_at ?? null,
        atLabel: oiv?.executed_at ? formatIst(oiv.executed_at) : null,
        source: 'simulated',
      };

      for (const e of round.after) {
        yield {
          type: 'note',
          event: e.event_type,
          reasoning: narration.audit.get(e.sequence) ?? e.reasoning_text,
          at: e.created_at,
        };
      }
    }

    if (caseRow.status === 'stopped') {
      const stop = [...timeline].reverse().find((e) => e.event_type === 'case_stopped');
      yield {
        type: 'stopped',
        atStage: 'final',
        reason: caseRow.closure_reason,
        kind: stopKind(caseRow.closure_reason),
        label: STOP_REASONS[caseRow.closure_reason] ?? caseRow.closure_reason,
        reasoning: narration.audit.get(stop?.sequence) ?? stop?.reasoning_text ?? null,
        skipped: [],
      };
    }
  }

  // -- Final ----------------------------------------------------------------
  await pause(500);
  yield {
    type: 'final',
    status: caseRow.status,
    closureReason: caseRow.closure_reason,
    closureKind: stopKind(caseRow.closure_reason),
    attemptsUsed: caseRow.attempts_used,
    startingAttemptsUsed: input.attemptsUsed,
    amountAtRiskInr: caseRow.amount_at_risk_inr,
    recoveredInr: caseRow.recovered_amount_inr,
    openedAt: caseRow.opened_at,
    closedAt: caseRow.closed_at,
    closedAtLabel: caseRow.closed_at ? formatIst(caseRow.closed_at) : null,
    interventionsRun: interventions.filter((i) => i.executed_at).length,
    promises: promises.map((p) => ({
      promisedDate: p.promised_date, promisedDateLabel: formatIst(p.promised_date),
      amountInr: p.promised_amount_inr, fulfilled: Boolean(p.fulfilled),
    })),
    seed: input.seed,
  };
}

/**
 * Group the timeline into one entry per intervention: the decision, the
 * quiet-hours deferral that preceded it if there was one, its outcome, and any
 * promise-to-pay bookkeeping that followed before the next decision.
 */
function rounds(timeline) {
  const out = [];
  let pendingDeferral = null;

  for (const e of timeline) {
    switch (e.event_type) {
      case 'quiet_hours_deferred':
        pendingDeferral = e;
        break;
      case 'intervention_selected':
        out.push({ selected: e, deferred: pendingDeferral, outcome: null, after: [] });
        pendingDeferral = null;
        break;
      case 'outcome_recorded':
        if (out.length) out.at(-1).outcome = e;
        break;
      case 'promise_recorded':
      case 'promise_kept':
      case 'promise_broken':
        if (out.length) out.at(-1).after.push(e);
        break;
      default:
        break;
    }
  }
  return out;
}

/**
 * Narrate the finished case with the same model call `npm run narrate` makes.
 *
 * Failure is not fatal and never should be: the run already happened and the
 * template narrator already wrote every reasoning string and every message. A
 * missing key or a rate limit costs the prose, not the demo — but the panel is
 * told which one it got, because "Claude wrote this" has to be true when the UI
 * says it.
 */
async function narrateLive(bundle) {
  const empty = { audit: new Map(), messages: new Map() };

  if (!credentialsPresent()) {
    return {
      narration: empty,
      narrator: {
        used: 'template',
        note: `No ${PROVIDER} API key set — showing the deterministic template narration, `
          + 'which is the same fallback the batch uses.',
      },
    };
  }

  try {
    const client = await makeClient();
    const { parsed } = await narrateCase(client, buildCasePayload(bundle));
    return {
      narration: {
        audit: new Map(parsed.audit
          .filter((a) => a.reasoning?.trim())
          .map((a) => [a.sequence, a.reasoning.trim()])),
        messages: new Map(parsed.messages
          .filter((m) => m.body?.trim())
          .map((m) => [m.sequence, m.subject?.trim()
            ? `Subject: ${m.subject.trim()}\n\n${m.body.trim()}`
            : m.body.trim()])),
      },
      narrator: { used: 'llm', note: null },
    };
  } catch (err) {
    return {
      narration: empty,
      narrator: {
        used: 'template',
        note: `${PROVIDER} narration failed (${err.message}) — falling back to the template `
          + 'narrator, exactly as the batch does.',
      },
    };
  }
}
