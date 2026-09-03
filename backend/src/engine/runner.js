/**
 * The agent loop.
 *
 * For one failed payment: open a case, classify it, then step it forward until
 * it recovers, hits a stopping rule, or reaches a point where the only correct
 * thing to do is wait.
 *
 * ## Waiting is a state, not a pause
 *
 * The engine used to select, send and resolve every intervention in one
 * uninterrupted pass, which quietly meant a case that got no reply burned all
 * three attempts in the same instant and closed as failed. That is not three
 * attempts; it is one attempt reported three times.
 *
 * So sending is now separated from learning the result. An outreach that goes
 * out opens a response window — POLICY.RESPONSE_WINDOW_DAYS long, with a real
 * expiry timestamp — and the case parks in `awaiting_response` until either a
 * payment arrives before the deadline or the deadline passes. Only then does the
 * agent decide whether to escalate to the next intervention or stop.
 *
 * Silent retries have no window. Nobody is being asked to respond and the
 * gateway answers immediately, so they execute and resolve in the same step.
 *
 * ## Resumable
 *
 * Everything the loop needs to pick a case back up — which intervention it is
 * waiting on, when that wait expires, when to look again — lives in columns on
 * `recovery_cases`, not in this module's local variables. `advanceCase()` can
 * therefore continue any case from the database alone, which is what lets
 * scheduler.js sweep the book on a timer and the case route advance one case on
 * view. `runCase()` is the same machine driven from a standing start.
 *
 * Cases are processed in chronological order of failure so that a customer who
 * opts out mid-recovery is already flagged when their *next* case comes up —
 * the opt-out attaches to the customer, not the case.
 */

import { POLICY } from '../lib/taxonomy.js';
import { iso } from '../lib/time.js';
import { makeRandom } from '../lib/rng.js';
import { classify } from './classifier.js';
import { decideIntervention } from './matrix.js';
import { screen, checkAttemptCap, checkHardStop, STOP_REASONS } from './policy.js';
import { simulateOutcome, simulatePromiseKept } from './outcomes.js';
import { templateNarrator } from './narrator.js';
import { linkColumns } from './payment-link.js';

const DAY = 86400000;
const HOUR = 3600000;

/** Statuses from which no further work is possible. */
const TERMINAL = new Set(['recovered', 'stopped', 'failed']);
export const isTerminal = (status) => TERMINAL.has(status);

/** Statuses the scheduler may be asked to move forward. */
export const RESUMABLE = ['open', 'in_progress', 'awaiting_response', 'promise_to_pay'];

const ms = (t) => new Date(t).getTime();

/**
 * A random stream scoped to one draw on one case.
 *
 * The batch used to share a single stream across all 80 cases, which made every
 * outcome depend on how many draws the cases before it happened to consume. That
 * was survivable while a case ran start to finish in one pass. It is not
 * survivable now: a case can be sent today, parked for three days, and resolved
 * by a scheduler tick in a different process, in whatever order the deadlines
 * fall. Under a shared stream that case would draw whatever number the queue
 * happened to be at.
 *
 * Scoping the stream to (case, attempt, purpose) makes an outcome a function of
 * the case alone. The same case resolves the same way whether the batch drove it
 * in one pass or the scheduler picked it up a week later.
 */
const streamSeed = (seed, caseId, sequence, purpose) =>
  [...`${caseId}:${sequence}:${purpose}`]
    .reduce((n, ch) => (Math.imul(n, 31) + ch.charCodeAt(0)) >>> 0, seed >>> 0) >>> 0;

export function createRunner({
  db,
  /** Base seed. Every per-case stream is derived from it. */
  seed = Number(process.env.SEED) || 20260829,
  narrator = templateNarrator,
  now = Date.now(),
  /**
   * 'simulated' rolls outcomes off the probability tables in outcomes.js.
   * 'live' never invents an outcome: the only thing that can close the case is
   * a real payment on its Razorpay link, arriving before the window expires.
   */
  mode = 'simulated',
  /**
   * Pull the first outreach forward to `now`, instead of waiting out the delay
   * the matrix schedules it at. Off everywhere except a live case explicitly
   * opened with it; see decideNext for the bounds.
   */
  expediteFirstAction = false,
} = {}) {
  const randFor = (caseId, sequence, purpose) =>
    makeRandom(streamSeed(seed, caseId, sequence, purpose));

  // Ids continue from whatever the database already holds, so a scheduler tick
  // on a seeded book cannot collide with rows the batch wrote.
  const ids = {
    case: maxId(db, 'recovery_cases', 'case'),
    log: maxId(db, 'intervention_logs', 'ilog'),
    audit: maxId(db, 'audit_entries', 'audit'),
    promise: maxId(db, 'promises_to_pay', 'ptp'),
  };
  const nextId = (k, prefix) => `${prefix}_${String(++ids[k]).padStart(4, '0')}`;

  const stmt = {
    insertCase: db.prepare(`
      INSERT INTO recovery_cases (id,payment_attempt_id,customer_id,case_type,root_cause,
        root_cause_confidence,amount_at_risk_inr,status,attempts_used,opened_at,closed_at,
        closure_reason,recovered_amount_inr,next_action_at,awaiting_log_id,delivery_mode,
        contact_phone,payment_link_id,payment_link_url,payment_link_ref,payment_link_status,
        payment_link_created_at,payment_link_checked_at,payment_id,paid_at)
      VALUES (@id,@payment_attempt_id,@customer_id,@case_type,@root_cause,@root_cause_confidence,
        @amount_at_risk_inr,@status,@attempts_used,@opened_at,@closed_at,@closure_reason,
        @recovered_amount_inr,@next_action_at,@awaiting_log_id,@delivery_mode,
        @contact_phone,@payment_link_id,@payment_link_url,@payment_link_ref,@payment_link_status,
        @payment_link_created_at,@payment_link_checked_at,@payment_id,@paid_at)`),
    updateCase: db.prepare(`
      UPDATE recovery_cases SET status=@status, attempts_used=@attempts_used, closed_at=@closed_at,
        closure_reason=@closure_reason, recovered_amount_inr=@recovered_amount_inr,
        root_cause=@root_cause, root_cause_confidence=@root_cause_confidence,
        next_action_at=@next_action_at, awaiting_log_id=@awaiting_log_id,
        delivery_mode=@delivery_mode WHERE id=@id`),
    insertLog: db.prepare(`
      INSERT INTO intervention_logs (id,case_id,sequence,action_type,channel,tone,message_sent,
        scheduled_for,executed_at,response_deadline_at,responded_at,outcome,outcome_detail)
      VALUES (@id,@case_id,@sequence,@action_type,@channel,@tone,@message_sent,@scheduled_for,
        @executed_at,@response_deadline_at,@responded_at,@outcome,@outcome_detail)`),
    sendLog: db.prepare(`
      UPDATE intervention_logs SET executed_at=@executed_at, message_sent=@message_sent,
        response_deadline_at=@response_deadline_at, outcome_detail=@outcome_detail
        WHERE id=@id`),
    resolveLog: db.prepare(`
      UPDATE intervention_logs SET responded_at=@responded_at, outcome=@outcome,
        outcome_detail=@outcome_detail WHERE id=@id`),
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
    getLog: db.prepare('SELECT * FROM intervention_logs WHERE id = ?'),
    pendingSend: db.prepare(`
      SELECT * FROM intervention_logs WHERE case_id = ? AND executed_at IS NULL
      ORDER BY sequence DESC LIMIT 1`),
    openPromise: db.prepare(`
      SELECT * FROM promises_to_pay WHERE case_id = ? AND fulfilled = 0
      ORDER BY created_at DESC LIMIT 1`),
    keepPromise: db.prepare('UPDATE promises_to_pay SET fulfilled = 1 WHERE id = ?'),
    maxAuditSeq: db.prepare('SELECT MAX(sequence) AS n FROM audit_entries WHERE case_id = ?'),
  };

  // -------------------------------------------------------------------------
  // Context
  // -------------------------------------------------------------------------

  /**
   * Everything one case needs to be stepped forward.
   *
   * `anchor` is what the intervention matrix counts days from. Invoice reminder
   * days are counted from the due date, not from when AP noticed — "day 7" has
   * to mean 7 days past due to mean anything.
   */
  function makeContext({ caseRow, customer, attempt, subscription, invoice }) {
    const classification = classify(attempt);
    return {
      caseRow,
      customer,
      attempt,
      subscription,
      invoice,
      classification,
      caseId: caseRow.id,
      anchor: invoice ? ms(invoice.due_at) : ms(caseRow.opened_at),
      auditSeq: stmt.maxAuditSeq.get(caseRow.id).n ?? 0,
    };
  }

  const audit = (ctx, eventType, decision, extra = {}, at = ms(ctx.caseRow.opened_at)) => {
    stmt.insertAudit.run({
      id: nextId('audit', 'audit'),
      case_id: ctx.caseId,
      sequence: ++ctx.auditSeq,
      event_type: eventType,
      decision,
      reasoning_text: narrator.reason(eventType, { ...ctx, ...extra }),
      reasoning_source: narrator.source,
      policy_refs: extra.policyRefs ?? null,
      created_at: iso(at),
    });
  };

  const save = (caseRow) => stmt.updateCase.run(caseRow);

  const park = (caseRow, status, at) => {
    caseRow.status = status;
    caseRow.next_action_at = at == null ? null : iso(at);
    save(caseRow);
    return 'park';
  };

  const closeWith = (ctx, status, reason, recovered = 0, closedAt = now) => {
    const { caseRow } = ctx;
    caseRow.status = status;
    caseRow.closure_reason = reason;
    caseRow.recovered_amount_inr = recovered;
    caseRow.closed_at = iso(closedAt);
    caseRow.next_action_at = null;
    caseRow.awaiting_log_id = null;
    save(caseRow);
  };

  const stop = (ctx, reason, at, policyRefs) => {
    closeWith(ctx, 'stopped', reason, 0, at);
    audit(ctx, 'case_stopped', `Stopped — ${STOP_REASONS[reason] ?? reason}`,
      { stop: { reason }, caseRow: ctx.caseRow, policyRefs }, at);
    return 'park';
  };

  /**
   * The latest moment this case has already accounted for.
   *
   * Derived from the rows rather than carried in a variable, so a case resumed
   * from the database schedules its next action exactly where an uninterrupted
   * run would have. For an outreach that is the moment its response window
   * closed, not the moment it was sent — the agent does not get to escalate
   * while it is still waiting for the answer to the last message.
   */
  function frontier(ctx) {
    const rows = db.prepare(`
      SELECT executed_at, responded_at, response_deadline_at FROM intervention_logs
      WHERE case_id = ? AND executed_at IS NOT NULL`).all(ctx.caseId);
    const promises = db.prepare(
      'SELECT promised_date FROM promises_to_pay WHERE case_id = ? AND fulfilled = 0').all(ctx.caseId);

    let at = ms(ctx.caseRow.opened_at);
    for (const r of rows) {
      at = Math.max(at, ms(r.responded_at ?? r.response_deadline_at ?? r.executed_at));
    }
    for (const p of promises) at = Math.max(at, ms(p.promised_date));
    return at;
  }

  // -------------------------------------------------------------------------
  // One step
  // -------------------------------------------------------------------------

  /** @returns {'continue'|'park'} */
  function step(ctx) {
    const { caseRow } = ctx;
    if (isTerminal(caseRow.status)) return 'park';

    // 0. An opt-out or dispute ends the case wherever it stands, including
    //    mid-wait. Every other gate is checked at the moment the agent decides
    //    to act, which is enough to stop it *acting* — but a case parked on a
    //    three-day window would sit there reported as live recovery work on a
    //    customer who has asked to be left alone. The rule is that the hard stop
    //    covers the customer immediately, so it has to be able to reach a case
    //    that is not currently doing anything.
    //
    //    Judged as of the point this case has actually reached, never as of the
    //    server's clock: a dispute raised after a case already recovered must
    //    not reach back and stop it.
    const hard = checkHardStop(ctx.customer, frontier(ctx));
    if (hard.stop && caseRow.status !== 'open') return abandon(ctx, hard);

    // 1. A message is out and the clock is running on it.
    if (caseRow.status === 'awaiting_response' && caseRow.awaiting_log_id) {
      const log = stmt.getLog.get(caseRow.awaiting_log_id);
      const deadline = ms(log.response_deadline_at);
      if (now < deadline) return park(caseRow, 'awaiting_response', deadline);
      return resolveWindow(ctx, log, deadline);
    }

    // 2. A payment date the customer gave us has not arrived yet.
    if (caseRow.status === 'promise_to_pay') {
      const promise = stmt.openPromise.get(ctx.caseId);
      if (promise) {
        const due = ms(promise.promised_date);
        if (now < due) return park(caseRow, 'promise_to_pay', due);
        return resolvePromise(ctx, promise, due);
      }
    }

    // 3. An action is on the books but has not been sent.
    const pending = stmt.pendingSend.get(ctx.caseId);
    if (pending) {
      const due = ms(pending.scheduled_for);
      if (now < due) return park(caseRow, 'in_progress', due);
      return send(ctx, pending, due);
    }

    // 4. Nothing outstanding — decide what to do next.
    return decideNext(ctx);
  }

  /** Drive a case as far as it can go right now. */
  function drive(ctx) {
    // At most three interventions, each worth a handful of steps. The bound is
    // a guard against a state that fails to advance, not a real limit.
    for (let i = 0; i < 64; i++) {
      if (step(ctx) === 'park') return ctx.caseRow;
    }
    throw new Error(`runner: case ${ctx.caseId} did not settle after 64 steps`);
  }

  // -------------------------------------------------------------------------
  // Steps
  // -------------------------------------------------------------------------

  /**
   * Stop a case that a hard stop has caught part-way through.
   *
   * An outreach already sent cannot be unsent, but its window is closed here
   * rather than left open — an intervention with no outcome and nobody waiting
   * on it is exactly the dangling state the audit trail exists to prevent.
   */
  function abandon(ctx, hard) {
    const { caseRow } = ctx;
    const at = frontier(ctx);

    if (caseRow.status === 'awaiting_response' && caseRow.awaiting_log_id) {
      stmt.resolveLog.run({
        id: caseRow.awaiting_log_id,
        responded_at: iso(at),
        outcome: 'suppressed',
        outcome_detail: `Response window closed early — ${hard.detail.toLowerCase()}`,
      });
      ctx.attemptIndex = caseRow.attempts_used - 1;
      audit(ctx, 'outcome_recorded', 'Outcome: suppressed', {
        action: actionOf(stmt.getLog.get(caseRow.awaiting_log_id)),
        outcome: {
          outcome: 'suppressed',
          detail: `Stopped waiting on this message — ${hard.detail.toLowerCase()}`,
          engaged: null,
          p: {},
        },
      }, at);
      caseRow.awaiting_log_id = null;
    }

    return stop(ctx, hard.reason, at, 'hard_stop');
  }

  function decideNext(ctx) {
    const { caseRow, customer, attempt, classification } = ctx;
    const attemptsUsed = caseRow.attempts_used;
    const at = frontier(ctx);

    const cap = checkAttemptCap(attemptsUsed);
    if (cap.stop) return stop(ctx, 'max_attempts_reached', at, 'attempt_cap');

    const proposed = decideIntervention({
      bucket: classification.bucket,
      attemptIndex: attemptsUsed,
      customer,
      attempt,
      caseOpenedAt: ctx.anchor,
    });
    if (!proposed) return stop(ctx, 'sequence_exhausted', at, 'sequence_exhausted');

    /**
     * The one deliberate exception to real elapsed time.
     *
     * A live case runs on the wall clock, so its first outreach lands whenever
     * the matrix says — an hour out for an expired card, seven days for an
     * overdue invoice. That is correct for a real recovery and useless for
     * finding out whether the integration is wired up, so `expediteFirstAction` pulls the
     * *first* action forward to now.
     *
     * Strictly bounded, because this is the kind of switch that quietly becomes
     * a lie about what the agent did:
     *   - first action only (`attemptsUsed === 0`); every later attempt keeps
     *     the real schedule, and every response window stays genuine real time
     *   - the failure's own timestamp is untouched. Nothing is back-dated: the
     *     case still opens at the moment it really opened
     *   - quiet hours still apply. A compliance rule is not a scheduling
     *     convenience, so a message expedited into the small hours still waits
     *     for morning
     *   - it is written to the audit trail as an operator override, so the
     *     timeline never implies the agent chose this timing itself
     */
    const expedite = expediteFirstAction && attemptsUsed === 0;
    const scheduling = expedite
      ? { proposed: { ...proposed, scheduledFor: now }, notBefore: now }
      : { proposed, notBefore: at + HOUR };

    // Never schedule an action before the previous one finished and its response
    // window closed.
    const gates = screen({
      customer, attemptsUsed,
      proposed: scheduling.proposed,
      asOf: at,
      notBefore: scheduling.notBefore,
    });
    if (!gates.allowed) {
      return stop(ctx, gates.stop.reason, at,
        gates.stop.reason === 'max_attempts_reached' ? 'attempt_cap' : 'hard_stop');
    }

    const action = { ...proposed, scheduledFor: gates.scheduledFor };
    ctx.attemptIndex = attemptsUsed;

    if (expedite) {
      audit(ctx, 'first_action_expedited',
        'First outreach expedited to now by operator request',
        {
          action,
          policyRefs: 'expedite_first_action',
          expedite: { matrixWanted: proposed.scheduledFor, sentAt: gates.scheduledFor },
        }, gates.scheduledFor);
    }

    if (gates.deferral) {
      audit(ctx, 'quiet_hours_deferred', 'Outreach deferred out of quiet hours',
        { action, deferral: gates.deferral, policyRefs: 'quiet_hours' }, proposed.scheduledFor);
    }

    audit(ctx, 'intervention_selected',
      `Selected ${action.actionType}${action.silent ? '' : ` via ${action.channel}`}`,
      { action, classification }, action.scheduledFor);

    stmt.insertLog.run({
      id: nextId('log', 'ilog'),
      case_id: ctx.caseId,
      sequence: attemptsUsed + 1,
      action_type: action.actionType,
      channel: action.channel,
      tone: action.tone,
      // Rendered now so the copy is visible on the dashboard while the action is
      // still pending, exactly as it was before.
      message_sent: action.silent ? null : renderMessage(narrator, action, ctx),
      scheduled_for: iso(action.scheduledFor),
      executed_at: null,
      response_deadline_at: null,
      responded_at: null,
      outcome: null,
      outcome_detail: 'Scheduled — not yet due',
    });

    caseRow.status = 'in_progress';
    caseRow.next_action_at = iso(action.scheduledFor);
    save(caseRow);
    return 'continue';
  }

  /**
   * Execute the pending action.
   *
   * A silent retry is answered by the gateway in the same breath, so it executes
   * and resolves together. Anything a person has to read opens a response window
   * and the case waits.
   *
   * "Executed" means the agent decided, wrote the copy, and committed to it at
   * this timestamp. It does not mean a message was transmitted: this build has
   * no messaging provider, and the outreach is a record of what the agent would
   * send, on which channel, at which hour. What a live case actually puts in
   * front of a customer is the Razorpay link on the case.
   */
  function send(ctx, log, at) {
    const { caseRow } = ctx;
    const silent = log.channel === 'none';
    const deadline = silent ? null : at + POLICY.RESPONSE_WINDOW_MS;

    stmt.sendLog.run({
      id: log.id,
      executed_at: iso(at),
      message_sent: refreshedCopy(ctx, log, silent),
      response_deadline_at: deadline == null ? null : iso(deadline),
      outcome_detail: silent ? 'Retry submitted to the gateway' : 'Sent — awaiting response',
    });

    caseRow.attempts_used = log.sequence;

    if (silent) {
      const outcome = resolveOutcome(ctx, log, at);
      return applyOutcome(ctx, log, outcome, at, at);
    }

    caseRow.awaiting_log_id = log.id;
    audit(ctx, 'response_window_opened',
      `Awaiting response until ${iso(deadline)}`,
      { action: actionOf(log), deadline, policyRefs: 'response_window' }, at);
    caseRow.status = 'awaiting_response';
    caseRow.next_action_at = iso(deadline);
    save(caseRow);
    // Deliberately not a park. Whether the case waits or the window has already
    // expired is one question, answered in exactly one place — step()'s first
    // branch — so a back-dated failure whose window closed weeks ago resolves on
    // the next pass instead of sitting here forever.
    return 'continue';
  }


  /**
   * The copy as it stands at execution time.
   *
   * Almost always exactly what was written when the attempt was scheduled — the
   * point of rendering it then is that the dashboard can show it while the
   * action is still pending, and that stays true.
   *
   * The exception is narrow and worth the code: a live case whose Razorpay link
   * was minted *after* this attempt's copy was drafted. That happens to a case
   * opened before the link existed — Razorpay unconfigured at the time, or a
   * case carried over from an older build — and the stored draft quotes the
   * synthetic fallback URL, which cannot be paid. Re-rendering here means the
   * message that actually goes out names the link the case really has.
   *
   * Deliberately scoped to live cases holding a link the draft does not mention.
   * A simulated case is never touched, so the seeded book's LLM-written copy
   * cannot be silently overwritten with template text by a scheduler tick.
   */
  function refreshedCopy(ctx, log, silent) {
    const { caseRow } = ctx;
    if (silent || !log.message_sent) return log.message_sent;
    if (caseRow.delivery_mode !== 'live') return log.message_sent;
    const url = caseRow.payment_link_url;
    if (!url || log.message_sent.includes(url)) return log.message_sent;
    return renderMessage(narrator, actionOf(log), ctx) ?? log.message_sent;
  }

  /**
   * The response window has expired. Whatever was going to happen has happened.
   *
   * In simulated mode the outcome is rolled here off the same tables as before.
   * In live mode nothing is rolled: a real customer either paid through the real
   * link before the deadline — in which case checking the payment status already
   * closed this case — or they did not, and the honest record is "no response".
   */
  function resolveWindow(ctx, log, deadline) {
    const executedAt = ms(log.executed_at);
    const outcome = resolveOutcome(ctx, log, executedAt);
    // A customer who engaged did so at some point inside the window, not at its
    // last second. Silence is the only outcome that genuinely takes the full
    // window to establish.
    const respondedAt = outcome.engaged === false
      ? deadline
      : executedAt + POLICY.RESPONSE_WINDOW_MS * POLICY.SIMULATED_RESPONSE_FRACTION;
    return applyOutcome(ctx, log, outcome, respondedAt, deadline);
  }

  function resolveOutcome(ctx, log, executedAt) {
    if (ctx.caseRow.delivery_mode === 'live') {
      return {
        outcome: 'no_response',
        detail: 'Response window closed with no payment on the link',
        engaged: false,
        p: {},
      };
    }
    return simulateOutcome({
      bucket: ctx.classification.bucket,
      action: actionOf(log),
      customer: ctx.customer,
      attemptIndex: log.sequence - 1,
      amountInr: ctx.attempt.amount_inr,
      rand: randFor(ctx.caseId, log.sequence, 'outcome'),
    });
  }

  /** Record an outcome and react to it. */
  function applyOutcome(ctx, log, outcome, respondedAt, windowClosedAt) {
    const { caseRow, customer, attempt } = ctx;

    stmt.resolveLog.run({
      id: log.id,
      responded_at: iso(respondedAt),
      outcome: outcome.outcome,
      outcome_detail: outcome.detail,
    });
    caseRow.awaiting_log_id = null;
    ctx.attemptIndex = log.sequence - 1;
    audit(ctx, 'outcome_recorded', `Outcome: ${outcome.outcome}`,
      { action: actionOf(log), outcome }, respondedAt);

    if (outcome.outcome === 'recovered') {
      closeWith(ctx, 'recovered', 'payment_recovered', attempt.amount_inr, respondedAt);
      audit(ctx, 'case_recovered', 'Case closed — recovered', { caseRow }, respondedAt);
      return 'park';
    }

    if (outcome.triggeredHardStop) {
      // The opt-out attaches to the customer, so it also protects future cases.
      stmt.flagCustomer.run({
        id: customer.id,
        opted: outcome.triggeredHardStop === 'customer_opted_out' ? iso(respondedAt) : null,
        disputed: outcome.triggeredHardStop === 'customer_disputed' ? iso(respondedAt) : null,
      });
      customer[outcome.triggeredHardStop === 'customer_opted_out' ? 'opted_out_at' : 'disputed_at'] =
        iso(respondedAt);
      const reason = outcome.triggeredHardStop === 'customer_opted_out'
        ? 'opted_out_mid_recovery' : 'disputed_mid_recovery';
      closeWith(ctx, 'stopped', reason, 0, respondedAt);
      audit(ctx, 'case_stopped', `Stopped — ${outcome.detail}`,
        { stop: { reason }, caseRow, policyRefs: 'hard_stop' }, respondedAt);
      return 'park';
    }

    if (outcome.outcome === 'promise_to_pay') {
      const promise = {
        id: nextId('promise', 'ptp'),
        case_id: ctx.caseId,
        promised_date: iso(
          respondedAt + randFor(ctx.caseId, log.sequence, 'promise-date').int(3, 12) * DAY),
        promised_amount_inr: attempt.amount_inr,
        captured_via: log.channel,
        fulfilled: 0,
        created_at: iso(respondedAt),
      };
      stmt.insertPromise.run(promise);
      audit(ctx, 'promise_recorded', 'Promise to pay captured',
        { promise, action: actionOf(log) }, respondedAt);
      caseRow.status = 'promise_to_pay';
      save(caseRow);
      return 'continue';
    }

    // Failed, or no response. The case goes back for the next decision, which
    // cannot be taken before this attempt was answered — `frontier()` reads that
    // moment back off the row, and for silence it is the window's own deadline.
    caseRow.status = 'in_progress';
    caseRow.next_action_at = iso(windowClosedAt);
    save(caseRow);
    return 'continue';
  }

  function resolvePromise(ctx, promise, due) {
    const { caseRow, attempt } = ctx;
    const { kept } = simulatePromiseKept({
      customer: ctx.customer,
      rand: randFor(ctx.caseId, promise.id, 'promise-kept'),
    });
    if (kept) {
      stmt.keepPromise.run(promise.id);
      closeWith(ctx, 'recovered', 'promise_kept', attempt.amount_inr, due);
      audit(ctx, 'promise_kept', 'Promise honoured — case closed', { caseRow }, due);
      return 'park';
    }
    audit(ctx, 'promise_broken', 'Promised date passed with no payment', { caseRow }, due);
    caseRow.status = 'in_progress';
    save(caseRow);
    return 'continue';
  }

  // -------------------------------------------------------------------------
  // Entry points
  // -------------------------------------------------------------------------

  /**
   * Open a case for one failed payment and take it as far as it can go now.
   *
   * `attemptsUsed` is how many interventions this case has already spent — 0 for
   * everything in the batch, since the batch opens every case from scratch. The
   * live simulator sets it higher to start a case mid-sequence, which is also
   * the only way to reach the attempt cap at pre-screen rather than after the
   * loop has run.
   */
  function runCase({
    attempt, customer, subscription, invoice,
    attemptsUsed: startAttempts = 0,
    deliveryMode = mode,
    /** E.164, live cases only. Where this case's WhatsApp outreach actually goes. */
    contactPhone = null,
    /**
     * A real Razorpay payment link, already minted, for the outreach this case is
     * about to write. It has to exist before `runCase` rather than be created
     * inside it, because the message copy quotes the URL — see engine/
     * payment-link.js. Null on every simulated case, which is what keeps the
     * seeded book on its synthetic link text.
     */
    paymentLink = null,
  }) {
    const caseId = nextId('case', 'case');
    const openedAt = ms(attempt.created_at);

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
      next_action_at: null,
      awaiting_log_id: null,
      delivery_mode: deliveryMode,
      contact_phone: contactPhone,
      ...linkColumns(paymentLink),
    };
    stmt.insertCase.run(caseRow);

    const ctx = makeContext({ caseRow, customer, attempt, subscription, invoice });
    audit(ctx, 'case_opened', 'Revenue at risk detected — case opened');

    // -- Diagnose ------------------------------------------------------------
    caseRow.root_cause = ctx.classification.bucket;
    caseRow.root_cause_confidence = ctx.classification.confidence;
    save(caseRow);
    audit(ctx, 'root_cause_classified', `Root cause: ${ctx.classification.bucket}`,
      { classification: ctx.classification });

    // -- Hard stops, before any action ---------------------------------------
    const preScreen = screen({
      customer,
      attemptsUsed: startAttempts,
      proposed: { scheduledFor: openedAt, silent: true },
      asOf: openedAt,
    });
    if (!preScreen.allowed) {
      // A case that opens already at the cap stops for the cap, not for a hard
      // stop — the two are counted separately everywhere downstream.
      stop(ctx, preScreen.stop.reason, openedAt,
        preScreen.stop.reason === 'max_attempts_reached' ? 'attempt_cap' : 'hard_stop');
      return caseRow;
    }

    caseRow.status = 'in_progress';
    return drive(ctx);
  }

  /**
   * Continue a case that is already on the books.
   *
   * This is what the scheduler and the case route call. It reads everything it
   * needs out of the database, so it does not care whether the case was opened
   * by this process, by the batch, or by a payment-status check an hour ago.
   */
  function advanceCase(caseId) {
    const caseRow = db.prepare('SELECT * FROM recovery_cases WHERE id = ?').get(caseId);
    if (!caseRow) throw new Error(`advanceCase: no such case ${caseId}`);
    if (isTerminal(caseRow.status)) return caseRow;

    const attempt = db.prepare('SELECT * FROM payment_attempts WHERE id = ?')
      .get(caseRow.payment_attempt_id);
    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(caseRow.customer_id);
    const subscription = attempt.subscription_id
      ? db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(attempt.subscription_id) : null;
    const invoice = attempt.invoice_id
      ? db.prepare('SELECT * FROM invoices WHERE id = ?').get(attempt.invoice_id) : null;

    return drive(makeContext({ caseRow, customer, attempt, subscription, invoice }));
  }

  return { runCase, advanceCase };
}

/** The shape decideIntervention returns, reconstructed from a stored log row. */
const actionOf = (log) => ({
  actionType: log.action_type,
  channel: log.channel,
  tone: log.tone,
  silent: log.channel === 'none',
  scheduledFor: log.scheduled_for ? ms(log.scheduled_for) : null,
});

/** Highest numeric suffix already used for `prefix_NNNN` ids in a table. */
function maxId(db, table, prefix) {
  const row = db.prepare(
    `SELECT MAX(CAST(substr(id, ?) AS INTEGER)) AS n FROM ${table} WHERE id LIKE ?`
  ).get(prefix.length + 2, `${prefix}_%`);
  return row?.n ?? 0;
}

function renderMessage(narrator, action, ctx) {
  const drafted = narrator.message(action, ctx);
  if (!drafted) return null;
  return drafted.subject ? `Subject: ${drafted.subject}\n\n${drafted.body}` : drafted.body;
}
