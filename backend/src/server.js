import './lib/env.js';
import express from 'express';
import cors from 'cors';
import { getDb, DB_PATH } from './db/index.js';
import { POLICY } from './lib/taxonomy.js';
import { portfolioRouter } from './routes/portfolio.js';
import { casesRouter } from './routes/cases.js';
import { insightsRouter } from './routes/insights.js';
import { comparisonRouter } from './routes/comparison.js';
import { simulateRouter } from './routes/simulate.js';
import { schedulerRouter } from './routes/scheduler.js';
import { liveRouter } from './routes/live.js';
import { startScheduler } from './engine/scheduler.js';
import { anchorPinned } from './lib/clock.js';
import { configSummary as razorpayConfig } from './lib/razorpay.js';

const app = express();

/**
 * In development anything on localhost may call the API. In production only the
 * deployed frontend may — ALLOWED_ORIGINS is a comma-separated list. Leaving
 * cors() wide open on a public URL would let any site call this API and read the
 * data back, which is not something to ship by accident.
 */
const allowed = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);              // curl, server-side fetch, health checks
    if (!allowed.length) return cb(null, true);      // unset: local dev
    if (allowed.includes(origin)) return cb(null, true);
    // Vercel gives every preview deploy its own subdomain; allow them when the
    // production domain is already trusted.
    if (allowed.some((a) => a.endsWith('.vercel.app')) && /^https:\/\/[\w-]+\.vercel\.app$/.test(origin)) {
      return cb(null, true);
    }
    return cb(new Error(`Origin not allowed: ${origin}`));
  },
}));
app.use(express.json());

app.get('/health', (req, res) => {
  const db = getDb();
  const seeded = db.prepare('SELECT COUNT(*) AS n FROM payment_attempts').get().n;
  res.json({
    ok: true, db: DB_PATH, seededFailures: seeded, policy: POLICY,
    razorpay: razorpayConfig(),
  });
});

app.use('/api/portfolio', portfolioRouter);
app.use('/api/cases', casesRouter);
app.use('/api/insights', insightsRouter);
app.use('/api/comparison', comparisonRouter);
app.use('/api/simulate', simulateRouter);
app.use('/api/scheduler', schedulerRouter);
app.use('/api/live', liveRouter);

app.use((req, res) => res.status(404).json({ error: 'not_found', path: req.path }));
app.use((err, req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'internal_error', message: err.message });
});

// Render (and most PaaS) inject PORT and require binding on 0.0.0.0.
const port = Number(process.env.PORT) || 4000;
app.listen(port, '0.0.0.0', () => {
  console.log(`  API listening on port ${port}`);
  console.log(`  DB ${DB_PATH}`);
  console.log(`  CORS: ${allowed.length ? allowed.join(', ') : 'open (development)'}`);

  /**
   * Cases wait on real deadlines now, so something has to come back and look at
   * them when those deadlines pass. This is that something.
   *
   * Simulated cases are judged against the pinned SEED_NOW and therefore never
   * come due — a server left running overnight cannot walk the demo book forward
   * and move the numbers on the dashboard. Live cases run on the wall clock,
   * which is the only clock a real customer is on.
   */
  const interval = Number(process.env.SCHEDULER_INTERVAL_MS) || 60000;
  startScheduler(getDb(), { intervalMs: interval });
  console.log(`  Scheduler: every ${Math.round(interval / 1000)}s` +
    (anchorPinned() ? ' (simulated cases pinned to SEED_NOW)' : ''));
});
