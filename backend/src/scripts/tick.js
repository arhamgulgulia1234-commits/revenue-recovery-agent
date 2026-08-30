/**
 * Run the scheduled check once from a shell.
 *
 *   npm run tick
 *
 * Same code path the server runs on a timer. Handy when the server is not up, or
 * when you want to push a case past its deadline and watch what happens.
 */
import '../lib/env.js';
import { getDb } from '../db/index.js';
import { sweep, due } from '../engine/scheduler.js';
import { anchorPinned } from '../lib/clock.js';

const db = getDb();
const pending = due(db);
const { checked, advanced, errors } = sweep(db);

console.log(`\n  Scheduled check\n`);
console.log(`  Cases due    ${checked}`);
console.log(`  Advanced     ${advanced.length}${advanced.length ? '  ' + advanced.slice(0, 10).join(', ') : ''}`);
if (errors.length) {
  console.log(`  Errors       ${errors.length}`);
  for (const e of errors.slice(0, 5)) console.log(`    ${e.caseId}: ${e.message}`);
}
if (!pending.length && anchorPinned()) {
  console.log('\n  Nothing due. Simulated cases are pinned to SEED_NOW and do not age;');
  console.log('  only cases sent through the real path advance on the wall clock.');
}
console.log('');
process.exit(errors.length ? 1 : 0);
