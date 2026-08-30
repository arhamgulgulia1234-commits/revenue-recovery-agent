/**
 * The agent loop.
 *
 * For one failed payment: open a case, classify it, then repeatedly select →
 * screen → execute → record an intervention until the case recovers, hits a
 * stopping rule, or runs out of scheduled time.
 *
 * Cases are processed in chronological order of failure so that a customer who
 * opts out mid-recovery is already flagged when their *next* case comes up —
 * the opt-out attaches to the customer, not the case.
 */

import { POLICY } from '../lib/taxonomy.js';
import { iso } from '../lib/time.js';
import { classify } from './classifier.js';
import { decideIntervention } from './matrix.js';
import { screen, STOP_REASONS } from './policy.js';
import { simulateOutcome, simulatePromiseKept } from './outcomes.js';
import { templateNarrator } from './narrator.js';

const DAY = 86400000;
const HOUR = 3600000;

export function createRunner({ db, rand, narrator = templateNarrator, now = Date.now() }) {
  const ids = { case: 0, log: 0, audit: 0, promise: 0 };
  const nextId = (k, prefix) => `${prefix}_${String(++ids[k]).padStart(4, '0')}`;

  const stmt = {
    insertCase: db.prepare(`
      INSERT INTO recovery_cases (id,payment_attempt_id,customer_id,case_type,root_cause,
        root_cause_confidence,amount_at_risk_inr,status,attempts_used,opened_at,closed_at,
        closure_reason,recovered_amount_inr)
      VALUES (@id,@payment_attempt_id,@customer_id,@case_type,@root_cause,@root_cause_confidence,
        @amount_at_risk_inr,@status,@attempts_used,@opened_at,@closed_at,@closure_reason,
        @recovered_amount_inr)`),
    updateCase: db.prepare(`
      UPDATE recovery_cases SET status=@status, attempts_used=@attempts_used, closed_at=@closed_at,
        closure_reason=@closure_reason, recovered_amount_inr=@recovered_amount_inr,
        root_cause=@root_cause, root_cause_confidence=@root_cause_confidence WHERE id=@id`),
    insertLog: db.prepare(`
      INSERT INTO intervention_logs (id,case_id,sequence,action_type,channel,tone,message_sent,
        scheduled_for,executed_at,outcome,outcome_detail)
      VALUES (@id,@case_id,@sequence,@action_type,@channel,@tone,@message_sent,@scheduled_for,
        @executed_at,@outcome,@outcome_detail)`),
    insertAudit: db.prepare(`
      INSERT INTO audit_entries (id,case_id,sequence,event_type,decision,reasoning_text,
        reasoning_source,policy_refs,created_at)
      VALUES (@id,@case_id,@sequence,@event_type,@decision,@reasoning_text,@reasoning_source,
        @policy_refs,@created_at)`),
    insertPromise: db.prepare(`
      INSERT INTO promises_to_pay (id,case_id,promised_date,promised_amount_inr,captured_via,
        fulfilled,created_at)
      VALUES (@id,@case_id,@promised_date,@promised_amount_inr,@captured_via,@fulfilled,@created_at)`),
    flagCustomer: db.prepare(
      `UPDATE customers SET opted_out_at=COALESCE(opted_out_at,@opted), disputed_at=COALESCE(disputed_at,@disputed) WHERE id=@id`),
  };

  /**
   * Process one failed payment attempt end to end.
   *
   * `attemptsUsed` is how many interventions this case has already spent — 0 for
   * everything in the batch, since the batch opens every case from scratch. The
   * live simulator sets it higher to start a case mid-sequence, which is also
   * the only way to reach the attempt cap at pre-screen rather than after the
   * loop has run.
   */
  function runCase({ attempt, customer, subscription, invoice, attemptsUsed: startAttempts = 0 }) {
    const caseId = nextId('case', 'case');
    const openedAt = new Date(attempt.created_at).getTime();
    let auditSeq = 0;

    const ctx = { customer, attempt, subscription, invoice, caseId };

    const audit = (eventType, decision, extra = {}, at = openedAt) => {
      stmt.insertAudit.run({
        id: nextId('audit', 'audit'),
        case_id: caseId,
        sequence: ++auditSeq,
        event_type: eventType,
        decision,
        reasoning_text: narrator.reason(eventType, { ...ctx, ...extra }),
        reasoning_source: narrator.source,
        policy_refs: extra.policyRefs ?? null,
        created_at: iso(at),
      });
    };

    const caseRow = {
      id: caseId,
      payment_attempt_id: attempt.id,
      customer_id: customer.id,
      case_type: invoice ? 'b2b_invoice' : attempt.channel === 'checkout' ? 'checkout' : 'subscription',
      root_cause: null,
      root_cause_confidence: null,
      amount_at_risk_inr: attempt.amount_inr,
      status: 'open',
      attempts_used: startAttempts,
      opened_at: iso(openedAt),
      closed_at: null,
      closure_reason: null,
      recovered_amount_inr: 0,
    };
    stmt.insertCase.run(caseRow);
    audit('case_opened', 'Revenue at risk detected — case opened');

    // -- Diagnose ------------------------------------------------------------
    const classification = classify(attempt);
    caseRow.root_cause = classification.bucket;
    caseRow.root_cause_confidence = classification.confidence;
    ctx.classification = classification;
    stmt.updateCase.run(caseRow);
    audit('root_cause_classified', `Root cause: ${classification.bucket}`, { classification });

    const closeWith = (status, reason, recovered = 0, closedAt = now) => {
      caseRow.status = status;
      caseRow.closure_reason = reason;
      caseRow.recovered_amount_inr = recovered;
      caseRow.closed_at = iso(closedAt);
      stmt.updateCase.run(caseRow);
    };

    // -- Hard stops, before any action ---------------------------------------
    const preScreen = screen({ customer, attemptsUsed: startAttempts, proposed: { scheduledFor: openedAt, silent: true }, asOf: openedAt });
    if (!preScreen.allowed) {
      closeWith('stopped', preScreen.stop.reason, 0, openedAt);
      audit('case_stopped', `Stopped — ${STOP_REASONS[preScreen.stop.reason]}`,
        { stop: preScreen.stop, caseRow,
          // A case that opens already at the cap stops for the cap, not for a
          // hard stop — the two are counted separately everywhere downstream.
          policyRefs: preScreen.stop.reason === 'max_attempts_reached' ? 'attempt_cap' : 'hard_stop' },
        openedAt);
      return caseRow;
    }

    // Invoice reminder days are counted from the due date, not from when AP
    // noticed — "day 7" has to mean 7 days past due to mean anything.
    const anchor = invoice ? new Date(invoice.due_at).getTime() : openedAt;

    let attemptsUsed = startAttempts;
    let lastActionAt = openedAt;
    caseRow.status = 'in_progress';

    while (attemptsUsed < POLICY.MAX_ATTEMPTS_PER_CASE) {
      const proposed = decideIntervention({
        bucket: classification.bucket,
        attemptIndex: attemptsUsed,
        customer, attempt, caseOpenedAt: anchor,
      });

      if (!proposed) {
        closeWith('stopped', 'sequence_exhausted', 0, lastActionAt);
        audit('case_stopped', 'Stopped — no further intervention available',
          { stop: { reason: 'sequence_exhausted' }, caseRow, policyRefs: 'sequence_exhausted' }, lastActionAt);
        return caseRow;
      }

      const gates = screen({ customer, attemptsUsed, proposed, asOf: lastActionAt });
      if (!gates.allowed) {
        closeWith('stopped', gates.stop.reason, 0, lastActionAt);
        audit('case_stopped', `Stopped — ${STOP_REASONS[gates.stop.reason]}`,
          { stop: gates.stop, caseRow, policyRefs: 'attempt_cap' }, lastActionAt);
        return caseRow;
      }

      // Never schedule an action before the previous one finished.
      const scheduledFor = Math.max(gates.scheduledFor, lastActionAt + HOUR);
      const action = { ...proposed, scheduledFor };
      ctx.attemptIndex = attemptsUsed;

      if (gates.deferral) {
        audit('quiet_hours_deferred', 'Outreach deferred out of quiet hours',
          { action, deferral: gates.deferral, policyRefs: 'quiet_hours' }, proposed.scheduledFor);
      }

      audit('intervention_selected',
        `Selected ${action.actionType}${action.silent ? '' : ` via ${action.channel}`}`,
        { action, classification }, scheduledFor);

      // -- Not due yet: the case is genuinely still in flight ----------------
      if (scheduledFor > now) {
        stmt.insertLog.run({
          id: nextId('log', 'ilog'), case_id: caseId, sequence: attemptsUsed + 1,
          action_type: action.actionType, channel: action.channel, tone: action.tone,
          message_sent: action.silent ? null : renderMessage(narrator, action, ctx),
          scheduled_for: iso(scheduledFor), executed_at: null,
          outcome: null, outcome_detail: 'Scheduled — not yet due',
        });
        caseRow.attempts_used = attemptsUsed;
        caseRow.status = 'in_progress';
        stmt.updateCase.run(caseRow);
        return caseRow;
      }

      // -- Execute -----------------------------------------------------------
      const messageText = action.silent ? null : renderMessage(narrator, action, ctx);
      const outcome = simulateOutcome({
        bucket: classification.bucket, action, customer,
        attemptIndex: attemptsUsed, amountInr: attempt.amount_inr, rand,
      });

      attemptsUsed += 1;
      caseRow.attempts_used = attemptsUsed;
      lastActionAt = scheduledFor;

      stmt.insertLog.run({
        id: nextId('log', 'ilog'), case_id: caseId, sequence: attemptsUsed,
        action_type: action.actionType, channel: action.channel, tone: action.tone,
        message_sent: messageText, scheduled_for: iso(scheduledFor),
        executed_at: iso(scheduledFor), outcome: outcome.outcome, outcome_detail: outcome.detail,
      });
      audit('outcome_recorded', `Outcome: ${outcome.outcome}`, { action, outcome }, scheduledFor);

      // -- React to the outcome ---------------------------------------------
      if (outcome.outcome === 'recovered') {
        closeWith('recovered', 'payment_recovered', attempt.amount_inr, scheduledFor);
        audit('case_recovered', 'Case closed — recovered', { caseRow }, scheduledFor);
        return caseRow;
      }

      if (outcome.triggeredHardStop) {
        // The opt-out attaches to the customer, so it also protects future cases.
        stmt.flagCustomer.run({
          id: customer.id,
          opted: outcome.triggeredHardStop === 'customer_opted_out' ? iso(scheduledFor) : null,
          disputed: outcome.triggeredHardStop === 'customer_disputed' ? iso(scheduledFor) : null,
        });
        customer[outcome.triggeredHardStop === 'customer_opted_out' ? 'opted_out_at' : 'disputed_at'] = iso(scheduledFor);
        const reason = outcome.triggeredHardStop === 'customer_opted_out'
          ? 'opted_out_mid_recovery' : 'disputed_mid_recovery';
        closeWith('stopped', reason, 0, scheduledFor);
        audit('case_stopped', `Stopped — ${outcome.detail}`,
          { stop: { reason }, caseRow, policyRefs: 'hard_stop' }, scheduledFor);
        return caseRow;
      }

      if (outcome.outcome === 'promise_to_pay') {
        const promisedDate = scheduledFor + rand.int(3, 12) * DAY;
        const promise = {
          id: nextId('promise', 'ptp'), case_id: caseId,
          promised_date: iso(promisedDate), promised_amount_inr: attempt.amount_inr,
          captured_via: action.channel, fulfilled: 0, created_at: iso(scheduledFor),
        };
        stmt.insertPromise.run(promise);
        audit('promise_recorded', 'Promise to pay captured', { promise, action }, scheduledFor);

        if (promisedDate > now) {
          caseRow.status = 'promise_to_pay';
          stmt.updateCase.run(caseRow);
          return caseRow;
        }

        const { kept } = simulatePromiseKept({ customer, rand });
        if (kept) {
          db.prepare('UPDATE promises_to_pay SET fulfilled = 1 WHERE id = ?').run(promise.id);
          closeWith('recovered', 'promise_kept', attempt.amount_inr, promisedDate);
          audit('promise_kept', 'Promise honoured — case closed', { caseRow }, promisedDate);
          return caseRow;
        }
        audit('promise_broken', 'Promised date passed with no payment', { caseRow }, promisedDate);
        lastActionAt = promisedDate;
      }
      // Otherwise: failed or no_response — loop to the next intervention.
    }

    // Cap reached with no recovery.
    closeWith('stopped', 'max_attempts_reached', 0, lastActionAt);
    audit('case_stopped', 'Stopped — attempt cap reached',
      { stop: { reason: 'max_attempts_reached' }, caseRow, policyRefs: 'attempt_cap' }, lastActionAt);
    return caseRow;
  }

  return { runCase };
}

function renderMessage(narrator, action, ctx) {
  const drafted = narrator.message(action, ctx);
  if (!drafted) return null;
  return drafted.subject ? `Subject: ${drafted.subject}\n\n${drafted.body}` : drafted.body;
}
