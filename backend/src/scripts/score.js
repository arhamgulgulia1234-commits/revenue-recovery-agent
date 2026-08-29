/**
 * Inspect the recovery-likelihood scorer.
 *
 *   npm run score              # priors, example cases, needs-attention, calibration
 *   npm run score -- case_0010 # one specific case, factor by factor
 */
import 'dotenv/config';
import { getDb } from '../db/index.js';
import { buildPriors, buildCustomerHistory } from '../engine/priors.js';
import { scoreCase, needsAttention, BLEND_WEIGHTS } from '../engine/scorer.js';
import { BUCKETS } from '../engine/classifier.js';

const db = getDb();
const inr = (n) => '₹' + Math.round(n).toLocaleString('en-IN');
const pct = (n) => (n == null ? '   —' : `${(n * 100).toFixed(0)}%`.padStart(4));

const priors = buildPriors(db);
const history = buildCustomerHistory(db);

const cases = db.prepare(`
  SELECT rc.*, c.name AS customer_name, c.segment, c.reliability_score,
         c.opted_out_at, c.disputed_at, p.decline_code
  FROM recovery_cases rc
  JOIN customers c ON c.id = rc.customer_id
  JOIN payment_attempts p ON p.id = rc.payment_attempt_id`).all();

const customers = new Map(db.prepare('SELECT * FROM customers').all().map((c) => [c.id, c]));

const scoreOf = (caseRow, attemptIndex) => ({
  caseRow,
  ...scoreCase({
    caseRow,
    customer: customers.get(caseRow.customer_id),
    priors,
    history: history.get(caseRow.customer_id),
    attemptIndex,
  }),
});

// ---------------------------------------------------------------------------
const target = process.argv[2];
if (target) {
  const c = cases.find((x) => x.id === target);
  if (!c) { console.log(`no such case: ${target}`); process.exit(1); }
  detail(scoreOf(c));
  process.exit(0);
}

// -- Priors ------------------------------------------------------------------
console.log(`\n  ══ Priors learned from the batch ══`);
console.log(`  ${priors.sampleSize} actionable cases (${priors.settled} settled, ${priors.sampleSize - priors.settled} still open)`);
console.log(`  Global recovery rate ${pct(priors.globalRate)} · ${priors.excluded} excluded (agent was never allowed to act)`);
console.log(`  Smoothing: each bucket gets ${priors.smoothing} pseudo-observations at the global rate\n`);

console.log('  Recovery rate by root cause          raw     smoothed    n');
for (const [k, v] of Object.entries(priors.byRootCause).sort((a, b) => b[1].rate - a[1].rate)) {
  console.log(`    ${(BUCKETS[k]?.label ?? k).padEnd(24)} ${pct(v.raw)}      ${pct(v.rate)}    ${String(v.n).padStart(3)}`);
}
console.log('\n  Recovery rate by segment             raw     smoothed    n');
for (const [k, v] of Object.entries(priors.bySegment).sort((a, b) => b[1].rate - a[1].rate)) {
  console.log(`    ${k.padEnd(24)} ${pct(v.raw)}      ${pct(v.rate)}    ${String(v.n).padStart(3)}`);
}
console.log('\n  Recovery rate by attempts already failed');
for (const [k, v] of Object.entries(priors.byAttempt)) {
  console.log(`    after ${k} failed attempt${k === '0' ? ' ' : 's'}         ${pct(v.raw)}      ${pct(v.rate)}    ${String(v.n).padStart(3)}`);
}

console.log(`\n  Base blend weights: root cause ${BLEND_WEIGHTS.rootCause} · attempts ${BLEND_WEIGHTS.attempt} · segment ${BLEND_WEIGHTS.segment}`);

// -- Examples ----------------------------------------------------------------
const scored = cases.map((c) => scoreOf(c));
const pick = (fn) => scored.find(fn);

console.log('\n\n  ══ Example scores ══');
const examples = [
  ['Highest scoring open case', [...scored].filter((s) => s.caseRow.status === 'in_progress').sort((a, b) => b.score - a.score)[0]],
  ['Lowest scoring case still open', [...scored].filter((s) => s.caseRow.status === 'in_progress').sort((a, b) => a.score - b.score)[0]],
  ['Third attempt already failed', pick((s) => s.caseRow.attempts_used === 3 && s.score > 0)],
  ['Hard-stopped customer', pick((s) => s.factors.some((f) => f.kind === 'override'))],
  ['Big-ticket receivable', [...scored].filter((s) => s.caseRow.root_cause === 'receivable' && s.score > 0).sort((a, b) => b.caseRow.amount_at_risk_inr - a.caseRow.amount_at_risk_inr)[0]],
];
for (const [label, s] of examples) {
  if (!s) continue;
  console.log(`\n  ── ${label} ──`);
  detail(s);
}

// -- Needs attention ---------------------------------------------------------
const attention = needsAttention(scored);

console.log('\n\n  ══ Needs attention ══');
console.log('  Unrecovered cases ranked by expected loss (amount × chance we lose it).');
console.log('  Includes cases the agent stopped at the cap — that hand-off is the point.\n');
console.log(`  ${'case'.padEnd(11)} ${'customer'.padEnd(28)} ${'at risk'.padStart(11)}  score  ${'exp. loss'.padStart(11)}  why it is here`);
for (const s of attention.slice(0, 8)) {
  const why = s.caseRow.status === 'stopped'
    ? (s.caseRow.closure_reason === 'max_attempts_reached' ? 'agent hit the cap' : s.caseRow.closure_reason)
    : `still running, ${s.caseRow.attempts_used}/3 used`;
  console.log(`  ${s.caseRow.id.padEnd(11)} ${s.caseRow.customer_name.slice(0, 27).padEnd(28)} ${inr(s.caseRow.amount_at_risk_inr).padStart(11)}  ${pct(s.score)}  ${inr(s.expectedLoss).padStart(11)}  ${why}`);
}
if (!attention.length) console.log('  (none)');

// -- Calibration -------------------------------------------------------------
// Score every actionable case as of the moment it opened, then check whether the
// cases we scored high actually recovered more often than the ones we scored low.
//
// "Actionable" and "recovered" use the same convention as the priors: every case
// the agent was allowed to work, with in-progress counting as not recovered.
// Scoring only settled cases would compare against a population that recovers
// 67% while the priors are built on one that recovers 53%, and the scorer would
// look badly under-confident for no reason but the mismatched denominator.
const atOpen = scored
  .filter((s) => !s.factors.some((f) => f.kind === 'override'))
  .map((s) => scoreOf(s.caseRow, 0));

const won = (s) => s.caseRow.status === 'recovered';

console.log('\n\n  ══ Calibration (predicted at open vs actual) ══');
console.log('  In-sample: the priors were learned from these same cases, so read this as a');
console.log('  monotonicity check — do higher-scored cases actually recover more often?\n');
console.log(`  ${'predicted'.padEnd(14)} ${'n'.padStart(4)}  ${'actual'.padStart(7)}`);
const bins = [[0, 0.4], [0.4, 0.5], [0.5, 0.6], [0.6, 1.01]];
for (const [lo, hi] of bins) {
  const inBin = atOpen.filter((s) => s.score >= lo && s.score < hi);
  if (!inBin.length) continue;
  const actual = inBin.filter(won).length / inBin.length;
  console.log(`  ${`${(lo * 100).toFixed(0)}–${(hi * 100).toFixed(0)}%`.padEnd(14)} ${String(inBin.length).padStart(4)}  ${pct(actual)}   ${'█'.repeat(Math.round(actual * 30))}`);
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
const recScores = atOpen.filter(won).map((s) => s.score);
const lostScores = atOpen.filter((s) => !won(s)).map((s) => s.score);
console.log(`\n  Mean score, cases that recovered      ${pct(mean(recScores))}  (n=${recScores.length})`);
console.log(`  Mean score, cases that did not        ${pct(mean(lostScores))}  (n=${lostScores.length})`);
console.log(`  Separation                            ${((mean(recScores) - mean(lostScores)) * 100).toFixed(1)} points`);
console.log(`  Overall predicted ${pct(mean(atOpen.map((s) => s.score)))} vs actual ${pct(atOpen.filter(won).length / atOpen.length)}\n`);

// ---------------------------------------------------------------------------
function detail(s) {
  const c = s.caseRow;
  console.log(`\n  ${c.id}  ${c.customer_name}  (${c.segment})`);
  console.log(`  ${c.decline_code} → ${BUCKETS[c.root_cause]?.label} · ${inr(c.amount_at_risk_inr)} · ${c.attempts_used}/3 attempts · ${c.status}`);
  console.log(`\n  SCORE  ${(s.score * 100).toFixed(0)}%  (${s.band.label})\n`);

  for (const f of s.factors) {
    if (f.kind === 'base') {
      console.log(`    base   ${f.name.padEnd(11)} ${pct(f.rate)} × ${f.weight}  = ${(f.value * 100).toFixed(1).padStart(5)}pts   ${f.detail}`);
    } else if (f.kind === 'modifier') {
      const sign = f.delta > 0 ? '+' : '';
      console.log(`    mod    ${f.name.padEnd(11)} ×${f.factor.toFixed(3)}       ${sign}${(f.delta * 100).toFixed(1).padStart(5)}pts   ${f.detail}`);
    } else {
      console.log(`    OVERRIDE  ${f.detail}`);
    }
  }
  console.log(`\n  "${s.explanation}"`);
}
