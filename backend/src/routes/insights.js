import { Router } from 'express';
import { getDb } from '../db/index.js';
import { buildPriors } from '../engine/priors.js';
import { attentionList } from '../engine/score-service.js';
import { BLEND_WEIGHTS } from '../engine/scorer.js';

export const insightsRouter = Router();

/** The patterns the scorer is built on, shaped for display. */
insightsRouter.get('/', (req, res) => {
  const db = getDb();
  const priors = buildPriors(db);

  res.json({
    globalRate: priors.globalRate,
    sampleSize: priors.sampleSize,
    settled: priors.settled,
    excluded: priors.excluded,
    smoothing: priors.smoothing,
    weights: BLEND_WEIGHTS,
    byRootCause: toRows(priors.byRootCause),
    bySegment: toRows(priors.bySegment),
    byAttempt: Object.entries(priors.byAttempt).map(([k, v]) => ({
      failedAttempts: Number(k), rate: v.rate, raw: v.raw, n: v.n,
    })),
  });
});

insightsRouter.get('/needs-attention', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 12, 50);
  const maxScore = req.query.maxScore ? Number(req.query.maxScore) : 0.5;
  const rows = attentionList(getDb(), { maxScore });
  res.json({ count: rows.length, cases: rows.slice(0, limit) });
});

const toRows = (obj) =>
  Object.entries(obj)
    .map(([key, v]) => ({ key, rate: v.rate, raw: v.raw, n: v.n }))
    .sort((a, b) => b.rate - a.rate);
