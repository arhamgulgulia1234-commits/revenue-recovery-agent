/**
 * The real path: cases that send actual WhatsApp messages to actual phones.
 *
 * Separate from /api/simulate, which runs a case through the engine to be
 * watched and throws it away. Everything here is written to the book and
 * everything here can reach a real person, so it is deliberately a different
 * URL rather than a flag on the existing one.
 */

import { Router } from 'express';
import { getDb } from '../db/index.js';
import {
  openLiveCase, parseLiveInput, InvalidLiveInput, LIVE_SEGMENTS,
} from '../engine/live-case.js';
import { dispatch, pendingDeliveries } from '../engine/delivery.js';
import { advance } from '../engine/scheduler.js';
import { configSummary } from '../lib/twilio.js';
import { maskPhone } from '../lib/phone.js';
import { DECLINE_CODES, POLICY } from '../lib/taxonomy.js';
import { BUCKET_BY_CODE } from '../engine/classifier.js';
import { formatIst } from '../lib/time.js';

export const liveRouter = Router();

/**
 * Whether this deployment can actually send, and what to do about it if not.
 *
 * Checked by the dashboard before offering the form, and by a human wondering
 * why nothing arrived. The credentials themselves never appear — only which
 * ones are missing.
 */
liveRouter.get('/config', (req, res) => {
  const twilio = configSummary();
  res.json({
    twilio,
    segments: LIVE_SEGMENTS,
    responseWindowDays: POLICY.RESPONSE_WINDOW_DAYS,
    // Which decline codes open with a message a human will actually receive,
    // rather than a silent gateway retry. Worth knowing before picking one for
    // a test: 'transient' codes correctly retry in silence and send nothing.
    declineCodes: Object.entries(DECLINE_CODES).map(([code, m]) => ({
      code,
      label: m.label,
      bucket: BUCKET_BY_CODE[code],
      sendsMessageFirst: BUCKET_BY_CODE[code] !== 'transient',
    })),
    setup: twilio.configured ? null : {
      missing: twilio.missing,
      steps: [
        'Create a free Twilio account at twilio.com/try-twilio.',
        'Console → Messaging → Try it out → Send a WhatsApp message. That page shows the sandbox number and your join code.',
        'From the phone you want to test on, send "join <your-code>" on WhatsApp to the sandbox number.',
        'Copy Account SID and Auth Token from the Console dashboard into .env as TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN.',
        'Set TWILIO_WHATSAPP_FROM to the sandbox number, e.g. +14155238886, and TWILIO_SANDBOX_JOIN_CODE to your join code.',
        'Restart the backend.',
      ],
    },
  });
});

/** Live cases on the book, newest first. */
liveRouter.get('/cases', (req, res) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT rc.id, rc.status, rc.attempts_used, rc.amount_at_risk_inr, rc.opened_at,
           rc.closed_at, rc.closure_reason, rc.next_action_at, rc.contact_phone,
           rc.root_cause, c.name AS customer_name
    FROM recovery_cases rc
    JOIN customers c ON c.id = rc.customer_id
    WHERE rc.delivery_mode = 'live'
    ORDER BY rc.opened_at DESC LIMIT 50`).all();

  res.json({
    cases: rows.map((r) => ({ ...r, contact_phone_masked: maskPhone(r.contact_phone) })),
    pendingDeliveries: pendingDeliveries(db).length,
  });
});

/**
 * Open a live case and send its first message.
 *
 * The send is awaited rather than left to the next scheduler tick, so the
 * response can say what actually happened to the message — the entire point of
 * pressing this button is to find out.
 */
liveRouter.post('/cases', async (req, res, next) => {
  try {
    const input = parseLiveInput(req.body);
    const db = getDb();

    const opened = openLiveCase(db, input);
    const result = await dispatch(db, { caseId: opened.caseRow.id });

    const caseRow = db.prepare('SELECT * FROM recovery_cases WHERE id = ?').get(opened.caseRow.id);
    const interventions = db.prepare(`
      SELECT sequence, action_type, channel, tone, message_sent, scheduled_for, executed_at,
             response_deadline_at, delivery_status, provider_message_id, delivered_to,
             delivered_at, delivery_error, outcome, outcome_detail
      FROM intervention_logs WHERE case_id = ? ORDER BY sequence`).all(caseRow.id);

    res.status(201).json({
      caseId: caseRow.id,
      status: caseRow.status,
      rootCause: caseRow.root_cause,
      amountInr: caseRow.amount_at_risk_inr,
      contactPhone: caseRow.contact_phone,
      openedAt: caseRow.opened_at,
      // Said plainly rather than left for someone to notice: the failure is
      // dated in the past on purpose, so the first action is due now.
      backdatedByHours: Math.round(opened.backdatedBy / 3600000),
      nextActionAt: caseRow.next_action_at,
      nextActionAtLabel: caseRow.next_action_at ? formatIst(caseRow.next_action_at) : null,
      responseWindowDays: opened.responseWindowDays,
      delivery: {
        attempted: result.attempted,
        sent: result.sent.length,
        failed: result.failed,
        held: result.skipped,
      },
      interventions,
      closureReason: caseRow.closure_reason,
    });
  } catch (err) {
    if (err instanceof InvalidLiveInput) {
      return res.status(400).json({ error: 'invalid_input', message: err.message });
    }
    next(err);
  }
});

/** One live case in full, advanced to the present first. */
liveRouter.get('/cases/:id', (req, res) => {
  const db = getDb();
  try { advance(db, req.params.id); } catch { /* still worth showing */ }

  const caseRow = db.prepare(
    "SELECT * FROM recovery_cases WHERE id = ? AND delivery_mode = 'live'").get(req.params.id);
  if (!caseRow) return res.status(404).json({ error: 'not_found' });

  res.json({
    case: caseRow,
    interventions: db.prepare(
      'SELECT * FROM intervention_logs WHERE case_id = ? ORDER BY sequence').all(caseRow.id),
    audit: db.prepare(
      'SELECT * FROM audit_entries WHERE case_id = ? ORDER BY sequence').all(caseRow.id),
  });
});

/**
 * Retry whatever is still sitting in the outbox.
 *
 * The case that failed to send because Twilio was not configured yet is the
 * reason this exists: fix .env, restart, press this, rather than re-opening the
 * case and starting the sequence over.
 */
liveRouter.post('/dispatch', async (req, res, next) => {
  try {
    res.json(await dispatch(getDb(), { caseId: req.body?.caseId ?? null }));
  } catch (err) { next(err); }
});
