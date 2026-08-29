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
import '../lib/env.js';
import { getDb } from '../db/index.js';
import {
  makeClient, buildCasePayload, narrateCase, credentialsPresent,
  SYSTEM_PROMPT, userMessage, MODEL, PROVIDER, DEFAULT_CONCURRENCY,
  completionBudget, estimateTokens, shapeOf,
} from '../engine/llm-narrator.js';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const limitArg = args.indexOf('--limit');
const limit = limitArg >= 0 ? Number(args[limitArg + 1]) : null;
const only = args.filter((a) => a.startsWith('case_'));
const CONCURRENCY = Number(process.env.NARRATE_CONCURRENCY) || DEFAULT_CONCURRENCY;
/** Provider tokens-per-minute ceiling. Groq free tier is 8000 at time of writing. */
const TPM = Number(process.env.NARRATE_TPM) || (PROVIDER === 'groq' ? 8000 : 0);

/**
 * Rolling-window token pacer.
 *
 * The limit is per minute, so the only way to run the whole batch unattended is
 * to spend the budget deliberately: track what the last 60 seconds cost, and
 * wait for room before sending rather than firing and handling the rejection.
 */
const spent = [];
async function reserve(tokens) {
  if (!TPM) return null;
  for (;;) {
    const cutoff = Date.now() - 60_000;
    while (spent.length && spent[0].at < cutoff) spent.shift();
    const used = spent.reduce((n, e) => n + e.tokens, 0);
    if (used + tokens <= TPM * 0.92) break;
    const waitMs = Math.max(1000, spent[0].at + 60_000 - Date.now() + 250);
    process.stdout.write('·');
    await new Promise((r) => setTimeout(r, waitMs));
  }
  const entry = { at: Date.now(), tokens };
  spent.push(entry);
  return entry;
}

/**
 * A reservation has to assume the full completion budget, but most cases use a
 * fraction of it. Correcting the entry once the real usage is known stops the
 * window from being held hostage by tokens that were never spent — worth
 * roughly a third of the wall-clock time over a full batch.
 */
function settle(entry, usage) {
  if (!entry) return;
  entry.tokens = Math.max(1, (usage?.input ?? 0) + (usage?.output ?? 0));
}

const db = getDb();

const caseRows = db.prepare(`
  SELECT * FROM recovery_cases
  ${only.length ? `WHERE id IN (${only.map(() => '?').join(',')})` : ''}
  ORDER BY id`).all(...only);
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
  console.log(userMessage(payload));
  console.log(`\n════════ REQUEST ════════`);
  console.log(`provider: ${PROVIDER} · model: ${MODEL} · strict JSON schema`);
  console.log(`cases that would be narrated: ${cases.length}, ${CONCURRENCY} at a time`);
  console.log('\nNo API call was made.\n');
  process.exit(0);
}

if (!credentialsPresent()) {
  const varName = PROVIDER === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'GROQ_API_KEY';
  console.error(`
✗ No ${PROVIDER} credentials found.

  Add your key to .env (it is gitignored, so it never reaches GitHub):
    ${varName}=...

  Groq keys are free at https://console.groq.com/keys

  Inspect the prompt without calling anything:
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

const client = await makeClient();
const stats = { ok: 0, failed: 0, audit: 0, messages: 0, inTok: 0, outTok: 0, cacheRead: 0 };
const failures = [];

/**
 * Free tiers rate limit hard. A 429 is a "come back later", not a failure —
 * back off and retry rather than dropping the case to template text.
 */
async function withRetry(fn, attempts = 4) {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      const status = err?.status ?? err?.response?.status;
      // 413 here is a rate limit dressed as "payload too large" — the request
      // is fine, the minute's token budget is not.
      const retryable = status === 429 || status === 413 || (status >= 500 && status < 600);
      if (!retryable || i >= attempts - 1) throw err;
      const headerWait = Number(err?.headers?.['retry-after']) * 1000;
      const wait = Number.isFinite(headerWait) && headerWait > 0
        ? headerWait
        : Math.min(2 ** i * 1500 + Math.random() * 500, 20000);
      process.stdout.write('~');
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

async function runOne(caseRow) {
  const b = bundle(caseRow);
  try {
    const payload = buildCasePayload(b);
    const cost = estimateTokens(SYSTEM_PROMPT + userMessage(payload))
      + completionBudget(shapeOf(payload));

    const { parsed, usage } = await withRetry(async () => {
      const entry = await reserve(cost);
      try {
        const out = await narrateCase(client, payload);
        settle(entry, out.usage);
        return out;
      } catch (err) {
        settle(entry, { input: cost, output: 0 }); // a rejected call still cost us nothing
        throw err;
      }
    });
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
    stats.inTok += usage.input;
    stats.outTok += usage.output;
    stats.cacheRead += usage.cached;
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

console.log(`\n  Narrating ${cases.length} cases · ${PROVIDER} · ${MODEL} · ${CONCURRENCY} at a time`);
console.log(`  . ok   · waiting for token budget   ~ retrying   x failed (keeps template text)`);
if (TPM) console.log(`  pacing to ${TPM} tokens/min\n`); else console.log('');
const started = Date.now();
await pool(cases, CONCURRENCY, runOne);
const secs = ((Date.now() - started) / 1000).toFixed(1);

console.log(`\n\n  ${stats.ok} cases narrated, ${stats.failed} failed  ·  ${secs}s`);
console.log(`  ${stats.audit} reasoning strings, ${stats.messages} messages rewritten`);
console.log(`  tokens: ${stats.inTok} in${stats.cacheRead ? ` (${stats.cacheRead} from cache)` : ''}, ${stats.outTok} out`);
if (failures.length) {
  console.log('\n  Failures (these cases kept their template text):');
  for (const f of failures.slice(0, 10)) console.log(`    ${f}`);
}
const bySource = db.prepare(
  'SELECT reasoning_source, COUNT(*) n FROM audit_entries GROUP BY reasoning_source').all();
console.log('\n  Audit entries by source:', bySource.map((r) => `${r.reasoning_source}=${r.n}`).join(' '));
console.log('');
