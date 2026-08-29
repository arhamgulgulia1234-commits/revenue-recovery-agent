import { Router } from 'express';
import { getDb } from '../db/index.js';
import { buildComparison } from '../engine/comparison.js';
import { GENERIC_MESSAGE } from '../engine/baseline.js';

export const comparisonRouter = Router();

comparisonRouter.get('/', (req, res) => {
  res.json({ ...buildComparison(getDb()), genericMessage: GENERIC_MESSAGE });
});
