/**
 * The outbox: turning a 'pending' intervention row into a real WhatsApp message.
 *
 * The runner is synchronous and every caller relies on that, so it does not call
 * Twilio. It commits to sending by marking the row 'pending', and this module
 * comes along afterwards and does the network part. Two events, two records:
 * "the agent decided to send this" and "Twilio accepted it" are separately true,
 * separately timestamped, and can separately fail.
 *
 * That separation is what makes a crash survivable. A row stuck at 'pending' is
 * work still to do, and the next dispatch picks it up. Nothing is ever recorded
 * as delivered because the engine intended to deliver it.
 *
 * ## What a failure does to the case
 *
 * Nothing, deliberately. A message Twilio refused is marked 'failed' with the
 * reason kept verbatim, and the response window stays exactly as the runner set
 * it. The alternative — reaching back to reopen or re-time the case — would mean
 * a delivery problem silently editing the recovery record, and the timeline
 * would no longer say what the agent actually decided. The failure is visible on
 * the intervention instead, which is where someone can act on it.
 */

import { sendWhatsApp, TwilioError, isConfigured, missingConfig } from '../lib/twilio.js';
import { iso } from '../lib/time.js';

/** Rows the engine has committed to sending but nobody has sent yet. */
const PENDING = `
  SELECT il.*, rc.contact_phone, rc.delivery_mode
  FROM intervention_logs il
  JOIN recovery_cases rc ON rc.id = il.case_id
  WHERE il.delivery_status = 'pending' AND rc.delivery_mode = 'live'
  ORDER BY il.executed_at ASC`;

export const pendingDeliveries = (db, caseId = null) =>
  caseId
    ? db.prepare(`${PENDING.replace('WHERE', 'WHERE il.case_id = ? AND')}`).all(caseId)
    : db.prepare(PENDING).all();

/**
 * Send everything outstanding.
 *
 * @param {object} db
 * @param {{caseId?:string, log?:Function}} opts  `caseId` narrows to one case
 * @returns {Promise<{attempted:number, sent:object[], failed:object[], skipped:string|null}>}
 */
export async function dispatch(db, { caseId = null, log = () => {} } = {}) {
  const rows = pendingDeliveries(db, caseId);
  if (!rows.length) return { attempted: 0, sent: [], failed: [], skipped: null };

  // Left pending rather than marked failed: the credentials may well be there on
  // the next tick, and burning the attempt because a .env line was missing would
  // lose a real message for a fixable reason.
  if (!isConfigured()) {
    const why = `Twilio not configured (${missingConfig().join(', ')})`;
    log(`  delivery: ${rows.length} message(s) held — ${why}`);
    return { attempted: 0, sent: [], failed: [], skipped: why };
  }

  const markSent = db.prepare(`
    UPDATE intervention_logs SET delivery_status='sent', provider_message_id=@sid,
      delivered_to=@to, delivered_at=@at, delivery_error=NULL,
      outcome_detail=@detail WHERE id=@id`);
  const markFailed = db.prepare(`
    UPDATE intervention_logs SET delivery_status=@status, delivery_error=@error,
      delivered_to=@to, outcome_detail=@detail WHERE id=@id`);

  const sent = [];
  const failed = [];

  for (const row of rows) {
    try {
      const result = await sendWhatsApp({ to: row.contact_phone, body: row.message_sent });
      const at = iso(Date.now());
      markSent.run({
        id: row.id,
        sid: result.sid,
        to: row.contact_phone,
        at,
        detail: `WhatsApp message delivered to ${row.contact_phone} — awaiting response`,
      });
      audit(db, row, `WhatsApp message sent to ${row.contact_phone}`,
        `Twilio accepted the message for delivery to ${row.contact_phone} ` +
        `(message ${result.sid}, status "${result.status}"). The case now waits for a ` +
        `response until ${row.response_deadline_at}.`, at);
      sent.push({ logId: row.id, caseId: row.case_id, sid: result.sid, to: row.contact_phone });
      log(`  delivery: ${row.case_id} → ${row.contact_phone} (${result.sid})`);
    } catch (err) {
      if (!(err instanceof TwilioError)) throw err;
      // Retriable means Twilio was unreachable or busy, not that it said no.
      // Those stay 'pending' so the next tick tries again.
      const status = err.retriable ? 'pending' : 'failed';
      markFailed.run({
        id: row.id,
        status,
        error: err.message,
        to: row.contact_phone,
        detail: status === 'pending'
          ? `Delivery retrying — ${err.message}`
          : `WhatsApp delivery failed — ${err.message}`,
      });
      if (status === 'failed') {
        audit(db, row, 'WhatsApp delivery failed',
          `Twilio refused the message to ${row.contact_phone}: ${err.message} ` +
          'The response window is unchanged — a delivery failure does not alter what ' +
          'the agent decided, and the case is not credited with an outreach that never arrived.',
          iso(Date.now()));
      }
      failed.push({ logId: row.id, caseId: row.case_id, error: err.message, retriable: err.retriable });
      log(`  delivery: ${row.case_id} ${status} — ${err.message}`);
    }
  }

  return { attempted: rows.length, sent, failed, skipped: null };
}

/**
 * Append to the case's audit trail.
 *
 * Written straight to the table rather than through the runner's `audit()`,
 * which builds narration from a live case context this module does not have —
 * and should not, because what happened here is a fact about a network call,
 * not a decision the agent made.
 */
function audit(db, row, decision, text, at) {
  const seq = (db.prepare('SELECT MAX(sequence) n FROM audit_entries WHERE case_id = ?')
    .get(row.case_id).n ?? 0) + 1;
  const n = (db.prepare(
    "SELECT MAX(CAST(substr(id, 7) AS INTEGER)) n FROM audit_entries WHERE id LIKE 'audit_%'")
    .get().n ?? 0) + 1;
  db.prepare(`
    INSERT INTO audit_entries (id,case_id,sequence,event_type,decision,reasoning_text,
      reasoning_source,policy_refs,created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(
    `audit_${String(n).padStart(4, '0')}`, row.case_id, seq, 'message_delivered',
    decision, text, 'system', null, at);
}
