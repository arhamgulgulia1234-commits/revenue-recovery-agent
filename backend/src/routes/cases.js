import { Router } from 'express';
import { getDb } from '../db/index.js';
import { POLICY } from '../lib/taxonomy.js';
import { scoreCases } from '../engine/score-service.js';
import { PROVIDER, MODEL } from '../engine/llm-narrator.js';
import { buildTimeline } from '../engine/timeline.js';
import { advance } from '../engine/scheduler.js';
import { nowFor } from '../lib/clock.js';

export const casesRouter = Router();

casesRouter.get('/', (req, res) => {
  const { status, root_cause } = req.query;
  const where = [];
  const params = [];
  if (status) { where.push('rc.status = ?'); params.push(status); }
  if (root_cause) { where.push('rc.root_cause = ?'); params.push(root_cause); }

  const rows = getDb().prepare(`
    SELECT rc.*, c.name AS customer_name, c.segment, c.reliability_score,
           p.decline_code, s.plan_name, i.invoice_number
    FROM recovery_cases rc
    JOIN customers c ON c.id = rc.customer_id
    JOIN payment_attempts p ON p.id = rc.payment_attempt_id
    LEFT JOIN subscriptions s ON s.id = p.subscription_id
    LEFT JOIN invoices i ON i.id = p.invoice_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY rc.amount_at_risk_inr DESC`).all(...params);
  res.json({ count: rows.length, cases: rows });
});

/**
 * Cases the agent deliberately stopped, split by *why*.
 *
 * The two groups are different stories and are kept apart on purpose: one is
 * the agent respecting a customer who asked not to be contacted, the other is a
 * policy ceiling on how hard it may push. Lumping them together would read as
 * one pile of failures, which is the opposite of what they show.
 *
 * Declared before '/:id' — Express matches in order, and otherwise "stopped"
 * arrives as a case id.
 */
casesRouter.get('/stopped', (req, res) => {
  const rows = getDb().prepare(`
    SELECT rc.id, rc.customer_id, rc.root_cause, rc.amount_at_risk_inr, rc.attempts_used,
           rc.closure_reason, rc.opened_at, rc.closed_at,
           c.name AS customer_name, c.segment, c.opted_out_at, c.disputed_at,
           p.decline_code, s.plan_name, i.invoice_number
    FROM recovery_cases rc
    JOIN customers c ON c.id = rc.customer_id
    JOIN payment_attempts p ON p.id = rc.payment_attempt_id
    LEFT JOIN subscriptions s ON s.id = p.subscription_id
    LEFT JOIN invoices i ON i.id = p.invoice_id
    WHERE rc.status = 'stopped'
    ORDER BY rc.amount_at_risk_inr DESC`).all();

  const HARD_STOP = new Set([
    'customer_opted_out', 'customer_disputed',
    'opted_out_mid_recovery', 'disputed_mid_recovery',
  ]);

  const group = (predicate) => {
    const cases = rows.filter((r) => predicate(r.closure_reason));
    return {
      cases,
      count: cases.length,
      totalInr: cases.reduce((n, r) => n + r.amount_at_risk_inr, 0),
    };
  };

  const respected = group((r) => HARD_STOP.has(r));
  const capped = group((r) => !HARD_STOP.has(r));

  res.json({
    total: { count: rows.length, totalInr: respected.totalInr + capped.totalInr },
    respected,
    capped,
  });
});

/** Full decision history for one case: interventions and audit trail, in order. */
casesRouter.get('/:id', (req, res) => {
  const db = getDb();

  // Bring the case up to date before reading it. The timer sweep would get here
  // eventually, but "eventually" is the wrong answer to someone looking at the
  // case right now — a window that expired an hour ago should not still be shown
  // as open. Advancing is idempotent and only ever acts on a deadline that has
  // genuinely passed, so doing it on read costs nothing when there is no work.
  try {
    advance(db, req.params.id);
  } catch {
    // A case that cannot be advanced is still a case worth showing. Fall
    // through and render whatever is on the row.
  }

  const c = db.prepare(`
    SELECT rc.*, cu.name AS customer_name, cu.segment, cu.phone, cu.email,
           cu.reliability_score, cu.preferred_channel, cu.salary_day,
           cu.opted_out_at, cu.disputed_at,
           p.decline_code, p.gateway_message, p.attempt_number, p.channel AS failure_channel,
           p.created_at AS failed_at,
           s.plan_name, s.frequency, s.mandate_type, i.invoice_number, i.due_at
    FROM recovery_cases rc
    JOIN customers cu ON cu.id = rc.customer_id
    JOIN payment_attempts p ON p.id = rc.payment_attempt_id
    LEFT JOIN subscriptions s ON s.id = p.subscription_id
    LEFT JOIN invoices i ON i.id = p.invoice_id
    WHERE rc.id = ?`).get(req.params.id);

  if (!c) return res.status(404).json({ error: 'case_not_found', id: req.params.id });

  const interventions = db.prepare(
    'SELECT * FROM intervention_logs WHERE case_id = ? ORDER BY sequence').all(c.id);
  const audit = db.prepare(
    'SELECT * FROM audit_entries WHERE case_id = ? ORDER BY sequence').all(c.id);
  const promises = db.prepare(
    'SELECT * FROM promises_to_pay WHERE case_id = ? ORDER BY created_at').all(c.id);

  const [scored] = scoreCases(db, [c]).scored;

  // The open response window, if there is one, as the UI needs to state it:
  // when it closes and how long is left on the clock this case actually runs on.
  const waitingOn = c.status === 'awaiting_response' && c.awaiting_log_id
    ? interventions.find((i) => i.id === c.awaiting_log_id) ?? null
    : null;
  const responseWindow = waitingOn ? {
    interventionId: waitingOn.id,
    sequence: waitingOn.sequence,
    sentAt: waitingOn.executed_at,
    expiresAt: waitingOn.response_deadline_at,
    windowDays: POLICY.RESPONSE_WINDOW_DAYS,
    msRemaining: Math.max(
      0,
      new Date(waitingOn.response_deadline_at).getTime() - nowFor(c.delivery_mode)),
  } : null;

  res.json({
    case: { ...c, recovery_score: scored.recovery_score, score_band: scored.score_band,
            score_explanation: scored.score_explanation },
    responseWindow,
    interventions,
    audit,
    promises,
    // Which model wrote the narration, so the UI can name it instead of
    // hardcoding a provider that may not be the one in use.
    narrator: { provider: PROVIDER, model: MODEL },
    timeline: buildTimeline(audit, interventions),
  });
});
