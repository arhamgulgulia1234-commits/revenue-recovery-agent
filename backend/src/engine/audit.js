/**
 * Appending to a case's audit trail from outside the runner.
 *
 * The runner has its own `audit()`, which builds narration through the narrator
 * from a live case context. Some things that belong on the trail are not
 * decisions the agent made and have no such context — Razorpay confirming a
 * payment is the one that matters here. Those are facts about a network call,
 * recorded with `reasoning_source = 'system'` so an auditor can tell at a glance
 * which lines the agent reasoned its way to and which the outside world
 * asserted.
 *
 * Sequence and id both continue from whatever the database already holds, so a
 * row written here cannot collide with one the runner writes next.
 */

/**
 * @param {object} db
 * @param {string} caseId
 * @param {{eventType:string, decision:string, reasoning:string, at:string,
 *          policyRefs?:string|null}} entry
 * @returns {string} the new row's id
 */
export function appendSystemAudit(db, caseId, { eventType, decision, reasoning, at, policyRefs = null }) {
  const seq = (db.prepare('SELECT MAX(sequence) n FROM audit_entries WHERE case_id = ?')
    .get(caseId).n ?? 0) + 1;
  const n = (db.prepare(
    "SELECT MAX(CAST(substr(id, 7) AS INTEGER)) n FROM audit_entries WHERE id LIKE 'audit_%'")
    .get().n ?? 0) + 1;
  const id = `audit_${String(n).padStart(4, '0')}`;

  db.prepare(`
    INSERT INTO audit_entries (id,case_id,sequence,event_type,decision,reasoning_text,
      reasoning_source,policy_refs,created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(
    id, caseId, seq, eventType, decision, reasoning, 'system', policyRefs, at);

  return id;
}
