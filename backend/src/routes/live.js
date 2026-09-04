/**
 * The real path: persisted cases carrying real Razorpay payment links.
 *
 * Separate from /api/simulate/stream, which runs a case through the engine to be
 * watched and throws it away. Everything here is written to the book and can
 * take real money on a real link, so it is deliberately a different URL rather
 * than a flag on the existing one.
 */

import { Router } from 'express';
import { getDb } from '../db/index.js';
import {
  openLiveCase, prepareLiveCase, parseLiveInput, InvalidLiveInput, LIVE_SEGMENTS,
} from '../engine/live-case.js';
import {
  mintForCase, checkPaymentStatus, NoPaymentLink, actionCarriesLink,
} from '../engine/payment-link.js';
import { decideIntervention, ACTION_LABELS } from '../engine/matrix.js';
import { advanceWithLink } from '../engine/scheduler.js';
import {
  configSummary as razorpayConfig, TEST_INSTRUMENTS, RazorpayError,
} from '../lib/razorpay.js';
import { maskPhone } from '../lib/phone.js';
import { DECLINE_CODES, POLICY } from '../lib/taxonomy.js';
import { BUCKET_BY_CODE } from '../engine/classifier.js';
import { formatIst, iso } from '../lib/time.js';

export const liveRouter = Router();

/**
 * Whether this deployment can mint real links, and what to do about it if not.
 *
 * Checked by the dashboard before offering the form. The credentials themselves
 * never appear — only which ones are missing.
 */
liveRouter.get('/config', (req, res) => {
  const razorpay = razorpayConfig();
  res.json({
    /**
     * Whether this deployment can mint real payment links, and what to pay them
     * with once it can. The test instruments ship with the config rather than
     * living in a README so that whoever is about to rehearse the flow is handed
     * them by the same endpoint that says the integration is switched on.
     */
    razorpay: {
      ...razorpay,
      testInstruments: razorpay.configured ? TEST_INSTRUMENTS : null,
      setup: razorpay.configured ? null : {
        missing: razorpay.missing,
        steps: [
          'Sign in at dashboard.razorpay.com and turn on the Test Mode toggle (top-left).',
          'Account & Settings → API Keys → Generate Test Key.',
          'Copy the Key Id (rzp_test_…) into .env as RAZORPAY_KEY_ID.',
          'Copy the Key Secret — it is shown exactly once — into .env as RAZORPAY_KEY_SECRET.',
          'Restart the backend.',
        ],
      },
    },
    segments: LIVE_SEGMENTS,
    responseWindowDays: POLICY.RESPONSE_WINDOW_DAYS,
    /**
     * How a live case treats time. Stated here because it is the difference
     * between this and /api/simulate, and the difference is easy to assume
     * wrongly in either direction.
     */
    timing: {
      realTime: true,
      note: 'A live case is never back-dated. The failure carries the current timestamp and every '
          + 'response window is genuine elapsed time — the case waits real days for a real reply.',
      sendFirstMessageNow: {
        default: false,
        effect: 'Pulls only the first outreach forward to now, so a test message arrives immediately '
              + 'instead of when the matrix scheduled it. Later attempts and all response windows stay '
              + 'real. Quiet hours still apply, and the override is written to the audit trail.',
      },
    },
    // Which decline codes open with a message a human will actually receive,
    // rather than a silent gateway retry. Worth knowing before picking one for
    // a test: 'transient' codes correctly retry in silence and send nothing.
    //
    // `mintsPaymentLinkFirst` is the one that matters for a Razorpay rehearsal,
    // and it is asked of the matrix rather than listed here — a decline code
    // whose first action is a silent retry has no message and therefore no link,
    // and that is a property of the decision matrix, not of this route.
    declineCodes: Object.entries(DECLINE_CODES).map(([code, m]) => {
      const plan = actionPlanFor(code);
      const first = plan[0] ?? null;
      const linkAt = plan.findIndex((d) => d && actionCarriesLink(d.actionType));
      return {
        code,
        label: m.label,
        bucket: BUCKET_BY_CODE[code],
        sendsMessageFirst: BUCKET_BY_CODE[code] !== 'transient',
        firstAction: first?.actionType ?? null,
        firstActionLabel: first ? (ACTION_LABELS[first.actionType] ?? first.actionType) : null,
        /** Whether this case ever quotes a link, and on which attempt (1-based). */
        mintsPaymentLink: linkAt >= 0,
        paymentLinkAttempt: linkAt >= 0 ? linkAt + 1 : null,
        paymentLinkActionLabel: linkAt >= 0
          ? (ACTION_LABELS[plan[linkAt].actionType] ?? plan[linkAt].actionType) : null,
      };
    }),
  });
});

/**
 * The real book, in totals.
 *
 * Deliberately its own endpoint rather than a few extra fields on
 * /api/portfolio/stats. Those numbers describe the seeded book and are filtered
 * to `source = 'seed'` precisely so a live case cannot move them; folding real
 * recoveries in there would undo the guarantee the filter exists to make. This
 * is the other set of books, reported separately and labelled as such.
 */
liveRouter.get('/stats', (req, res) => {
  const db = getDb();
  const one = (sql) => db.prepare(sql).get();

  const cases = one(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN status = 'recovered' THEN 1 ELSE 0 END) AS recovered,
           SUM(CASE WHEN status IN ('open','in_progress','awaiting_response','promise_to_pay')
                    THEN 1 ELSE 0 END) AS in_flight,
           COALESCE(SUM(recovered_amount_inr), 0) AS recovered_inr,
           COALESCE(SUM(CASE WHEN status != 'recovered' THEN amount_at_risk_inr ELSE 0 END), 0)
             AS at_risk_inr,
           SUM(CASE WHEN payment_link_id IS NOT NULL THEN 1 ELSE 0 END) AS links_minted,
           MAX(paid_at) AS last_paid_at
    FROM recovery_cases WHERE delivery_mode = 'live'`);

  res.json({
    // Everything here is real: real links on Razorpay, real payments, real
    // timestamps. None of it is modelled and none of it touches the seeded book.
    real: true,
    cases: {
      total: cases.total ?? 0,
      recovered: cases.recovered ?? 0,
      inFlight: cases.in_flight ?? 0,
      linksMinted: cases.links_minted ?? 0,
    },
    recoveredInr: cases.recovered_inr ?? 0,
    atRiskInr: cases.at_risk_inr ?? 0,
    lastPaidAt: cases.last_paid_at ?? null,
    lastPaidAtLabel: cases.last_paid_at ? formatIst(cases.last_paid_at) : null,
    razorpay: razorpayConfig(),
  });
});

/** Live cases on the book, newest first. */
liveRouter.get('/cases', (req, res) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT rc.id, rc.status, rc.attempts_used, rc.amount_at_risk_inr, rc.opened_at,
           rc.closed_at, rc.closure_reason, rc.next_action_at, rc.contact_phone,
           rc.root_cause, rc.recovered_amount_inr, rc.payment_link_id, rc.payment_link_url,
           rc.payment_link_status, rc.paid_at, rc.payment_id, c.name AS customer_name
    FROM recovery_cases rc
    JOIN customers c ON c.id = rc.customer_id
    WHERE rc.delivery_mode = 'live'
    ORDER BY rc.opened_at DESC LIMIT 50`).all();

  res.json({
    cases: rows.map((r) => ({
      ...r,
      contact_phone_masked: r.contact_phone ? maskPhone(r.contact_phone) : null,
      paymentLink: paymentLinkView(r),
    })),
  });
});

/**
 * Open a live case: mint its payment link, then write it to the book.
 *
 * The Razorpay call is awaited rather than left to a later tick, because the
 * link has to exist before the message copy that quotes it — the entire point of
 * pressing this button is to come away with a payable URL.
 */
liveRouter.post('/cases', async (req, res, next) => {
  try {
    const input = parseLiveInput(req.body);
    const db = getDb();

    /**
     * Ask the matrix what it will do *before* committing anything, so a real
     * payment link can be minted for the message it is about to write. The link
     * has to exist before the copy that quotes it, and the runner is synchronous
     * — see engine/payment-link.js for why that ordering is forced.
     *
     * Every attempt is forecast, not just the first. A silent retry resolves in
     * the same pass it executes, so a case opening on one writes its *second*
     * attempt's copy before `openLiveCase` returns — and that is the attempt
     * that quotes the link.
     *
     * A case that never quotes a link mints nothing. Neither does one opened
     * while Razorpay is unconfigured: it falls back to the synthetic link text
     * and opens perfectly well, and refusing to open it would be worse.
     */
    const prepared = prepareLiveCase(db, input);
    const minted = await mintForCase({
      input,
      customer: prepared.customer,
      forecast: prepared.forecast,
      linkAttempt: prepared.linkAttempt,
      referenceId: prepared.referenceId,
    });

    const opened = openLiveCase(db, input, { prepared, paymentLink: minted.link });

    const caseRow = db.prepare('SELECT * FROM recovery_cases WHERE id = ?').get(opened.caseRow.id);
    const interventions = db.prepare(`
      SELECT sequence, action_type, channel, tone, message_sent, scheduled_for, executed_at,
             response_deadline_at, outcome, outcome_detail
      FROM intervention_logs WHERE case_id = ? ORDER BY sequence`).all(caseRow.id);

    res.status(201).json({
      caseId: caseRow.id,
      status: caseRow.status,
      rootCause: caseRow.root_cause,
      amountInr: caseRow.amount_at_risk_inr,
      contactPhone: caseRow.contact_phone,
      openedAt: caseRow.opened_at,
      /**
       * The real link, or an honest account of why there isn't one. `error` is
       * the case that matters: Razorpay was configured, the operator expected a
       * real link, and the call failed — the case still opened, on synthetic
       * link text, and saying so beats a URL that quietly goes nowhere.
       */
      paymentLink: paymentLinkView(caseRow, {
        skipped: minted.skipped,
        error: minted.error,
      }),
      /**
       * Timing, stated plainly, because this is the thing most easily
       * misunderstood about a live case. `realTime: true` always — the failure
       * carries the actual current timestamp and every response window is
       * genuine elapsed time. `expedited` says whether the first outreach was
       * pulled forward to now, and `matrixWouldHaveSent` says when it would
       * otherwise have gone, so the override is never invisible.
       */
      timing: {
        realTime: true,
        expedited: opened.expedited,
        matrixWouldHaveSent: opened.firstActionForecast
          ? {
            actionType: opened.firstActionForecast.actionType,
            at: iso(opened.firstActionForecast.scheduledFor),
            atLabel: formatIst(opened.firstActionForecast.scheduledFor),
            delayHours: Math.round(opened.firstActionForecast.delayMs / 360000) / 10,
          }
          : null,
        note: opened.expedited
          ? 'First outreach expedited to now. Every later attempt and every response window is real elapsed time.'
          : 'No timestamps altered. The first outreach goes out when the matrix scheduled it.',
      },
      nextActionAt: caseRow.next_action_at,
      nextActionAtLabel: caseRow.next_action_at ? formatIst(caseRow.next_action_at) : null,
      responseWindowDays: opened.responseWindowDays,
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
liveRouter.get('/cases/:id', async (req, res) => {
  const db = getDb();
  // Advancing may escalate the case to an action that quotes a payment link, so
  // this mints one first if the case does not already have it.
  try { await advanceWithLink(db, req.params.id); } catch { /* still worth showing */ }

  const caseRow = db.prepare(
    "SELECT * FROM recovery_cases WHERE id = ? AND delivery_mode = 'live'").get(req.params.id);
  if (!caseRow) return res.status(404).json({ error: 'not_found' });

  res.json({
    case: caseRow,
    paymentLink: paymentLinkView(caseRow),
    interventions: db.prepare(
      'SELECT * FROM intervention_logs WHERE case_id = ? ORDER BY sequence').all(caseRow.id),
    audit: db.prepare(
      'SELECT * FROM audit_entries WHERE case_id = ? ORDER BY sequence').all(caseRow.id),
  });
});

/**
 * Ask Razorpay what has happened to this case's payment link.
 *
 * A POST because it can change the case: a link Razorpay reports as paid closes
 * the case as recovered, at Razorpay's payment timestamp, with an audit entry
 * saying so. Safe to press repeatedly — the second press re-reads the status and
 * changes nothing else.
 */
liveRouter.post('/cases/:id/payment-status', async (req, res, next) => {
  try {
    res.json(await checkPaymentStatus(getDb(), req.params.id));
  } catch (err) {
    if (err instanceof NoPaymentLink) {
      return res.status(404).json({ error: 'no_payment_link', message: err.message });
    }
    // Razorpay being unreachable is not this server's fault and not a 500: the
    // case is intact and the button is worth pressing again.
    if (err instanceof RazorpayError) {
      return res.status(502).json({
        error: 'razorpay_error', message: err.message, retriable: err.retriable,
      });
    }
    next(err);
  }
});

/**
 * Every action the matrix would take on a decline code, in order.
 *
 * A stand-in customer shaped like the ones `openLiveCase` creates: consumer,
 * WhatsApp, and a gateway that has spent one attempt. The whole sequence is
 * asked for, not just the first step, because "does this case ever quote a
 * payment link" is the question the form actually needs answered — an
 * insufficient-funds case opens on a silent retry and escalates to a link on
 * attempt two, and calling that "no link" would be wrong.
 */
function actionPlanFor(code) {
  const now = Date.now();
  const customer = {
    segment: 'consumer', preferred_channel: 'whatsapp', salary_day: 1, reliability_score: 0.62,
  };
  const attempt = { decline_code: code, attempt_number: 1, amount_inr: 2499 };
  const plan = [];
  for (let n = 0; n < POLICY.MAX_ATTEMPTS_PER_CASE; n += 1) {
    try {
      const d = decideIntervention({
        bucket: BUCKET_BY_CODE[code], attemptIndex: n, customer, attempt, caseOpenedAt: now,
      });
      if (!d) break;
      plan.push(d);
    } catch {
      break;
    }
  }
  return plan;
}

/**
 * The payment link as the UI needs it: the URL, what Razorpay last said about
 * it, and — when there is no link — which of the several innocent reasons applies.
 */
function paymentLinkView(caseRow, { skipped = null, error = null } = {}) {
  if (!caseRow.payment_link_id) {
    return { present: false, skipped, error, id: null, url: null, status: null };
  }
  return {
    present: true,
    skipped: null,
    error,
    id: caseRow.payment_link_id,
    url: caseRow.payment_link_url,
    reference: caseRow.payment_link_ref ?? null,
    status: caseRow.payment_link_status,
    createdAt: caseRow.payment_link_created_at ?? null,
    checkedAt: caseRow.payment_link_checked_at ?? null,
    paymentId: caseRow.payment_id ?? null,
    paidAt: caseRow.paid_at ?? null,
    paidAtLabel: caseRow.paid_at ? formatIst(caseRow.paid_at) : null,
  };
}

