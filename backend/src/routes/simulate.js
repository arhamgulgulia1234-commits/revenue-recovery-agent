/**
 * The live control panel's API.
 *
 * One endpoint describes what the form may contain; the other runs a case and
 * streams it back stage by stage over server-sent events.
 *
 * SSE rather than a single JSON response because the stages do not all cost the
 * same. Classification and the decision matrix are instant; the model call at
 * stage 4 takes seconds. Returning everything at once would mean a spinner
 * followed by a replay, which is exactly the "finished result dumped all at
 * once" this is meant to replace. Streaming means the wait the viewer sees is
 * the work actually happening.
 */

import { Router } from 'express';
import { getDb } from '../db/index.js';
import { DECLINE_CODES, POLICY } from '../lib/taxonomy.js';
import { PROVIDER, MODEL, credentialsPresent } from '../engine/llm-narrator.js';
import { runLive, parseInput, InvalidInput, SEGMENTS } from '../engine/live-run.js';

export const simulateRouter = Router();

/** Everything the form needs to build itself, so nothing is hardcoded twice. */
simulateRouter.get('/options', (req, res) => {
  const customers = getDb().prepare(`
    SELECT c.id, c.name, c.segment, c.reliability_score, c.preferred_channel, c.salary_day,
           c.opted_out_at, c.disputed_at,
           (SELECT COUNT(*) FROM payment_attempts p
             WHERE p.customer_id = c.id AND p.status = 'failed') AS failed_attempts
    FROM customers c ORDER BY c.name`).all();

  res.json({
    customers,
    segments: SEGMENTS,
    declineCodes: Object.entries(DECLINE_CODES).map(([code, m]) => ({ code, label: m.label })),
    policy: POLICY,
    narrator: { provider: PROVIDER, model: MODEL, configured: credentialsPresent() },
  });
});

/**
 * Run one hand-entered failure. POST, because it carries a body — which rules
 * out EventSource on the client, so the response is a bare text/event-stream
 * the browser reads with fetch.
 */
simulateRouter.post('/stream', async (req, res) => {
  let input;
  try {
    input = parseInput(req.body);
  } catch (err) {
    if (err instanceof InvalidInput) return res.status(400).json({ error: 'invalid_input', message: err.message });
    throw err;
  }

  res.status(200).set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Nginx and most PaaS proxies buffer responses by default, which would hold
    // every stage until the stream closed and defeat the whole thing.
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  /**
   * The client going away mid-run is normal — they pressed the button again —
   * so watch for it and stop generating.
   *
   * This has to be `res`, not `req`: an IncomingMessage emits 'close' as soon as
   * its body has been read, which for a POST is long before the response is
   * finished. Watching the request would abandon the stream on the very first
   * stage and leave the socket hanging open.
   */
  let open = true;
  res.on('close', () => { open = false; });

  // A `false` from res.write() is backpressure, not a disconnection, and these
  // events are a few hundred bytes each — the only reason to stop is `open`.
  const send = (event) => {
    if (!open || res.writableEnded) return false;
    res.write(`data: ${JSON.stringify(event)}\n\n`);
    return true;
  };

  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  try {
    for await (const event of runLive(getDb(), input, { pause })) {
      if (!send(event)) break;
    }
    send({ type: 'done' });
  } catch (err) {
    console.error('live simulation failed', err);
    send({
      type: 'error',
      message: err instanceof InvalidInput ? err.message : 'The simulation failed part-way through.',
      detail: err.message,
    });
  } finally {
    if (!res.writableEnded) res.end();
  }
});
