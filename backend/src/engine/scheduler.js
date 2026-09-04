/**
 * The scheduled check.
 *
 * A case that is waiting for a customer to respond is not finished and not
 * failed — it is parked with a deadline. Something has to come back and look at
 * it when that deadline passes, or the wait never ends. That is this module.
 *
 * Two ways in, both landing on the same `advanceCase`:
 *
 *   sweep()   — every case whose `next_action_at` has come due. Run on a timer
 *               by the server, and by `npm run tick` from a shell.
 *   advance() — one case, on demand. The case route calls it before reading, so
 *               opening a case in the dashboard never shows a window that
 *               expired an hour ago as though it were still open.
 *
 * Neither invents work: a case only moves if a real timestamp has passed.
 *
 * ## Why the seeded book does not drift
 *
 * Simulated cases are evaluated against SEED_NOW, which does not advance. A
 * server left running for a week therefore cannot walk the 80-case demo book
 * forward and change the numbers on the dashboard. Live cases are evaluated
 * against the wall clock, which is the only clock a real customer is on.
 */

import { nowFor } from '../lib/clock.js';
import { createRunner, RESUMABLE, isTerminal } from './runner.js';
import { ensurePaymentLink } from './payment-link.js';

/**
 * The runner scopes its randomness to (case, attempt), so a simulated case
 * resumed by a tick draws exactly what an uninterrupted batch would have drawn.
 * The outcome does not depend on how often the sweeper ran, or in what order it
 * reached the book.
 */
const runnerFor = (db, caseRow) => createRunner({
  db,
  now: nowFor(caseRow.delivery_mode),
  mode: caseRow.delivery_mode,
});

/** Move one case as far forward as its own clock allows. */
export function advance(db, caseId) {
  const caseRow = db.prepare('SELECT * FROM recovery_cases WHERE id = ?').get(caseId);
  if (!caseRow || isTerminal(caseRow.status)) return caseRow ?? null;
  return runnerFor(db, caseRow).advanceCase(caseId);
}

/**
 * The same, but minting a payment link first if the next action needs one.
 *
 * Kept separate from `advance` because it is async and `advance` cannot be: the
 * runner is synchronous and the case route, the batch and the tests all call
 * into it from synchronous code. Callers that can await should prefer this one —
 * a live case escalating from a silent retry to a payment link gets a real,
 * payable URL in that message instead of the synthetic fallback.
 */
export async function advanceWithLink(db, caseId) {
  const caseRow = db.prepare('SELECT * FROM recovery_cases WHERE id = ?').get(caseId);
  if (!caseRow || isTerminal(caseRow.status)) return caseRow ?? null;
  if (caseRow.delivery_mode === 'live') {
    // Never fatal: a link that could not be minted leaves the case to advance on
    // the fallback text rather than stalling the recovery.
    await ensurePaymentLink(db, caseId).catch(() => null);
  }
  return advance(db, caseId);
}

/** Every case whose next_action_at has passed, on the clock that case runs on. */
export function due(db) {
  const placeholders = RESUMABLE.map(() => '?').join(',');
  return db.prepare(`
    SELECT * FROM recovery_cases
    WHERE status IN (${placeholders}) AND next_action_at IS NOT NULL
    ORDER BY next_action_at ASC`).all(...RESUMABLE)
    .filter((c) => new Date(c.next_action_at).getTime() <= nowFor(c.delivery_mode));
}

/**
 * One pass over everything that has come due.
 *
 * @returns {{checked:number, advanced:string[], errors:{caseId:string,message:string}[]}}
 */
export function sweep(db) {
  const cases = due(db);
  const advanced = [];
  const errors = [];

  for (const caseRow of cases) {
    try {
      const before = `${caseRow.status}:${caseRow.attempts_used}:${caseRow.next_action_at}`;
      const after = runnerFor(db, caseRow).advanceCase(caseRow.id);
      if (`${after.status}:${after.attempts_used}:${after.next_action_at}` !== before) {
        advanced.push(caseRow.id);
      }
    } catch (err) {
      // One malformed case must not stop the sweep for the rest of the book.
      errors.push({ caseId: caseRow.id, message: err.message });
    }
  }

  return { checked: cases.length, advanced, errors };
}

/**
 * Run sweep() on an interval, and once at startup.
 *
 * This is what moves a live case onto its next attempt three days after the
 * first one, with nobody pressing anything. A sweep is entirely synchronous —
 * there is no provider to call and nothing to await — so a tick either advances
 * cases or it does not, and it can never overlap itself.
 *
 * @returns {() => void} stop
 */
export function startScheduler(db, { intervalMs = 60000, log = console.log } = {}) {
  /**
   * Live cases get a pre-pass before the sweep: a case about to escalate to a
   * payment link needs a real one minted first, because the copy is rendered
   * when the intervention is scheduled, not when it is sent.
   *
   * `busy` stops a slow Razorpay call from overlapping itself if the interval
   * comes round again while it is still minting.
   */
  let busy = false;

  const tick = async (label) => {
    if (!busy) {
      busy = true;
      try {
        for (const caseRow of due(db)) {
          if (caseRow.delivery_mode !== 'live') continue;
          const r = await ensurePaymentLink(db, caseRow.id);
          if (r.link) log(`  scheduler ${label}: minted ${r.link.id} for ${caseRow.id}`);
          if (r.error) log(`  scheduler ${label}: link failed for ${caseRow.id} — ${r.error}`);
        }
      } catch (err) {
        // Minting trouble must never stop the sweep; the case advances on the
        // fallback text and can be re-checked on the next tick.
        log(`  scheduler ${label}: link pre-pass failed — ${err.message}`);
      } finally {
        busy = false;
      }
    }

    const { checked, advanced, errors } = sweep(db);
    if (advanced.length || errors.length) {
      log(`  scheduler ${label}: ${advanced.length}/${checked} advanced` +
        (errors.length ? ` · ${errors.length} error(s): ${errors[0].message}` : ''));
    }
  };

  tick('boot');
  const handle = setInterval(() => tick('tick'), intervalMs);
  handle.unref?.();
  return () => clearInterval(handle);
}
