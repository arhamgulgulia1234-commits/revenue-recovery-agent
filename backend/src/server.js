import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { getDb, DB_PATH } from './db/index.js';
import { POLICY } from './lib/taxonomy.js';
import { portfolioRouter } from './routes/portfolio.js';

const app = express();
app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => {
  const db = getDb();
  const seeded = db.prepare('SELECT COUNT(*) AS n FROM payment_attempts').get().n;
  res.json({ ok: true, db: DB_PATH, seededFailures: seeded, policy: POLICY });
});

app.use('/api/portfolio', portfolioRouter);

app.use((req, res) => res.status(404).json({ error: 'not_found', path: req.path }));
app.use((err, req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'internal_error', message: err.message });
});

const port = Number(process.env.PORT) || 4000;
app.listen(port, () => {
  console.log(`  API listening on http://localhost:${port}`);
  console.log(`  DB ${DB_PATH}`);
});
