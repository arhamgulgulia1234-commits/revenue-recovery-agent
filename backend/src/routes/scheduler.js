import { Router } from 'express';
import { getDb } from '../db/index.js';
import { sweep, due } from '../engine/scheduler.js';
import { SEED_NOW, anchorPinned } from '../lib/clock.js';
import { POLICY } from '../lib/taxonomy.js';
import { iso } from '../lib/time.js';

export const schedulerRouter = Router();

/**
 * What the scheduler is currently sitting on.
 *
 * Useful while testing the real flow: after opening a live case you want to see
 * it, its deadline, and how long is left on it, without reading the database by
 * hand.
 */
schedulerRouter.get('/', (req, res) => {
  const db = getDb();
  const waiting = db.prepare(`
    SELECT rc.id, rc.status, rc.attempts_used, rc.delivery_mode, rc.next_action_at,
           rc.amount_at_risk_inr, c.name AS customer_name
    FROM recovery_cases rc
    JOIN customers c ON c.id = rc.customer_id
    WHERE rc.status IN ('in_progress','awaiting_response','promise_to_pay')
      AND rc.next_action_at IS NOT NULL
    ORDER BY rc.next_action_at ASC
    LIMIT 50`).all();

  res.json({
    responseWindowDays: POLICY.RESPONSE_WINDOW_DAYS,
    anchor: anchorPinned() ? iso(SEED_NOW) : null,
    wallClock: iso(Date.now()),
    dueNow: due(db).length,
    waiting,
  });
});

/** Run one sweep on demand, rather than waiting for the next tick. */
schedulerRouter.post('/tick', (req, res) => res.json(sweep(getDb())));
