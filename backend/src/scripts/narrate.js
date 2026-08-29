/**
 * Re-narrate every case with Claude.
 *
 *   npm run narrate                 # all cases
 *   npm run narrate -- --dry-run    # print the exact prompt for one case, call nothing
 *   npm run narrate -- --limit 5    # first 5 cases only, for a cheap quality check
 *   npm run narrate -- case_0010    # one specific case
 *
 * Safe to re-run: it overwrites reasoning text and message copy in place and
 * flips reasoning_source to 'llm'. Any case that fails keeps its template text,
 * so a partial run degrades instead of breaking.
 */
import 'dotenv/config';
import { getDb } from '../db/index.js';
import {
  makeClient, buildCasePayload, narrateCase, SYSTEM_PROMPT, MODEL,
} from '../engine/llm-narrator.js';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const limitArg = args.indexOf('--limit');
const limit = limitArg >= 0 ? Number(args[limitArg + 1]) : null;
const only = args.find((a) => a.startsWith('case_'));
const CONCURRENCY = Number(process.env.NARRATE_CONCURRENCY) || 6;

const db = getDb();

const caseRows = db.prepare(`
  SELECT * FROM recovery_cases ${only ? 'WHERE id = ?' : ''} ORDER BY id`).all(...(only ? [only] : []));
const cases = limit ? caseRows.slice(0, limit) : caseRows;

if (!cases.length) {
  console.error('✗ No cases found. Run `npm run demo` first.');
  process.exit(1);
}

const get = {
  customer: db.prepare('SELECT * FROM customers WHERE id = ?'),
  attempt: db.prepare('SELECT * FROM payment_attempts WHERE id = ?'),
  sub: db.prepare('SELECT * FROM subscriptions WHERE id = ?'),
  inv: db.prepare('SELECT * FROM invoices WHERE id = ?'),
  audit: db.prepare('SELECT * FROM audit_entries WHERE case_id = ? ORDER BY sequence'),
  logs: db.prepare('SELECT * FROM intervention_logs WHERE case_id = ? ORDER BY sequence'),
};

function bundle(caseRow) {
  const attempt = get.attempt.get(caseRow.payment_attempt_id);
  return {
    caseRow,
    customer: get.customer.get(caseRow.customer_id),
    attempt,
    subscription: attempt.subscription_id ? get.sub.get(attempt.subscription_id) : null,
    invoice: attempt.invoice_id ? get.inv.get(attempt.invoice_id) : null,
    audit: get.audit.all(caseRow.id),
    interventions: get.logs.all(caseRow.id),
  };
}

// -- Dry run: show exactly what Claude would receive -------------------------
if (dryRun) {
  const payload = buildCasePayload(bundle(cases[0]));
  console.log('\n════════ SYSTEM PROMPT (cached across calls) ════════\n');
  console.log(SYSTEM_PROMPT);
  console.log('\n════════ USER MESSAGE ════════\n');
  console.log('Explain every decision on this recovery case, and write the outreach copy.\n');
  console.log('```json');
  console.log(JSON.stringify(payload, null, 2));
  console.log('```');
  console.log(`\n════════ REQUEST ════════`);
  console.log(`model: ${MODEL} · thinking: adaptive · structured output (zod schema)`);
  console.log(`cases that would be narrated: ${cases.length}, ${CONCURRENCY} at a time`);
  console.log('\nNo API call was made.\n');
  process.exit(0);
}

if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
  console.error(`
✗ No Anthropic credentials found.

  Set one of these and re-run:
    export ANTHROPIC_API_KEY=sk-ant-...
    echo "ANTHROPIC_API_KEY=sk-ant-..." >> .env

  Or run \`ant auth login\` if you use the Anthropic CLI.

  Inspect the prompt without calling the API:
    npm run narrate -- --dry-run
`);
  process.exit(1);
}

// -- Apply --------------------------------------------------------------------
const updateAudit = db.prepare(
  `UPDATE audit_entries SET reasoning_text = ?, reasoning_source = 'llm'
    WHERE case_id = ? AND sequence = ?`);
const updateLog = db.prepare(
  `UPDATE intervention_logs SET message_sent = ? WHERE case_id = ? AND sequence = ?`);

const client = makeClient();
const stats = { ok: 0, failed: 0, audit: 0, messages: 0, inTok: 0, outTok: 0, cacheRead: 0 };
const failures = [];

async function runOne(caseRow) {
  const b = bundle(caseRow);
  try {
    const { parsed, usage } = await narrateCase(client, buildCasePayload(b));
    if (!parsed) throw new Error('structured output did not parse');

    const apply = db.transaction(() => {
      for (const a of parsed.audit) {
        if (a.reasoning?.trim()) {
          updateAudit.run(a.reasoning.trim(), caseRow.id, a.sequence);
          stats.audit++;
        }
      }
      for (const m of parsed.messages) {
        const text = m.subject?.trim() ? `Subject: ${m.subject.trim()}\n\n${m.body}` : m.body;
        if (text?.trim()) {
          updateLog.run(text.trim(), caseRow.id, m.sequence);
          stats.messages++;
        }
      }
    });
    apply();

    stats.ok++;
    stats.inTok += usage.input_tokens ?? 0;
    stats.outTok += usage.output_tokens ?? 0;
    stats.cacheRead += usage.cache_read_input_tokens ?? 0;
    process.stdout.write('.');
  } catch (err) {
    // Keep the template text for this case rather than losing it.
    stats.failed++;
    failures.push(`${caseRow.id}: ${err.message}`);
    process.stdout.write('x');
  }
}

/** Fixed-size worker pool. */
async function pool(items, size, fn) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(size, queue.length) }, async () => {
      while (queue.length) await fn(queue.shift());
    }),
  );
}

console.log(`\n  Narrating ${cases.length} cases with ${MODEL} (${CONCURRENCY} at a time)\n`);
const started = Date.now();
await pool(cases, CONCURRENCY, runOne);
const secs = ((Date.now() - started) / 1000).toFixed(1);

console.log(`\n\n  ${stats.ok} cases narrated, ${stats.failed} failed  ·  ${secs}s`);
console.log(`  ${stats.audit} reasoning strings, ${stats.messages} messages rewritten`);
console.log(`  tokens: ${stats.inTok} in (${stats.cacheRead} from cache), ${stats.outTok} out`);
if (failures.length) {
  console.log('\n  Failures (these cases kept their template text):');
  for (const f of failures.slice(0, 10)) console.log(`    ${f}`);
}
const bySource = db.prepare(
  'SELECT reasoning_source, COUNT(*) n FROM audit_entries GROUP BY reasoning_source').all();
console.log('\n  Audit entries by source:', bySource.map((r) => `${r.reasoning_source}=${r.n}`).join(' '));
console.log('');
