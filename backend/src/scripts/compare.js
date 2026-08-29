import '../lib/env.js';
import { getDb } from '../db/index.js';
import { buildComparison } from '../engine/comparison.js';

const inr = (n) => '₹' + Math.round(n).toLocaleString('en-IN');
const pct = (n) => (n * 100).toFixed(1) + '%';
const c = buildComparison(getDb());

const row = (label, a, b, better = 'higher') => {
  const delta = typeof a === 'number' && typeof b === 'number'
    ? (better === 'higher' ? a - b : b - a) : null;
  const mark = delta == null ? '' : delta > 0 ? '  ✓' : delta < 0 ? '  ✗' : '  =';
  console.log(`  ${label.padEnd(30)} ${String(fmt(a)).padStart(14)} ${String(fmt(b)).padStart(14)}${mark}`);
};
const fmt = (v) => (v == null ? '—' : v);

console.log(`\n  ══ Decision engine vs naive blind retry ══   same ${c.caseCount} cases, ${inr(c.atRiskInr)} at risk\n`);
console.log(`  ${''.padEnd(30)} ${'OUR ENGINE'.padStart(14)} ${'BASELINE'.padStart(14)}`);
console.log('  ' + '─'.repeat(62));
row('Cases recovered', c.engine.recoveredCases, c.baseline.recoveredCases);
console.log(`  ${'Recovery rate (cases)'.padEnd(30)} ${pct(c.engine.caseRate).padStart(14)} ${pct(c.baseline.caseRate).padStart(14)}`);
console.log(`  ${'Revenue recovered'.padEnd(30)} ${inr(c.engine.recoveredInr).padStart(14)} ${inr(c.baseline.recoveredInr).padStart(14)}`);
console.log(`  ${'Recovery rate (value)'.padEnd(30)} ${pct(c.engine.valueRate).padStart(14)} ${pct(c.baseline.valueRate).padStart(14)}`);
console.log('  ' + '─'.repeat(62));
row('Messages sent to customers', c.engine.totalContacts, c.baseline.totalContacts, 'lower');
row('Customers contacted at all', c.engine.contactedAtAll, c.baseline.contactedAtAll, 'lower');
row('Cases with 3+ messages', c.engine.heavilyContacted, c.baseline.heavilyContacted, 'lower');
console.log('  ' + '─'.repeat(62));
row('Avg attempts to recovery', round1(c.engine.avgAttemptsToRecovery), round1(c.baseline.avgAttemptsToRecovery), 'lower');
row('Avg days to recovery', round1(c.engine.avgDaysToRecovery), round1(c.baseline.avgDaysToRecovery), 'lower');

const lift = c.baseline.caseRate ? (c.engine.caseRate / c.baseline.caseRate) : null;
console.log(`\n  Recovery lift: ${lift ? lift.toFixed(2) + '×' : '—'}   ` +
  `Extra revenue: ${inr(c.engine.recoveredInr - c.baseline.recoveredInr)}   ` +
  `Fewer messages: ${c.baseline.totalContacts - c.engine.totalContacts}`);
console.log(`\n  Baseline config: retry every ${c.config.retryIntervalHours}h, max ${c.config.maxAttempts}, ` +
  `${c.config.channel} only, generic conversion ${c.config.genericConversion}, honours hard stops: ${c.config.honoursHardStops}\n`);

function round1(n) { return n == null ? null : Math.round(n * 10) / 10; }
