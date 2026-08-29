/**
 * Replay committed narration over a freshly seeded database.
 *
 * Safe to run when the file is absent — it exits quietly, leaving template text,
 * which is exactly the behaviour a deploy without narration should have.
 *
 *   npm run narrate:apply
 */
import '../lib/env.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb } from '../db/index.js';

const FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'narration.json');

if (!fs.existsSync(FILE)) {
  console.log('  No narration.json — leaving template reasoning in place.');
  process.exit(0);
}

const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const db = getDb();

const seed = Number(process.env.SEED) || 20260829;
const seedNow = process.env.SEED_NOW ?? null;
if (data.seed !== seed || data.seedNow !== seedNow) {
  // Case ids are only stable while the anchors are. Applying prose keyed to a
  // different dataset would attach the wrong story to the wrong case, which is
  // worse than having no narration at all.
  console.warn(
    `  ✗ narration.json was built for SEED=${data.seed} SEED_NOW=${data.seedNow},\n` +
    `    but this run is SEED=${seed} SEED_NOW=${seedNow}. Skipping to avoid\n` +
    `    attaching narration to the wrong cases. Re-run \`npm run narrate\` and\n` +
    `    \`npm run narrate:export\` to refresh it.`);
  process.exit(0);
}

const setAudit = db.prepare(
  `UPDATE audit_entries SET reasoning_text = ?, reasoning_source = 'llm'
    WHERE case_id = ? AND sequence = ?`);
const setMessage = db.prepare(
  'UPDATE intervention_logs SET message_sent = ? WHERE case_id = ? AND sequence = ?');

let audit = 0;
let messages = 0;
db.transaction(() => {
  for (const [caseId, seq, text] of data.audit) audit += setAudit.run(text, caseId, seq).changes;
  for (const [caseId, seq, text] of data.messages) messages += setMessage.run(text, caseId, seq).changes;
})();

console.log(`  ✓ Applied ${audit} reasoning strings and ${messages} messages ` +
  `(${data.provider} · ${data.model})`);
